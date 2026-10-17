import type { PurchaseRecord } from '@dsb-pro/adapters';

// N06: old DSB's bill status and date filters, applied to the bills already loaded on this screen.
export type BillStatusFilter = 'all' | 'posted' | 'void';

export function filterBills(
  rows: PurchaseRecord[],
  f: { status: BillStatusFilter; from: string; to: string },
): PurchaseRecord[] {
  return rows.filter(
    (b) =>
      (f.status === 'all' ||
        (f.status === 'posted' ? b.status === 'POSTED' : b.status === 'VOID')) &&
      (!f.from || b.business_date >= f.from) &&
      (!f.to || b.business_date <= f.to),
  );
}
