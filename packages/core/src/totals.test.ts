import { describe, expect, it } from 'vitest';
import { calculateInvoiceTotals, calculateLegacyDsbInvoiceTotals, calculateLineTotals, percentToBasisPoints } from './totals';

describe('DSB Pro invoice totals', () => {
  it('keeps all money as integer paise', () => {
    const totals = calculateInvoiceTotals([
      { qty: 2, unitPricePaise: 12550, discountBps: 500, taxRateBps: 1800 },
      { qty: 3, unitPricePaise: 4999 },
    ], [{ name: 'Delivery', amountPaise: 2500 }]);
    expect(totals).toEqual({
      subtotalPaise: 40097,
      discountPaise: 1255,
      extraChargesPaise: 2500,
      grandTotalPaise: 41342,
      lines: [
        { grossPaise: 25100, discountPaise: 1255, netPaise: 23845, taxRateBps: 1800 },
        { grossPaise: 14997, discountPaise: 0, netPaise: 14997, taxRateBps: 0 },
      ],
    });
  });

  it('does not add GST on top of final all-inclusive prices', () => {
    const withoutTax = calculateInvoiceTotals([{ qty: 1, unitPricePaise: 10000, taxRateBps: 0 }]);
    const withTaxInfo = calculateInvoiceTotals([{ qty: 1, unitPricePaise: 10000, taxRateBps: 1800 }]);
    expect(withTaxInfo.grandTotalPaise).toBe(withoutTax.grandTotalPaise);
    expect(withTaxInfo.grandTotalPaise).toBe(10000);
  });

  it('rounds fractional quantity at the line money boundary', () => {
    expect(calculateLineTotals({ qty: 1.5, unitPricePaise: 333 }).grossPaise).toBe(500);
    expect(calculateLineTotals({ qty: '0.145', unitPricePaise: 100 }).grossPaise).toBe(15);
  });

  it('applies discount in basis points', () => {
    expect(calculateLineTotals({ qty: 1, unitPricePaise: 10000, discountBps: 1250 }).netPaise).toBe(8750);
  });

  it('adds multiple extra charges exactly', () => {
    const t = calculateInvoiceTotals([{ qty: 1, unitPricePaise: 1000 }], [
      { amountPaise: 100 }, { amountPaise: 250 }, { amountPaise: 0 },
    ]);
    expect(t.extraChargesPaise).toBe(350);
    expect(t.grandTotalPaise).toBe(1350);
  });

  it('converts percent to basis points', () => {
    expect(percentToBasisPoints(12.5)).toBe(1250);
    expect(percentToBasisPoints(0.01)).toBe(1);
  });

  it('rounds discount half-paisa ties upward', () => {
    expect(calculateLineTotals({ qty: '1', unitPricePaise: 1, discountBps: 5000 }).discountPaise).toBe(1);
  });

  it('rejects empty invoices', () => {
    expect(() => calculateInvoiceTotals([])).toThrow(/at least one line/);
  });

  it('rejects zero quantity', () => {
    expect(() => calculateLineTotals({ qty: 0, unitPricePaise: 100 })).toThrow(/qty/);
  });

  it('rejects fractional paise unit prices', () => {
    expect(() => calculateLineTotals({ qty: 1, unitPricePaise: 100.5 })).toThrow(/integer paise/);
  });

  it('rejects discounts above 100 percent', () => {
    expect(() => calculateLineTotals({ qty: 1, unitPricePaise: 100, discountBps: 10001 })).toThrow(/basis points/);
  });

  it('rejects invoice sums outside the JavaScript safe integer range', () => {
    expect(() => calculateInvoiceTotals([
      { qty: '1', unitPricePaise: Number.MAX_SAFE_INTEGER },
      { qty: '1', unitPricePaise: 1 },
    ])).toThrow(/subtotal exceeds safe integer range/);
  });
});

describe('legacy DSB historical reconciliation', () => {
  it('matches legacy subtotal/discount/GST/extras ordering and rupee rounding', () => {
    const t = calculateLegacyDsbInvoiceTotals([
      { qty: 2, rate: 100, disc: 10, gst: 18 },
      { qty: 3, rate: 50, disc: 0, gst: 5 },
    ], [{ amount: 20 }]);
    expect(t.subtotalRupees).toBe(350);
    expect(t.discountRupees).toBe(20);
    expect(t.gstRupees).toBeCloseTo(39.9, 10);
    expect(t.extraRupees).toBe(20);
    expect(t.grandTotalRupees).toBe(390);
    expect(t.grandTotalPaise).toBe(39000);
  });

  it('preserves legacy final whole-rupee Math.round behavior', () => {
    expect(calculateLegacyDsbInvoiceTotals([{ qty: 1, rate: 10.49 }]).grandTotalRupees).toBe(10);
    expect(calculateLegacyDsbInvoiceTotals([{ qty: 1, rate: 10.5 }]).grandTotalRupees).toBe(11);
  });
});

// U1 parity check: old DSB percentage line discounts vs DSB Pro basis-point discounts. With GST
// informational (prices all-inclusive), both compute subtotal - discount + extras the same way; the
// only difference is old DSB's final Math.round to a whole rupee. This test pins that difference so
// a rounding-policy change is a deliberate, reviewed decision.
describe('bill-level discount parity with old DSB (U1)', () => {
  const cases: { lines: { qty: number; rate: number; disc: number }[]; extra: number }[] = [
    { lines: [{ qty: 2, rate: 100, disc: 10 }, { qty: 3, rate: 50, disc: 0 }], extra: 20 },
    { lines: [{ qty: 1, rate: 99.99, disc: 5 }], extra: 0 },
    { lines: [{ qty: 3, rate: 33.33, disc: 12.5 }, { qty: 1, rate: 10, disc: 100 }], extra: 1.5 },
  ];
  it.each(cases)('matches before old DSB final rounding (%#)', ({ lines, extra }) => {
    const legacy = calculateLegacyDsbInvoiceTotals(lines.map((l) => ({ ...l, gst: 0 })), [{ amount: extra }]);
    const pro = calculateInvoiceTotals(
      lines.map((l) => ({ qty: String(l.qty), unitPricePaise: Math.round(l.rate * 100), discountBps: percentToBasisPoints(l.disc) })),
      [{ amountPaise: Math.round(extra * 100) }],
    );
    const legacyUnroundedPaise = Math.round((legacy.subtotalRupees - legacy.discountRupees + legacy.extraRupees) * 100);
    expect(Math.abs(pro.grandTotalPaise - legacyUnroundedPaise)).toBeLessThanOrEqual(1);
    // Old DSB then rounds to the nearest rupee; DSB Pro keeps paise (policy: see STATE.md decision).
    expect(Math.abs(legacy.grandTotalPaise - pro.grandTotalPaise)).toBeLessThanOrEqual(50);
  });
});
