import { toCsv, type Cell } from './csv';
import { paiseToDecimal, rupees } from './money';
import { validStatementDates } from './supplierStatement';

export type LedgerRow = {
  customer_id: string;
  business_date: string;
  created_at: string;
  entry_type: 'SALE' | 'PAYMENT' | 'REFUND' | 'SALE_RETURN';
  ref_id: string;
  reference: string | null;
  debit_paise: number;
  credit_paise: number;
};
export type CustomerStatementScope = {
  shopId: string;
  customerId: string;
  from: string | null;
  to: string;
};
export type CustomerStatementEntry = {
  id: string;
  kind: LedgerRow['entry_type'];
  date: string;
  document: string;
  amountPaise: string;
  runningBalancePaise: string;
};
export type CustomerStatement = CustomerStatementScope & {
  shopName: string;
  address: string | null;
  gstin: string | null;
  customerName: string;
  retrievedAt: string;
  openingBalancePaise: string;
  closingBalancePaise: string;
  entries: CustomerStatementEntry[];
};
export const CUSTOMER_STATEMENT_NOTE =
  'Posted sales, payments, refunds and returns as recorded now. Voided payments are not shown. Unconfirmed device entries are not included. Positive balance = the customer owes the shop; negative balance = advance / credit.';
const kinds: Record<LedgerRow['entry_type'], string> = {
  SALE: 'Sale',
  PAYMENT: 'Payment received',
  REFUND: 'Refund paid',
  SALE_RETURN: 'Sale return',
};
export const customerEntryKind = (kind: LedgerRow['entry_type']) => kinds[kind];
const isPaise = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

// The statement is derived from the immutable customer ledger. It fails closed unless the rows we
// were given add up to the server's own balance for the customer (a truncated or partial read can
// never produce a plausible-looking statement).
export function prepareCustomerStatement(
  rows: LedgerRow[],
  serverBalancePaise: number,
  scope: CustomerStatementScope,
  profile: { id: string; name: string; address: string | null; gstin: string | null },
  customerName: string,
  retrievedAt: string,
): CustomerStatement {
  if (
    !validStatementDates(scope.from, scope.to) ||
    profile.id !== scope.shopId ||
    !profile.name.trim() ||
    !customerName.trim() ||
    !Number.isSafeInteger(serverBalancePaise)
  )
    throw new Error('Statement scope or shop details could not be verified. Prepare it again.');
  const seen = new Set<string>();
  for (const r of rows) {
    if (
      !r ||
      r.customer_id !== scope.customerId ||
      !Object.hasOwn(kinds, r.entry_type) ||
      !isPaise(r.debit_paise) ||
      !isPaise(r.credit_paise) ||
      typeof r.ref_id !== 'string' ||
      !r.ref_id ||
      typeof r.created_at !== 'string' ||
      !validStatementDates(null, r.business_date) ||
      seen.has(`${r.entry_type}:${r.ref_id}`)
    )
      throw new Error('The customer ledger contains an invalid or incomplete entry.');
    seen.add(`${r.entry_type}:${r.ref_id}`);
  }
  const sorted = [...rows].sort(
    (a, b) =>
      a.business_date.localeCompare(b.business_date) ||
      a.created_at.localeCompare(b.created_at) ||
      a.ref_id.localeCompare(b.ref_id),
  );
  const total = sorted.reduce((sum, r) => sum + BigInt(r.debit_paise) - BigInt(r.credit_paise), 0n);
  if (total !== BigInt(serverBalancePaise))
    throw new Error(
      'The customer ledger does not reconcile with the stored balance, so no statement was produced. Reload and try again.',
    );
  let balance = 0n;
  let opening = 0n;
  const entries: CustomerStatementEntry[] = [];
  for (const r of sorted) {
    const change = BigInt(r.debit_paise) - BigInt(r.credit_paise);
    if (r.business_date > scope.to) break;
    if (scope.from && r.business_date < scope.from) {
      balance += change;
      opening = balance;
      continue;
    }
    balance += change;
    entries.push({
      id: r.ref_id,
      kind: r.entry_type,
      date: r.business_date,
      document: r.reference ?? '',
      amountPaise: change.toString(),
      runningBalancePaise: balance.toString(),
    });
  }
  return {
    ...scope,
    shopName: profile.name,
    address: profile.address,
    gstin: profile.gstin,
    customerName,
    retrievedAt,
    openingBalancePaise: opening.toString(),
    closingBalancePaise: balance.toString(),
    entries,
  };
}
export const customerStatementPeriod = (s: CustomerStatementScope) =>
  `${s.from ?? 'All recorded history'} to ${s.to}`;
export function customerStatementText(s: CustomerStatement): string {
  return [
    s.shopName,
    s.address,
    s.gstin ? `GSTIN ${s.gstin}` : null,
    'Customer statement',
    `Customer: ${s.customerName}`,
    `Period: ${customerStatementPeriod(s)}`,
    `Retrieved: ${s.retrievedAt}`,
    CUSTOMER_STATEMENT_NOTE,
    `Opening: ${rupees(s.openingBalancePaise)}`,
    ...s.entries.map(
      (e) =>
        `${e.date} | ${customerEntryKind(e.kind)} | ${e.document} | Change ${rupees(e.amountPaise)} | Balance ${rupees(e.runningBalancePaise)}`,
    ),
    s.entries.length ? null : 'No posted entries in this period.',
    `Closing: ${rupees(s.closingBalancePaise)}`,
  ]
    .filter((v) => v !== null)
    .join('\n');
}
export function customerStatementCsv(s: CustomerStatement): string {
  const text = (v: string): Cell => ({ text: v });
  const num = (v: string): Cell => ({ num: paiseToDecimal(v) });
  return toCsv(
    ['Date', 'Entry', 'Document', 'Change INR', 'Balance INR'],
    [
      [text('Shop'), text(s.shopName), text(s.shopId)],
      [text('Address'), text(s.address ?? '')],
      [text('GSTIN'), text(s.gstin ?? '')],
      [text('Customer'), text(s.customerName), text(s.customerId)],
      [text('Period'), text(customerStatementPeriod(s))],
      [text('Retrieved UTC'), text(s.retrievedAt)],
      [text('Basis'), text(CUSTOMER_STATEMENT_NOTE)],
      [text(''), text('Opening'), text(''), num('0'), num(s.openingBalancePaise)],
      ...s.entries.map((e) => [
        text(e.date),
        text(customerEntryKind(e.kind)),
        text(e.document),
        num(e.amountPaise),
        num(e.runningBalancePaise),
      ]),
      [text(''), text('Closing'), text(''), num('0'), num(s.closingBalancePaise)],
    ].map((row) => Array.from({ length: 5 }, (_, i) => row[i] ?? text(''))),
  );
}
