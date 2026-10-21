import { getSupabaseClient } from './client';

// Read-only view of the append-only audit_log (migration 0009; written only by the audit_row_change trigger).
// RLS lets only a member with VIEW_AUDIT_LOG (the owner) read it. Nothing here writes.
// Only the events below are listed: the table also holds every stock movement and bill item insert, which
// would bury what an owner looks for.

export type AuditType =
  | 'sale_void'
  | 'purchase_void'
  | 'bill_edit'
  | 'credit_override'
  | 'payment_void'
  | 'price_change'
  | 'item_change'
  | 'customer_change'
  | 'team_change';

export const AUDIT_TYPE_LABEL: Record<AuditType, string> = {
  sale_void: 'Sale voids',
  purchase_void: 'Purchase voids (a bill edit also lists its void)',
  bill_edit: 'Purchase bill edits',
  credit_override: 'Credit-limit overrides',
  payment_void: 'Payment voids',
  price_change: 'Sale price changes',
  item_change: 'Item changes (tax, name, archive)',
  customer_change: 'Customer changes (credit limit)',
  team_change: 'Team changes',
};
export const AUDIT_TYPES = Object.keys(AUDIT_TYPE_LABEL) as AuditType[];

// PostgREST and(...) clause per type. A void/edit is the transition (before differs from after), so a later
// harmless update of an already voided row is not listed again.
const CLAUSE: Record<AuditType, string> = {
  sale_void:
    'and(table_name.eq.sale_invoices,action.eq.UPDATE,after->>status.eq.VOID,before->>status.neq.VOID)',
  purchase_void:
    'and(table_name.eq.purchase_bills,action.eq.UPDATE,after->>status.eq.VOID,before->>status.neq.VOID)',
  bill_edit:
    'and(table_name.eq.purchase_bills,action.eq.UPDATE,after->>replaced_by_id.not.is.null,before->>replaced_by_id.is.null)',
  credit_override:
    'and(table_name.eq.sale_invoices,action.eq.INSERT,after->>credit_override_by.not.is.null)',
  payment_void:
    'and(table_name.eq.payments,action.eq.UPDATE,after->>status.eq.VOID,before->>status.neq.VOID)',
  price_change: 'and(table_name.eq.item_prices,or(action.eq.INSERT,action.eq.UPDATE))',
  item_change: 'and(table_name.eq.items,action.eq.UPDATE)',
  customer_change: 'and(table_name.eq.customers,action.eq.UPDATE)',
  team_change: 'table_name.eq.tenant_users',
};

export function auditFilter(types: AuditType[]): string {
  return (types.length ? types : AUDIT_TYPES).map((t) => CLAUSE[t]).join(',');
}

export type AuditEvent = {
  id: string;
  createdAt: string;
  userId: string | null;
  tableName: string;
  rowId: string;
  action: 'INSERT' | 'UPDATE' | 'DELETE';
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** Item names for item_prices rows on this page (item_id -> name). */
  itemNames: Record<string, string>;
};

export type AuditQuery = {
  type?: AuditType | '';
  userId?: string;
  /** Local calendar dates (YYYY-MM-DD), inclusive. */
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
};

export const AUDIT_PAGE_SIZE = 50;

function localDayStart(date: string, addDays = 0): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, m! - 1, d! + addDays).toISOString();
}

export async function listAuditEvents(
  q: AuditQuery = {},
): Promise<{ rows: AuditEvent[]; hasMore: boolean }> {
  const size = q.pageSize ?? AUDIT_PAGE_SIZE;
  const page = Math.max(0, q.page ?? 0);
  const sb = getSupabaseClient();
  let query = sb
    .from('audit_log')
    .select('id,created_at,user_id,table_name,row_id,action,before,after')
    .or(auditFilter(q.type ? [q.type] : []))
    .order('created_at', { ascending: false })
    .order('id', { ascending: false });
  if (q.userId) query = query.eq('user_id', q.userId);
  if (q.from) query = query.gte('created_at', localDayStart(q.from));
  if (q.to) query = query.lt('created_at', localDayStart(q.to, 1));
  // One extra row tells whether another page exists.
  const { data, error } = await query.range(page * size, page * size + size);
  if (error) throw error;
  const all = (data ?? []) as unknown as {
    id: string;
    created_at: string;
    user_id: string | null;
    table_name: string;
    row_id: string;
    action: 'INSERT' | 'UPDATE' | 'DELETE';
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  }[];
  const hasMore = all.length > size;
  const pageRows = all.slice(0, size);
  const itemIds = [
    ...new Set(
      pageRows
        .filter((r) => r.table_name === 'item_prices')
        .map((r) => (r.after ?? r.before)?.item_id)
        .filter((v): v is string => typeof v === 'string'),
    ),
  ];
  const itemNames: Record<string, string> = {};
  if (itemIds.length) {
    // Names are a convenience; a failed lookup leaves the id-less label, never hides the events.
    const named = await sb.from('items').select('id,name').in('id', itemIds);
    for (const r of (named.data ?? []) as { id: string; name: string }[]) itemNames[r.id] = r.name;
  }
  return {
    hasMore,
    rows: pageRows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      userId: r.user_id,
      tableName: r.table_name,
      rowId: r.row_id,
      action: r.action,
      before: r.before,
      after: r.after,
      itemNames,
    })),
  };
}
