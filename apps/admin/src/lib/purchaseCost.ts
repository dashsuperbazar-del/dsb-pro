import { canonicalQuantity, quantityTimesPaise } from '@dsb-pro/core';

export type DerivedCost =
  | { ok: true; exact: boolean; unitPaise: number; lineTotalPaise: number; diffPaise: number }
  | { ok: false; message: string };

const RUPEES = /^\d+(\.\d{1,2})?$/;

// "Line total" cost entry: the user types what the supplier charged for the whole line and we derive the
// whole-paise unit cost the app stores. A unit cost is an integer number of paise, so many totals cannot be
// reproduced (Rs 100 for 3 pieces = 33.33 each = 99.99). This never hides that: it returns the exact total the
// stored unit cost produces and the difference, and the screen makes the user accept it or enter a unit cost.
export function deriveUnitCostFromTotal(qtyText: string, totalText: string): DerivedCost {
  let qty: string;
  try {
    if (!qtyText.trim()) throw new Error('empty');
    qty = canonicalQuantity(qtyText);
  } catch {
    return {
      ok: false,
      message: 'Enter a quantity greater than zero with at most 6 decimal places.',
    };
  }
  const [whole, frac = ''] = qty.split('.');
  const qtyMicros = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0') || '0');
  if (qtyMicros <= 0n) return { ok: false, message: 'Quantity must be greater than zero.' };
  const total = totalText.trim();
  if (!total || !RUPEES.test(total))
    return { ok: false, message: 'Enter the line total in rupees with at most 2 decimals.' };
  const [rw, rf = ''] = total.split('.');
  const totalPaise = BigInt(rw) * 100n + BigInt(rf.padEnd(2, '0') || '0');
  // unit = round-half-up(total / qty), in paise per unit
  const numerator = totalPaise * 1_000_000n;
  const unit = (2n * numerator + qtyMicros) / (2n * qtyMicros);
  const TOO_LARGE: DerivedCost = {
    ok: false,
    message: 'That total is too large to store as a line. Check the quantity and amount.',
  };
  const candidates = [unit, unit - 1n, unit + 1n].filter(
    (c) => c >= 0n && c <= BigInt(Number.MAX_SAFE_INTEGER),
  );
  if (candidates.length === 0 || totalPaise > BigInt(Number.MAX_SAFE_INTEGER)) return TOO_LARGE;
  try {
    const stored = (c: bigint) => quantityTimesPaise(qty, Number(c));
    for (const c of candidates) {
      const t = stored(c);
      if (BigInt(t) === totalPaise)
        return { ok: true, exact: true, unitPaise: Number(c), lineTotalPaise: t, diffPaise: 0 };
    }
    const best = candidates[0];
    const t = stored(best);
    return {
      ok: true,
      exact: false,
      unitPaise: Number(best),
      lineTotalPaise: t,
      diffPaise: Number(BigInt(t) - totalPaise),
    };
  } catch {
    // quantityTimesPaise refuses a product beyond the safe integer range
    return TOO_LARGE;
  }
}
