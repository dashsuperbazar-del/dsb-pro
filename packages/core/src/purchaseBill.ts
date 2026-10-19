import { parseQuantityMicros, type DecimalInput } from './fixedPoint';

// billextras (mig 0064): exact purchase-line and bill totals, identical to the server's post_purchase_v2.
// Old DSB calcItemRow: total = qty x rate, minus discount %, plus GST % on the discounted amount. Here the
// whole line is computed in integers and rounded to the paisa exactly once (half up), so the client and the
// server always agree; old DSB kept floats and only rounded the bill.

export const PURCHASE_PAYMENT_TYPES = ['credit', 'cash', 'upi'] as const;
export type PurchasePaymentType = (typeof PURCHASE_PAYMENT_TYPES)[number];

const BP = 10_000n;
const QTY_SCALE = 1_000_000n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function assertBasisPoints(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 10_000)
    throw new Error(`${name} must be whole basis points between 0 and 10000`);
}

export type PurchaseLineAmounts = {
  qty: DecimalInput;
  unitPricePaise: number;
  /** Per-line discount, basis points (old DSB "Disc %"). */
  discountBp?: number;
  /**
   * GST ADDED on top of the discounted amount, basis points (old DSB "GST %"). null = field left blank:
   * price as entered (GST-inclusive at the item's master rate), nothing added. 0 = "0% added" (the line is
   * recorded at rate 0). Both add nothing to the total; the server stores the difference.
   */
  gstBp?: number | null;
};

export function purchaseLineTotalPaise(line: PurchaseLineAmounts): number {
  if (!Number.isSafeInteger(line.unitPricePaise) || line.unitPricePaise < 0)
    throw new Error('unitPricePaise must be a non-negative integer paise value');
  const discount = line.discountBp ?? 0;
  const gst = line.gstBp ?? 0;
  assertBasisPoints(discount, 'discountBp');
  assertBasisPoints(gst, 'gstBp');
  const numerator =
    parseQuantityMicros(line.qty) *
    BigInt(line.unitPricePaise) *
    (BP - BigInt(discount)) *
    (BP + BigInt(gst));
  // Exactly the SQL: floor((2N + D) / (2D)), D = 10^14 (integer half-up, no division before rounding).
  const denominator = QTY_SCALE * BP * BP;
  const total = (2n * numerator + denominator) / (2n * denominator);
  if (total > MAX_SAFE) throw new Error('line total exceeds the safe integer range');
  return Number(total);
}

export type PurchaseCharge = { label: string; amountPaise: number };

export function purchaseBillTotals(input: {
  lines: PurchaseLineAmounts[];
  discountPaise?: number;
  charges?: PurchaseCharge[];
}): {
  lineTotalsPaise: number[];
  subtotalPaise: number;
  extraChargesPaise: number;
  totalPaise: number;
} {
  const lineTotalsPaise = input.lines.map(purchaseLineTotalPaise);
  const subtotal = lineTotalsPaise.reduce((s, v) => s + BigInt(v), 0n);
  const extra = (input.charges ?? []).reduce((s, c) => {
    if (!Number.isSafeInteger(c.amountPaise) || c.amountPaise <= 0)
      throw new Error('charge amount must be a positive integer paise value');
    return s + BigInt(c.amountPaise);
  }, 0n);
  const discount = input.discountPaise ?? 0;
  if (!Number.isSafeInteger(discount) || discount < 0)
    throw new Error('discountPaise must be a non-negative integer');
  const total = subtotal - BigInt(discount) + extra;
  if (total < 0n) throw new Error('bill total cannot be negative');
  if (subtotal > MAX_SAFE || extra > MAX_SAFE || total > MAX_SAFE)
    throw new Error('bill total exceeds the safe integer range');
  return {
    lineTotalsPaise,
    subtotalPaise: Number(subtotal),
    extraChargesPaise: Number(extra),
    totalPaise: Number(total),
  };
}
