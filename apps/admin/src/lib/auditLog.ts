import type { AuditEvent, AuditType } from '@dsb-pro/adapters';
import { rupees } from './money';

// Plain-language line for one audit_log row. Returns text only (the screen renders it escaped); values come
// from the stored before/after row images, never recomputed.

type Row = Record<string, unknown> | null;

const SKIP = new Set([
  'updated_at',
  'created_at',
  'created_by',
  'client_id',
  'normalized_name',
  'tenant_id',
  'shop_id',
  'id',
]);

function text(v: unknown): string {
  if (v === null || v === undefined || v === '') return 'none';
  return String(v);
}
function field(key: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return 'none';
  if (key.endsWith('_paise') && /^-?\d+$/.test(String(v))) return rupees(String(v));
  if (key === 'tax_rate_bp' && typeof v === 'number') return `${v / 100}%`;
  if (key === 'deleted_at') return 'archived';
  return String(v);
}
const FIELD_NAME: Record<string, string> = {
  credit_limit_paise: 'credit limit',
  sale_credit_limit_paise: 'sale credit limit',
  tax_rate_bp: 'GST rate',
  deleted_at: 'archived',
  name: 'name',
  phone: 'phone',
  role: 'role',
  status: 'status',
  gstin: 'GSTIN',
};

// "credit limit ₹5,000.00 → ₹8,000.00, name A → B" for the keys that differ.
export function changedFields(before: Row, after: Row, max = 4): string {
  if (!before || !after) return '';
  const keys = Object.keys(after).filter(
    (k) => !SKIP.has(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  );
  const shown = keys
    .slice(0, max)
    .map(
      (k) =>
        `${FIELD_NAME[k] ?? k.replace(/_/g, ' ')} ${field(k, before[k])} → ${field(k, after[k])}`,
    );
  if (keys.length > max) shown.push(`and ${keys.length - max} more`);
  return shown.join(', ');
}

export function auditType(
  e: Pick<AuditEvent, 'tableName' | 'action' | 'before' | 'after'>,
): AuditType | null {
  const { tableName: t, action, before, after } = e;
  if (t === 'sale_invoices')
    return action === 'UPDATE' && after?.status === 'VOID' && before?.status !== 'VOID'
      ? 'sale_void'
      : action === 'INSERT' && after?.credit_override_by
        ? 'credit_override'
        : null;
  if (t === 'purchase_bills') {
    if (action !== 'UPDATE') return null;
    if (after?.replaced_by_id && !before?.replaced_by_id) return 'bill_edit';
    return after?.status === 'VOID' && before?.status !== 'VOID' ? 'purchase_void' : null;
  }
  if (t === 'payments')
    return action === 'UPDATE' && after?.status === 'VOID' && before?.status !== 'VOID'
      ? 'payment_void'
      : null;
  if (t === 'item_prices') return 'price_change';
  if (t === 'items') return 'item_change';
  if (t === 'customers') return 'customer_change';
  if (t === 'tenant_users') return 'team_change';
  if (t === 'sale_invoice_items')
    return action === 'INSERT' && after?.price_source === 'manual' ? 'price_override' : null;
  if (t === 'document_remark_events') return 'remark';
  return null;
}

export function describeAudit(e: AuditEvent, who: (userId: string | null) => string): string {
  const a = e.after ?? e.before ?? {};
  const type = auditType(e);
  switch (type) {
    case 'sale_void':
      return `Sale ${text(a.doc_no)} voided (${rupees(String(a.total_paise ?? 0))}).`;
    case 'purchase_void':
      return e.voidByEdit
        ? `Purchase bill ${text(a.bill_no)} (${rupees(String(a.total_paise ?? 0))}) voided by a bill edit: part of the edit listed with it, not a separate void.`
        : `Purchase bill ${text(a.bill_no)} voided (${rupees(String(a.total_paise ?? 0))}).`;
    case 'bill_edit':
      return `Purchase bill ${text(a.bill_no)} (${rupees(String(a.total_paise ?? 0))}) replaced by a corrected bill (the edit also voided it; that void is labelled "voided by a bill edit").`;
    case 'credit_override':
      return `Sale ${text(a.doc_no)} (${rupees(String(a.total_paise ?? 0))}) went over the credit limit and was allowed by ${who(
        typeof a.credit_override_by === 'string' ? a.credit_override_by : null,
      )}. Limit ${a.credit_limit_snapshot_paise == null ? 'unknown' : rupees(String(a.credit_limit_snapshot_paise))}, owed before ${
        a.credit_outstanding_snapshot_paise == null
          ? 'unknown'
          : rupees(String(a.credit_outstanding_snapshot_paise))
      }.`;
    case 'payment_void':
      return `Payment of ${rupees(String(a.amount_paise ?? 0))} (${text(a.mode)}) voided.`;
    case 'price_change': {
      const name = e.itemNames[String(a.item_id)] ?? 'An item';
      const was =
        e.action === 'UPDATE' && e.before?.price_paise != null
          ? ` (was ${rupees(String(e.before.price_paise))})`
          : '';
      return `${name}: ${text(a.kind)} price set to ${rupees(String(a.price_paise ?? 0))} for unit ${text(a.unit_level)}${was}.`;
    }
    case 'item_change': {
      const diff = changedFields(e.before, e.after);
      return `Item ${text(a.name)} changed${diff ? `: ${diff}` : ''}.`;
    }
    case 'customer_change': {
      const diff = changedFields(e.before, e.after);
      return `Customer ${text(a.name)} changed${diff ? `: ${diff}` : ''}.`;
    }
    case 'team_change': {
      const member = who(typeof a.user_id === 'string' ? a.user_id : null);
      if (e.action === 'INSERT') return `${member} joined as ${text(a.role)}.`;
      if (e.action === 'DELETE') return `${member} removed from the team.`;
      const diff = changedFields(e.before, e.after);
      return `${member}${diff ? `: ${diff}` : ' changed'}.`;
    }
    case 'price_override': {
      const doc = e.docLabels[String(a.sale_invoice_id)] ?? 'a sale';
      const by = who(typeof a.overridden_by === 'string' ? a.overridden_by : null);
      const each = `${text(a.qty)} × ${rupees(String(a.unit_price_paise ?? 0))}`;
      if (a.line_kind === 'free_text')
        return `Item not in the list "${text(a.item_name_snapshot)}" sold on ${doc}: ${each}, GST ${
          Number(a.tax_rate_bp_snapshot ?? 0) / 100
        }%, typed by ${by}.`;
      const list =
        a.list_price_snapshot_paise == null
          ? 'no list price'
          : `list ${rupees(String(a.list_price_snapshot_paise))}`;
      return `${text(a.item_name_snapshot)} sold at a typed price on ${doc}: ${each} (${list}), typed by ${by}.`;
    }
    case 'remark': {
      const doc =
        e.docLabels[String(a.sale_invoice_id ?? a.purchase_bill_id)] ??
        (a.doc_kind === 'purchase' ? 'a purchase bill' : 'a sale');
      const did: Record<string, string> = {
        ADD: 'added',
        EDIT: 'edited',
        SETTLE: 'settled',
        REOPEN: 'reopened',
      };
      return `Remark ${did[String(a.remark_action)] ?? 'changed'} on ${doc}: "${text(a.body)}".`;
    }
    default:
      return `${e.tableName} ${e.action.toLowerCase()}.`;
  }
}
