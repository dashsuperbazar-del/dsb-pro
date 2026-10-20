import { parseRupeesToPaise, purchaseBillTotals, type PurchasePaymentType } from '@dsb-pro/core';
import type { PurchaseRequest, PurchaseV2Request } from '@dsb-pro/adapters';
import { paiseToDecimal, rupees } from './money';

// billextras (mig 0064) bill entry: payment type, notes, per-item discount/GST, named extra charges, several
// photos and the round-off. Money is never decided here by floats: every total comes from core
// purchaseBillTotals, the same integer arithmetic the server (post_purchase_v2) checks against.

export const NOTES_MAX = 500;
export const CHARGE_LABEL_MAX = 60;
export const MAX_BILL_PHOTOS = 10;
export const PAYMENT_LABEL: Record<PurchasePaymentType, string> = {
  credit: 'Credit',
  cash: 'Cash',
  upi: 'UPI',
};

const PERCENT = /^(\d{1,3})(?:\.(\d{1,2}))?$/;

/** "5" → 500, "12.5" → 1250, "" → null. Throws when it is not a percentage 0–100 with at most 2 decimals. */
export function parsePercentBp(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const m = PERCENT.exec(t);
  if (!m) throw new Error('Enter a percentage from 0 to 100 (at most 2 decimals).');
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  if (bp > 10_000) throw new Error('Enter a percentage from 0 to 100 (at most 2 decimals).');
  return bp;
}

/** 1250 → "12.5", 500 → "5", 0 → "0". */
export function percentText(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const frac = String(bp % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

/**
 * What the GST field means, in plain words. Blank: the rate typed already includes GST (at the item's own
 * rate), nothing is added. A number, 0 included: that GST % is added on top of the rate after discount.
 */
export function gstHint(text: string): string {
  let bp: number | null;
  try {
    bp = parsePercentBp(text);
  } catch {
    return 'GST must be a percentage from 0 to 100.';
  }
  if (bp === null) return 'GST blank: the rate already includes GST. Nothing is added.';
  if (bp === 0) return '0% added: no GST on this item.';
  return `${percentText(bp)}% GST added on top of the rate.`;
}

export type ChargeRow = { key: string; label: string; amount: string };
let chargeSeq = 0;
export function emptyCharge(): ChargeRow {
  return {
    key: `charge-${Date.now().toString(36)}-${(chargeSeq++).toString(36)}`,
    label: '',
    amount: '',
  };
}

export type ChargesResult = {
  charges: { label: string; amountPaise: number }[];
  problems: { index: number; message: string }[];
  totalPaise: number;
};

/** Rows left fully blank are skipped. A started row needs a name (≤60) and an amount above ₹0 in whole paise. */
export function evaluateCharges(rows: { label: string; amount: string }[]): ChargesResult {
  const charges: { label: string; amountPaise: number }[] = [];
  const problems: { index: number; message: string }[] = [];
  let totalPaise = 0;
  rows.forEach((r, index) => {
    const label = r.label.trim();
    const amount = r.amount.trim();
    if (!label && !amount) return;
    if (!label) return problems.push({ index, message: 'Name the extra charge (e.g. Transport).' });
    if (label.length > CHARGE_LABEL_MAX)
      return problems.push({
        index,
        message: `Charge names are limited to ${CHARGE_LABEL_MAX} characters.`,
      });
    if (!amount) return problems.push({ index, message: `Enter the amount for “${label}”.` });
    let paise: number;
    try {
      if (!/^\d+(\.\d{1,2})?$/.test(amount)) throw new Error('bad');
      paise = parseRupeesToPaise(amount);
    } catch {
      return problems.push({
        index,
        message: `“${label}”: enter the amount in rupees, like 25 or 25.50.`,
      });
    }
    if (paise <= 0)
      return problems.push({ index, message: `“${label}”: the amount must be more than ₹0.` });
    charges.push({ label, amountPaise: paise });
    totalPaise += paise;
  });
  return { charges, problems, totalPaise };
}

/** Old (single "Extra charges ₹" field) drafts and v1 bills: one named row carries the whole amount. */
export function chargeRowsFromExtra(extra: string): ChargeRow[] {
  if (!extra.trim()) return [];
  return [{ ...emptyCharge(), label: 'Extra charges', amount: extra.trim() }];
}
export function chargeRowsFromPaise(charges: { label: string; amountPaise: string | number }[]) {
  return charges.map((c) => ({
    ...emptyCharge(),
    label: c.label,
    amount: paiseToDecimal(c.amountPaise),
  }));
}

export type BillLineAmounts = {
  qty: string;
  unitPricePaise: number;
  discountBp: number;
  gstBp: number | null;
};
export type BillTotals =
  | {
      ok: true;
      lineTotalsPaise: number[];
      subtotalPaise: number;
      discountPaise: number;
      extraChargesPaise: number;
      totalBeforeRoundOffPaise: number;
      roundOffPaise: number;
      totalPaise: number;
    }
  | { ok: false; message: string };

/** The bill totals exactly as post_purchase_v2 computes them (core purchaseBillTotals). */
export function billTotals(
  lines: BillLineAmounts[],
  discountText: string,
  charges: { label: string; amountPaise: number }[],
): BillTotals {
  let discountPaise: number;
  try {
    const d = discountText.trim();
    if (d && !/^\d+(\.\d{1,2})?$/.test(d)) throw new Error('bad');
    discountPaise = d ? parseRupeesToPaise(d) : 0;
  } catch {
    return { ok: false, message: 'Enter the bill discount in rupees, like 10 or 10.50.' };
  }
  try {
    const t = purchaseBillTotals({ lines, discountPaise, charges });
    return { ok: true, discountPaise, ...t };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      message: /negative/.test(message)
        ? 'The bill discount is more than the bill. Check the discount.'
        : 'These amounts are too large. Check the quantities and rates.',
    };
  }
}

/** "Round off +₹0.09" / "Round off −₹0.49" / "Round off ₹0.00". */
export function roundOffText(paise: number): string {
  return `Round off ${paise > 0 ? '+' : ''}${rupees(paise)}`;
}

/** The pending-intent copy of a sent purchase. v1 entries (sent before this version) stay retryable as v1. */
export type PendingPurchaseV2 = PurchaseV2Request & { api: 'v2' };
export type PendingPurchase = PurchaseRequest | PendingPurchaseV2;
export function isV2Pending(p: PendingPurchase): p is PendingPurchaseV2 {
  return (p as { api?: unknown }).api === 'v2';
}
/** The bill photos of a pending request, whichever version sent it. */
export function pendingImages(p: PendingPurchase): string[] {
  return isV2Pending(p) ? (p.images ?? []) : p.billImagePath ? [p.billImagePath] : [];
}

export function postButtonText(type: PurchasePaymentType, totalPaise: number | null): string {
  if (type === 'credit' || totalPaise === null || totalPaise <= 0) return 'Post purchase';
  return `Post and pay ${rupees(totalPaise)} by ${PAYMENT_LABEL[type]}`;
}
