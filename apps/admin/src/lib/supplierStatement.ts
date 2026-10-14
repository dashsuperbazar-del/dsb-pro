import type { SupplierLedgerEntry } from '@dsb-pro/adapters';
import { toCsv, type Cell } from './csv';
import { paiseToDecimal, rupees } from './money';

export type StatementScope = { shopId: string; partyId: string; from: string | null; to: string };
export type SupplierStatement = StatementScope & {
  shopName: string;
  address: string | null;
  gstin: string | null;
  supplierName: string;
  retrievedAt: string;
  openingBalancePaise: string;
  closingBalancePaise: string;
  entries: SupplierLedgerEntry[];
};
export const STATEMENT_NOTE =
  'Current posted records only. Voids restate history; this is not an original historical snapshot. Unconfirmed device entries are not included. Positive balance = owed to supplier; negative balance = credit / advance.';
const kinds: Record<string, string> = {
  PURCHASE: 'Purchase',
  PURCHASE_RETURN: 'Purchase return',
  PAYMENT_MADE: 'Payment made',
  PAYMENT_RECEIVED: 'Payment received',
  OPENING_BALANCE: 'Opening balance',
};
export const statementKind = (kind: string) => kinds[kind];
const integer = (v: unknown): v is string => typeof v === 'string' && /^-?\d+$/.test(v);
export function validStatementDates(from: string | null, to: string): boolean {
  const date = (v: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    Number.isFinite(Date.parse(v)) &&
    new Date(v).toISOString().slice(0, 10) === v;
  return date(to) && (from === null || (date(from) && from <= to));
}

// Fail closed on the RPC's scope and exact integer contract. These checks verify the server result;
// no ledger is reconstructed from the separately paged bills/payments UI.
export function prepareSupplierStatement(
  data: unknown,
  scope: StatementScope,
  profile: { id: string; name: string; address: string | null; gstin: string | null },
  supplierName: string,
  retrievedAt: string,
): SupplierStatement {
  const r = data as Record<string, unknown> | null;
  if (
    !validStatementDates(scope.from, scope.to) ||
    !r ||
    r.shopId !== scope.shopId ||
    r.partyId !== scope.partyId ||
    r.from !== scope.from ||
    r.to !== scope.to ||
    !integer(r.openingBalancePaise) ||
    !integer(r.closingBalancePaise) ||
    !Array.isArray(r.entries) ||
    profile.id !== scope.shopId ||
    !profile.name.trim() ||
    !supplierName.trim()
  )
    throw new Error('Statement scope or shop details could not be verified. Prepare it again.');
  let balance = BigInt(r.openingBalancePaise);
  let previousDate = '';
  const seen = new Set<string>();
  const entries: SupplierLedgerEntry[] = r.entries.map((value: unknown) => {
    const e = value as SupplierLedgerEntry | null;
    if (
      !e ||
      typeof e.id !== 'string' ||
      !e.id ||
      typeof e.kind !== 'string' ||
      !Object.hasOwn(kinds, e.kind) ||
      typeof e.document !== 'string' ||
      typeof e.date !== 'string' ||
      !validStatementDates(null, e.date) ||
      (scope.from && e.date < scope.from) ||
      e.date > scope.to ||
      e.date < previousDate ||
      !integer(e.amountPaise) ||
      !integer(e.runningBalancePaise) ||
      seen.has(`${e.kind}:${e.id}`)
    )
      throw new Error('Statement contains an invalid or incomplete ledger entry.');
    balance += BigInt(e.amountPaise);
    if (balance !== BigInt(e.runningBalancePaise))
      throw new Error('Statement running balance does not reconcile.');
    seen.add(`${e.kind}:${e.id}`);
    previousDate = e.date;
    return {
      id: e.id,
      kind: e.kind,
      date: e.date,
      document: e.document,
      amountPaise: e.amountPaise,
      runningBalancePaise: e.runningBalancePaise,
    };
  });
  if (balance !== BigInt(r.closingBalancePaise))
    throw new Error('Statement closing balance does not reconcile.');
  return {
    ...scope,
    shopName: profile.name,
    address: profile.address,
    gstin: profile.gstin,
    supplierName,
    retrievedAt,
    openingBalancePaise: r.openingBalancePaise,
    closingBalancePaise: r.closingBalancePaise,
    entries,
  };
}
export const statementPeriod = (s: StatementScope) =>
  `${s.from ?? 'All recorded history'} to ${s.to}`;
export function statementText(s: SupplierStatement): string {
  return [
    s.shopName,
    s.address,
    s.gstin ? `GSTIN ${s.gstin}` : null,
    'Supplier statement',
    `Supplier: ${s.supplierName}`,
    `Shop ID: ${s.shopId}`,
    `Supplier ID: ${s.partyId}`,
    `Period: ${statementPeriod(s)}`,
    `Retrieved: ${s.retrievedAt}`,
    STATEMENT_NOTE,
    `Opening: ${rupees(s.openingBalancePaise)}`,
    ...s.entries.map(
      (e) =>
        `${e.date} | ${statementKind(e.kind)} | ${e.document} | Change ${rupees(e.amountPaise)} | Balance ${rupees(e.runningBalancePaise)}`,
    ),
    s.entries.length ? null : 'No posted entries in this period.',
    `Closing: ${rupees(s.closingBalancePaise)}`,
  ]
    .filter((v) => v !== null)
    .join('\n');
}
export function statementCsv(s: SupplierStatement): string {
  const text = (v: string): Cell => ({ text: v });
  const num = (v: string): Cell => ({ num: paiseToDecimal(v) });
  return toCsv(
    ['Date', 'Entry', 'Document', 'Change INR', 'Balance INR'],
    [
      [text('Shop'), text(s.shopName), text(s.shopId)],
      [text('Address'), text(s.address ?? '')],
      [text('GSTIN'), text(s.gstin ?? '')],
      [text('Supplier'), text(s.supplierName), text(s.partyId)],
      [text('Period'), text(statementPeriod(s))],
      [text('Retrieved UTC'), text(s.retrievedAt)],
      [text('Basis'), text(STATEMENT_NOTE)],
      [text(''), text('Opening'), text(''), num('0'), num(s.openingBalancePaise)],
      ...s.entries.map((e) => [
        text(e.date),
        text(statementKind(e.kind)),
        text(e.document),
        num(e.amountPaise),
        num(e.runningBalancePaise),
      ]),
      [text(''), text('Closing'), text(''), num('0'), num(s.closingBalancePaise)],
    ].map((row) => Array.from({ length: 5 }, (_, i) => row[i] ?? text(''))),
  );
}
const escape = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
// Only escaped text is interpolated. No scripts, remote assets, attachments or account credentials.
export function statementHtml(s: SupplierStatement, stylesheetUrl: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Supplier statement — ${escape(s.supplierName)}</title><link rel="stylesheet" href="${escape(stylesheetUrl)}"><body><h1>${escape(s.shopName)}</h1>${s.address ? `<p>${escape(s.address)}</p>` : ''}${s.gstin ? `<p>GSTIN ${escape(s.gstin)}</p>` : ''}<h2>Supplier statement: ${escape(s.supplierName)}</h2><p>Period: ${escape(statementPeriod(s))}<br>Retrieved UTC: ${escape(s.retrievedAt)}</p><p class="basis">${escape(STATEMENT_NOTE)}</p><p>Opening: ${escape(rupees(s.openingBalancePaise))}</p><table><thead><tr><th>Date</th><th>Entry</th><th>Document</th><th>Change</th><th>Balance</th></tr></thead><tbody>${s.entries.map((e) => `<tr><td>${escape(e.date)}</td><td>${escape(statementKind(e.kind))}</td><td>${escape(e.document)}</td><td>${escape(rupees(e.amountPaise))}</td><td>${escape(rupees(e.runningBalancePaise))}</td></tr>`).join('')}</tbody></table>${s.entries.length ? '' : '<p>No posted entries in this period.</p>'}<p><strong>Closing: ${escape(rupees(s.closingBalancePaise))}</strong></p><footer class="basis">Shop ID: ${escape(s.shopId)}<br>Supplier ID: ${escape(s.partyId)}</footer></body></html>`;
}
