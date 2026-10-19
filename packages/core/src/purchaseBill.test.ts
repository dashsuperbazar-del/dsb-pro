import { describe, expect, it } from 'vitest';
import { quantityTimesPaise } from './fixedPoint';
import { purchaseBillTotals, purchaseLineTotalPaise } from './purchaseBill';
import { percentToBasisPoints } from './totals';

// Golden oracle: old DSB index.html calcItemRow / saveBill line arithmetic, copied verbatim (rupees, floats).
function oldDsbLineTotal(qty: number, rate: number, disc: number, gst: number): number {
  const sub = qty * rate;
  const discAmt = (sub * disc) / 100;
  const after = sub - discAmt;
  const gstAmt = (after * gst) / 100;
  return after + gstAmt;
}

// qty, rate (rupees), disc %, gst %, expected paise. BILL-1003 is a real old-DSB row (20 x 8.71 @ 5% = 182.91).
const GOLDEN: [string, string, string, string, number][] = [
  ['5', '1150', '0', '0', 575000],
  ['20', '8.71', '0', '5', 18291],
  ['3', '99.99', '10', '18', 31857],
  ['2.5', '40', '2.5', '12', 10920],
  ['1.333', '75.5', '7', '5', 9828],
  ['12', '0.5', '100', '18', 0],
  ['7', '123.45', '0', '28', 110611],
  ['0.25', '1580', '1.2', '0', 39026],
];

describe('purchase line totals (old DSB calcItemRow, exact paise)', () => {
  it.each(GOLDEN)(
    'golden case %#: qty %s x rate %s, disc %s, GST %s',
    (qty, rate, disc, gst, expected) => {
      const pricePaise = Math.round(Number(rate) * 100);
      const got = purchaseLineTotalPaise({
        qty,
        unitPricePaise: pricePaise,
        discountBp: percentToBasisPoints(Number(disc)),
        gstBp: Number(gst) ? percentToBasisPoints(Number(gst)) : null,
      });
      expect(got).toBe(expected);
      expect(got).toBe(
        Math.round(oldDsbLineTotal(Number(qty), Number(rate), Number(disc), Number(gst)) * 100),
      );
    },
  );

  it("without discount or GST is exactly today's line total (qty x price, half up)", () => {
    for (const [qty, price] of [
      ['0.145', 100],
      ['3', 1999],
      ['1.5', 333],
      ['0.000001', 123456],
    ] as const) {
      expect(purchaseLineTotalPaise({ qty, unitPricePaise: price })).toBe(
        quantityTimesPaise(qty, price),
      );
      expect(purchaseLineTotalPaise({ qty, unitPricePaise: price, discountBp: 0, gstBp: 0 })).toBe(
        quantityTimesPaise(qty, price),
      );
    }
  });

  it('rounds once, half up, after discount and GST', () => {
    // 1 x 0.15 paise-equivalent: 1 x 1 paise, 50% off = 0.5 -> 1 (half up)
    expect(purchaseLineTotalPaise({ qty: '1', unitPricePaise: 1, discountBp: 5000 })).toBe(1);
    // 1 x 3 paise, 50% off = 1.5, +0 GST -> 2
    expect(purchaseLineTotalPaise({ qty: '1', unitPricePaise: 3, discountBp: 5000 })).toBe(2);
    // 1 x 10 paise, 5% GST = 10.5 -> 11
    expect(purchaseLineTotalPaise({ qty: '1', unitPricePaise: 10, gstBp: 500 })).toBe(11);
  });

  it('rejects out-of-range basis points and bad prices', () => {
    expect(() =>
      purchaseLineTotalPaise({ qty: '1', unitPricePaise: 1, discountBp: 10001 }),
    ).toThrow();
    expect(() => purchaseLineTotalPaise({ qty: '1', unitPricePaise: 1.5 })).toThrow();
    expect(() => purchaseLineTotalPaise({ qty: '0', unitPricePaise: 1 })).toThrow();
  });
});

describe('purchase bill totals', () => {
  it('sums lines, adds named charges, subtracts the bill discount (no rounding on purchases)', () => {
    const t = purchaseBillTotals({
      lines: [
        { qty: '20', unitPricePaise: 871, gstBp: 500 },
        { qty: '3', unitPricePaise: 9999, discountBp: 1000, gstBp: 1800 },
      ],
      discountPaise: 500,
      charges: [
        { label: 'Freight', amountPaise: 20000 },
        { label: 'Loading', amountPaise: 5000 },
      ],
    });
    expect(t).toEqual({
      lineTotalsPaise: [18291, 31857],
      subtotalPaise: 50148,
      extraChargesPaise: 25000,
      totalPaise: 74648,
    });
    // Old DSB rounded the bill to the rupee; the exact paise total rounds to the same rupee.
    const old = oldDsbLineTotal(20, 8.71, 0, 5) + oldDsbLineTotal(3, 99.99, 10, 18) + 200 + 50 - 5;
    expect(Math.round(old)).toBe(Math.round(t.totalPaise / 100));
  });

  it('refuses a negative total and non-positive charges', () => {
    expect(() =>
      purchaseBillTotals({ lines: [{ qty: '1', unitPricePaise: 100 }], discountPaise: 101 }),
    ).toThrow();
    expect(() =>
      purchaseBillTotals({
        lines: [{ qty: '1', unitPricePaise: 100 }],
        charges: [{ label: 'x', amountPaise: 0 }],
      }),
    ).toThrow();
  });
});
