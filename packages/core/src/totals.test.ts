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
