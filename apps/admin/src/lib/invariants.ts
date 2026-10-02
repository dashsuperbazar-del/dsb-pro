// D4a: every numeric field check_invariants returns is shown by name, including checks added after
// the screen was written (unknown names get a readable fallback).
const LABELS: Record<string, string> = {
  saleTotalViolations: 'Sale totals',
  purchaseTotalViolations: 'Purchase totals',
  negativeStock: 'Negative stock (not allowed by shop policy)',
  allocationViolations: 'Over-assigned payments',
  stockProjectionViolations: 'Stock projection',
  voidReversalViolations: 'Void reversals',
  saleReturnViolations: 'Sale returns',
  purchaseReturnViolations: 'Purchase returns',
  returnQuantityViolations: 'Return quantities',
  refundViolations: 'Refunds',
  paymentDirectionViolations: 'Payment directions',
  settlementViolations: 'Opening settlements',
};
export const invariantLabel = (code: string) =>
  LABELS[code] ??
  code
    .replace(/Violations$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());

export function invariantRows(raw: unknown): { code: string; count: number }[] {
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw as Record<string, unknown>)
    .filter(([k, v]) => k !== 'ok' && typeof v === 'number' && Number.isFinite(v))
    .map(([code, count]) => ({ code, count: count as number }));
}
