import { getSupabaseClient } from './client';

// Read-only view of the append-only audit_log (migration 0009; written only by the audit_row_change trigger),
// read through audit_feed (0070), which adds the pending-remark history (document_remark_events). RLS lets only
// a member with VIEW_AUDIT_LOG (the owner, and the manager from 0070) read either. Nothing here writes.
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
  | 'team_change'
  | 'price_override'
  | 'remark';

export const AUDIT_TYPE_LABEL: Record<AuditType, string> = {
  sale_void: 'Sale voids',
  purchase_void: 'Purchase voids (including the void made by a bill edit)',
  bill_edit: 'Purchase bill edits',
  credit_override: 'Credit-limit overrides',
  payment_void: 'Payment voids',
  price_change: 'Sale price changes',
  item_change: 'Item changes (tax, name, archive)',
  customer_change: 'Customer changes (credit limit)',
  team_change: 'Team changes',
  price_override: 'Typed sale prices (including items not in the list)',
  remark: 'Pending remarks (added, edited, settled, reopened)',
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
  price_override:
    'and(table_name.eq.sale_invoice_items,action.eq.INSERT,after->>price_source.eq.manual)',
  remark: 'table_name.eq.document_remark_events',
};
/** Types that exist only in audit_feed (0070); before it is live they are left out. */
const FEED_ONLY: AuditType[] = ['remark'];

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
  /**
   * Document labels for typed-price lines and remarks on this page: sale invoice id -> doc no, purchase bill
   * id -> "bill no." (a convenience; a failed lookup leaves the plain wording).
   */
  docLabels: Record<string, string>;
  /**
   * For a purchase bill void: true when the bill was replaced by a corrected bill (0066), i.e. this void is the
   * one a bill edit made, not a separate void. A bill voided on its own can never be edited afterwards, so a
   * set replaced_by_id is exact. False when not a purchase void or when the link could not be read.
   */
  voidByEdit: boolean;
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
  const run = (source: 'audit_feed' | 'audit_log') => {
    const types = q.type
      ? [q.type]
      : source === 'audit_feed'
        ? AUDIT_TYPES
        : AUDIT_TYPES.filter((t) => !FEED_ONLY.includes(t));
    let query = sb
      .from(source as 'audit_log') // same columns; the view is typed separately
      .select('id,created_at,user_id,table_name,row_id,action,before,after')
      .or(auditFilter(types))
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });
    if (q.userId) query = query.eq('user_id', q.userId);
    if (q.from) query = query.gte('created_at', localDayStart(q.from));
    if (q.to) query = query.lt('created_at', localDayStart(q.to, 1));
    // One extra row tells whether another page exists.
    return query.range(page * size, page * size + size);
  };
  let { data, error } = await run('audit_feed');
  // Before 0070 is live the feed does not exist: the plain audit log still answers (no remark history).
  if (error && (error.code === 'PGRST205' || error.code === '42P01')) {
    if (q.type && FEED_ONLY.includes(q.type)) return { hasMore: false, rows: [] };
    ({ data, error } = await run('audit_log'));
  }
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
  // Purchase voids on this page that a bill edit made (the bill now has replaced_by_id). A failed or
  // pre-0066 read leaves them as plain voids, never hides them.
  const voidBillIds = [
    ...new Set(
      pageRows
        .filter(
          (r) =>
            r.table_name === 'purchase_bills' &&
            r.action === 'UPDATE' &&
            r.after?.status === 'VOID' &&
            r.before?.status !== 'VOID',
        )
        .map((r) => r.row_id),
    ),
  ];
  // Invoice / bill labels for typed-price lines and remarks (names only; a failed read hides nothing).
  const saleIds = new Set<string>();
  const billIds = new Set<string>();
  for (const r of pageRows) {
    const a = r.after ?? {};
    if (typeof a.sale_invoice_id === 'string') saleIds.add(a.sale_invoice_id);
    if (typeof a.purchase_bill_id === 'string') billIds.add(a.purchase_bill_id);
  }
  const docLabels: Record<string, string> = {};
  try {
    if (saleIds.size) {
      const got = await sb
        .from('sale_invoices')
        .select('id,doc_no')
        .in('id', [...saleIds]);
      for (const r of (got.data ?? []) as { id: string; doc_no: string }[])
        docLabels[r.id] = `sale ${r.doc_no}`;
    }
    if (billIds.size) {
      const got = await sb
        .from('purchase_bills')
        .select('id,bill_no')
        .in('id', [...billIds]);
      for (const r of (got.data ?? []) as { id: string; bill_no: string | null }[])
        docLabels[r.id] = r.bill_no ? `purchase bill ${r.bill_no}` : 'a purchase bill';
    }
  } catch {
    /* labels only */
  }
  const replaced = new Set<string>();
  if (voidBillIds.length) {
    try {
      const links = await sb
        .from('purchase_bills')
        .select('id,replaced_by_id')
        .in('id', voidBillIds);
      for (const r of (links.data ?? []) as { id: string; replaced_by_id: string | null }[])
        if (r.replaced_by_id) replaced.add(r.id);
    } catch {
      /* labels only */
    }
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
      docLabels,
      voidByEdit:
        r.table_name === 'purchase_bills' &&
        r.action === 'UPDATE' &&
        r.after?.status === 'VOID' &&
        r.before?.status !== 'VOID' &&
        replaced.has(r.row_id),
    })),
  };
}
