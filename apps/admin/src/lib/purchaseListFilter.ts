import type { PurchaseRecord, PurchaseSettlement } from '@dsb-pro/adapters';

// N06: old DSB's bill status and date filters, applied to the bills already loaded on this screen.
// Paid/Partial/Unpaid come from the ledger settlement (allocations and returns), never from payment type;
// a bill whose settlement could not be read matches none of them.
export type BillStatusFilter = 'all' | 'posted' | 'void' | 'paid' | 'partial' | 'unpaid';

const SETTLEMENT_OF: Partial<Record<BillStatusFilter, PurchaseSettlement['status']>> = {
  paid: 'settled',
  partial: 'partial',
  unpaid: 'unpaid',
};

export function filterBills(
  rows: PurchaseRecord[],
  f: { status: BillStatusFilter; from: string; to: string },
  settlements?: Map<string, PurchaseSettlement>,
): PurchaseRecord[] {
  return rows.filter((b) => {
    const want = SETTLEMENT_OF[f.status];
    const statusOk =
      f.status === 'all' ||
      (f.status === 'posted'
        ? b.status === 'POSTED'
        : f.status === 'void'
          ? b.status === 'VOID'
          : b.status === 'POSTED' && settlements?.get(b.id)?.status === want);
    return statusOk && (!f.from || b.business_date >= f.from) && (!f.to || b.business_date <= f.to);
  });
}

/** List badge: Paid / Partial / Unpaid / Void; null when the settlement is not known. */
export function listBadge(s: PurchaseSettlement | undefined): string | null {
  switch (s?.status) {
    case 'settled':
      return 'Paid';
    case 'partial':
      return 'Partial';
    case 'unpaid':
      return 'Unpaid';
    case 'void':
      return 'Void';
    default:
      return null;
  }
}
