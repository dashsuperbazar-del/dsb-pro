import { rupees } from './money';

// Possible duplicate purchase bill: a warning only. It never blocks posting (the user can always say
// "Post anyway"), and when nothing could be read (offline) it simply finds no match.
export type KnownBill = {
  id: string;
  partyId: string | null;
  billNo: string | null;
  businessDate: string;
  totalPaise: string | number;
  status?: string;
};
export type DuplicateMatch = { bill: KnownBill; reason: 'bill_no' | 'total' };

export const DUPLICATE_TOTAL_WINDOW_DAYS = 3;
const normBillNo = (s: string | null | undefined) =>
  (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const dayNumber = (iso: string) => {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(t) ? null : Math.round(t / 86_400_000);
};

export function findDuplicateBill(
  candidate: {
    partyId: string | null;
    billNo: string | null;
    businessDate: string;
    totalPaise: number | null;
  },
  bills: KnownBill[],
): DuplicateMatch | null {
  if (!candidate.partyId) return null;
  const no = normBillNo(candidate.billNo);
  const day = dayNumber(candidate.businessDate);
  let byTotal: KnownBill | null = null;
  for (const b of bills) {
    if (b.partyId !== candidate.partyId || b.status === 'VOID') continue;
    if (no && normBillNo(b.billNo) === no) return { bill: b, reason: 'bill_no' };
    if (byTotal || candidate.totalPaise === null || day === null) continue;
    const other = dayNumber(b.businessDate);
    if (
      other !== null &&
      Math.abs(day - other) <= DUPLICATE_TOTAL_WINDOW_DAYS &&
      String(b.totalPaise) === String(candidate.totalPaise)
    )
      byTotal = b;
  }
  return byTotal ? { bill: byTotal, reason: 'total' } : null;
}

export function duplicateMessage(m: DuplicateMatch): string {
  const label = m.bill.billNo ? `bill #${m.bill.billNo}` : 'a bill';
  const why =
    m.reason === 'bill_no'
      ? 'same supplier and bill number'
      : `same supplier and total within ${DUPLICATE_TOTAL_WINDOW_DAYS} days`;
  return `Possible duplicate of ${label} dated ${m.bill.businessDate}, ${rupees(m.bill.totalPaise)} (${why}). Post anyway?`;
}

/** Merges bill lists from several sources (server read, cached list), first source wins per id. */
export function mergeKnownBills(...lists: KnownBill[][]): KnownBill[] {
  const seen = new Map<string, KnownBill>();
  for (const list of lists) for (const b of list) if (!seen.has(b.id)) seen.set(b.id, b);
  return [...seen.values()];
}
