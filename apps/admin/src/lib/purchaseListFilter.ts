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

/** List badge: Paid / Part paid / Owed / Void; null when the settlement is not known. */
export function listBadge(s: PurchaseSettlement | undefined): string | null {
  switch (s?.status) {
    case 'settled':
      return 'Paid';
    case 'partial':
      return 'Part paid';
    case 'unpaid':
      return 'Owed';
    case 'void':
      return 'Void';
    default:
      return null;
  }
}

const STATUS_WORDS: Record<string, string> = {
  posted: 'Posted',
  void: 'Void',
  paid: 'Paid',
  partial: 'Part paid',
  unpaid: 'Owed',
  pending: 'Pending items',
};

/** One short line saying which filters are on ("All bills" when none), shown on the collapsed Filter row. */
export function filterSummaryText(f: {
  supplierName: string | null;
  status: string;
  sort: string;
  from: string;
  to: string;
  showVoided: boolean;
}): string {
  const parts: string[] = [];
  if (f.supplierName) parts.push(f.supplierName);
  const word = STATUS_WORDS[f.status];
  if (word) parts.push(word);
  if (f.from && f.to) parts.push(`${f.from} to ${f.to}`);
  else if (f.from) parts.push(`from ${f.from}`);
  else if (f.to) parts.push(`until ${f.to}`);
  if (f.sort === 'entered') parts.push('Recently entered first');
  if (f.showVoided && f.status !== 'void') parts.push('Voided shown');
  return parts.length ? parts.join(' · ') : 'All bills';
}
