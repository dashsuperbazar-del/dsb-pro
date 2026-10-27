import type { SupplierPayCopySupplier, SupplierPayMode } from '@dsb-pro/sync';
import { rupees } from './money';

// Pure checks for the offline "Pay supplier" form. Everything is exact integer paise; a typed amount is read
// as text (never rounded): "10.005" is refused, not silently turned into 10.01. The server checks again with
// live figures and is the authority; these checks stop a payment that can never be right before it is saved.

export const PAY_MODES: readonly SupplierPayMode[] = ['cash', 'upi', 'bank', 'card', 'other'];
const AMOUNT = /^\d{1,13}(\.\d{1,2})?$/;

/** "1500" / "1,500.50" → paise as a bigint; null when it is not a plain rupee amount. */
export function rupeesTextToPaise(text: string): bigint | null {
  const t = text.trim().replace(/,/g, '');
  if (!AMOUNT.test(t)) return null;
  const [whole = '0', fraction = ''] = t.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
}
export const paiseToRupeesText = (paise: bigint | string): string => {
  const n = BigInt(paise);
  return `${n / 100n}.${String(n % 100n).padStart(2, '0')}`;
};

type PaidRecord = {
  partyId: string;
  amountPaise: string;
  status: string;
  syncedAt: number | null;
  allocations: readonly { purchaseBillId: string; amountPaise: string }[];
};
/**
 * Payments the saved copy does not include yet, per supplier and per bill: the queued ones plus the ones
 * already SYNCED after the copy was saved (a refresh that failed leaves a stale copy that still shows the
 * old owed/outstanding figures). Exact paise.
 */
export function unreflectedPayments(
  records: readonly PaidRecord[],
  copySavedAt: number,
): { bySupplier: Record<string, bigint>; byBill: Record<string, bigint> } {
  const bySupplier: Record<string, bigint> = {};
  const byBill: Record<string, bigint> = {};
  for (const r of records) {
    const counts =
      r.status === 'QUEUED' ||
      (r.status === 'SYNCED' && r.syncedAt !== null && r.syncedAt > copySavedAt);
    if (!counts) continue;
    bySupplier[r.partyId] = (bySupplier[r.partyId] ?? 0n) + BigInt(r.amountPaise);
    for (const a of r.allocations)
      byBill[a.purchaseBillId] = (byBill[a.purchaseBillId] ?? 0n) + BigInt(a.amountPaise);
  }
  return { bySupplier, byBill };
}

export type PayFormInput = {
  supplier: SupplierPayCopySupplier | null;
  amountText: string;
  mode: string;
  reference: string;
  dateText: string;
  /** Typed amount per bill id; blank = not assigned. */
  allocTexts: Readonly<Record<string, string>>;
  /** The shop's business date from the saved copy (a payment may not be dated after it). */
  businessDate: string;
  queuedForSupplier: bigint;
  queuedByBill: Readonly<Record<string, bigint>>;
};
export type PayFormErrors = {
  supplier?: string;
  amount?: string;
  date?: string;
  reference?: string;
  allocations: Record<string, string>;
  allocationsTotal?: string;
};
export type ParsedPayment = {
  partyId: string;
  partyName: string;
  businessDate: string | null;
  amountPaise: string;
  mode: SupplierPayMode;
  reference: string | null;
  allocations: { purchaseBillId: string; billLabel: string; amountPaise: string }[];
  baseVersions: { supplier: string; bills: Record<string, string> };
  limits: { owedPaise: string; bills: Record<string, string> };
};

export const billLabel = (b: { billNo: string | null; billId: string; businessDate: string }) =>
  b.billNo ? `${b.billNo}` : `dated ${b.businessDate}`;

export function checkPayForm(
  i: PayFormInput,
): { ok: true; value: ParsedPayment } | { ok: false; errors: PayFormErrors } {
  const errors: PayFormErrors = { allocations: {} };
  const s = i.supplier;
  if (!s) errors.supplier = 'Choose a supplier.';
  const amount = rupeesTextToPaise(i.amountText);
  if (!i.amountText.trim()) errors.amount = 'Enter the amount you paid.';
  else if (amount === null)
    errors.amount = 'Enter the amount in rupees, like 1500 or 1500.50 (at most 2 decimals).';
  else if (amount <= 0n) errors.amount = 'The amount must be more than zero.';
  const date = i.dateText.trim();
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.date = 'Enter the date as year-month-day.';
  else if (date && date > i.businessDate)
    errors.date = `The date cannot be after today (${i.businessDate}).`;
  else if (date && s) {
    // The server refuses a payment dated before a bill it is assigned to (DSB_FUTURE_BILL); stop it here.
    const effective = date;
    const early = s.bills.find(
      (b) => (i.allocTexts[b.billId] ?? '').trim() && effective < b.businessDate,
    );
    if (early)
      errors.date = `The payment date (${effective}) is earlier than bill ${billLabel(early)} (${early.businessDate}). Use a date on or after the bill date, or do not assign it to that bill.`;
  }
  const reference = i.reference.trim();
  if (reference.length > 200)
    errors.reference = 'The reference is too long (200 characters at most).';
  if (!PAY_MODES.includes(i.mode as SupplierPayMode)) errors.amount ??= 'Choose a payment mode.';

  const allocations: ParsedPayment['allocations'] = [];
  let assigned = 0n;
  if (s)
    for (const b of s.bills) {
      const text = (i.allocTexts[b.billId] ?? '').trim();
      if (!text) continue;
      const label = billLabel(b);
      const value = rupeesTextToPaise(text);
      if (value === null) {
        errors.allocations[b.billId] = 'Enter rupees, like 500 or 500.50.';
        continue;
      }
      if (value === 0n) continue;
      const left = BigInt(b.outstandingPaise) - (i.queuedByBill[b.billId] ?? 0n);
      if (value > left) {
        errors.allocations[b.billId] =
          left > 0n
            ? `Only ${rupees(left.toString())} is left to pay on this bill (counting payments already saved on this device).`
            : 'This bill is already covered by payments saved on this device.';
        continue;
      }
      assigned += value;
      allocations.push({
        purchaseBillId: b.billId,
        billLabel: label,
        amountPaise: value.toString(),
      });
    }
  if (amount !== null && amount > 0n && assigned > amount)
    errors.allocationsTotal = `The amounts assigned to bills (${rupees(assigned.toString())}) are more than the payment (${rupees(amount.toString())}).`;
  if (s && amount !== null && amount > 0n) {
    const owed = BigInt(s.owedPaise);
    const left = (owed < 0n ? 0n : owed) - i.queuedForSupplier;
    if (amount > left)
      errors.amount = `That is more than is owed to ${s.name}: ${rupees((left < 0n ? 0n : left).toString())} is left to pay, counting payments already saved on this device. To pay ahead of a bill, record it online under Record payment.`;
  }
  const bad =
    errors.supplier ||
    errors.amount ||
    errors.date ||
    errors.reference ||
    errors.allocationsTotal ||
    Object.keys(errors.allocations).length;
  if (bad || !s || amount === null) return { ok: false, errors };
  return {
    ok: true,
    value: {
      partyId: s.partyId,
      partyName: s.name,
      businessDate: date || null,
      amountPaise: amount.toString(),
      mode: i.mode as SupplierPayMode,
      reference: reference || null,
      allocations,
      baseVersions: {
        supplier: s.version,
        bills: Object.fromEntries(
          allocations.map((a) => [
            a.purchaseBillId,
            s.bills.find((b) => b.billId === a.purchaseBillId)!.version,
          ]),
        ),
      },
      limits: {
        owedPaise: s.owedPaise,
        bills: Object.fromEntries(s.bills.map((b) => [b.billId, b.outstandingPaise])),
      },
    },
  };
}

/** Oldest bill first (date, then id), exact paise, counting payments already saved on this device. */
export function fifoPlan(
  supplier: SupplierPayCopySupplier,
  queuedByBill: Readonly<Record<string, bigint>>,
  amountPaise: bigint,
): { allocations: Record<string, string>; remainderPaise: bigint } {
  let remaining = amountPaise;
  const allocations: Record<string, string> = {};
  const bills = [...supplier.bills].sort(
    (a, b) => a.businessDate.localeCompare(b.businessDate) || a.billId.localeCompare(b.billId),
  );
  for (const b of bills) {
    const left = BigInt(b.outstandingPaise) - (queuedByBill[b.billId] ?? 0n);
    const take = remaining < left ? remaining : left;
    if (take > 0n) {
      allocations[b.billId] = paiseToRupeesText(take);
      remaining -= take;
    }
  }
  return { allocations, remainderPaise: remaining };
}
