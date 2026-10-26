import type { SaleReceipt } from '@dsb-pro/adapters';
import type { OfflineSaleRecord } from '@dsb-pro/sync';

// Figures for the "sale done" card and the saved-sales list. Display only: every number is one the
// posting path already stored (the server invoice and its payments, or the device's own sale record).
// Nothing here recomputes a total, tax or round-off.
export type SaleDoneFigures = {
  totalPaise: number;
  paidPaise: number;
  balancePaise: number;
  /** false = not read back from the server invoice (device copy or as entered). Absent = confirmed/stored. */
  confirmed?: boolean;
  /** A payment on the invoice is not POSTED: the remainder is not shown as credit. */
  paymentsUnclear?: boolean;
};

const settle = (totalPaise: number, paidPaise: number): SaleDoneFigures => ({
  totalPaise,
  paidPaise,
  balancePaise: Math.max(0, totalPaise - paidPaise),
});

/** The server's invoice total and the payments it posted for this sale (refunds taken off). */
export function figuresFromReceipt(receipt: SaleReceipt): SaleDoneFigures {
  const paid = receipt.payments
    .filter((p) => p.status === 'POSTED')
    .reduce((sum, p) => sum + (p.direction === 'out' ? -p.amount_paise : p.amount_paise), 0);
  return {
    ...settle(receipt.invoice.total_paise, paid),
    paymentsUnclear: receipt.payments.some((p) => p.status !== 'POSTED'),
  };
}

/** The device's saved sale: its stored total and the payments it holds. */
export function figuresFromRecord(record: OfflineSaleRecord): SaleDoneFigures {
  return settle(
    record.totalPaise,
    record.payments.reduce((sum, p) => sum + p.amountPaise, 0),
  );
}

export type SaleStateLabel = 'synced' | 'waiting' | 'needs review';

/** Plain state of a saved sale: synced, waiting to sync, or needing a person to look at it. */
export function saleStateLabel(record: OfflineSaleRecord): SaleStateLabel {
  if (record.status === 'REJECTED') return 'needs review';
  if (record.reconciliationWarning && !record.reconciliationReviewedAt) return 'needs review';
  return record.status === 'SYNCED' ? 'synced' : 'waiting';
}

/**
 * "Sale 5" for a synced sale (the number of its official invoice), "Sale 14:32" for one that has no official
 * number yet (the time it was saved). The long provisional id is left to the receipt and support.
 */
export function friendlySaleName(record: OfflineSaleRecord): string {
  const official = record.officialDocNo?.match(/(\d+)\D*$/)?.[1];
  if (official) return `Sale ${Number(official)}`;
  const at = new Date(record.createdAt);
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return `Sale ${hh}:${mm}`;
}
