import { describe, expect, it } from 'vitest';
import { saleBillTotals, saleGstExtraTax, saleLineTotals, splitGst } from './saleGst';
import { calculateLegacyDsbInvoiceTotals } from './totals';

describe('GST-extra sale maths (golden: same cases as supabase/tests/remaining_sale_pricing.sql)', () => {
  it('rounds the tax half up once per item, exactly like SQL sp_gst_extra_tax', () => {
    const cases: Array<[number, number, number]> = [
      [1000, 1800, 180],
      [1049, 1800, 189],
      [25, 1800, 5],
      [1, 500, 0],
      [10, 500, 1],
      [0, 1800, 0],
      [9999, 2800, 2800],
      [123456789, 1200, 14814815],
      [2000, 0, 0],
    ];
    for (const [net, rate, tax] of cases) expect(saleGstExtraTax(net, rate)).toBe(tax);
  });

  it('splits CGST/SGST with the odd paisa on CGST', () => {
    expect(splitGst(423)).toEqual({ cgstPaise: 212, sgstPaise: 211 });
    expect(splitGst(360)).toEqual({ cgstPaise: 180, sgstPaise: 180 });
    expect(splitGst(0)).toEqual({ cgstPaise: 0, sgstPaise: 0 });
  });

  it('matches the server GST-extra invoice in the pgTAP fixture (s-gx)', () => {
    const bill = saleBillTotals(
      [
        { qty: '2', unitPricePaise: 1049, discountPaise: 98, taxRateBp: 1800 },
        { qty: '1', unitPricePaise: 1250, discountPaise: 0, taxRateBp: 500 },
      ],
      { invoiceType: 'gst_extra', billDiscountPaise: 0, extraChargesPaise: 0 },
    );
    expect(bill.lines.map((l) => [l.taxPaise, l.lineTotalPaise])).toEqual([
      [360, 2360],
      [63, 1313],
    ]);
    expect(bill).toMatchObject({
      subtotalPaise: 3771,
      discountPaise: 98,
      taxPaise: 423,
      roundOffPaise: 27,
      totalPaise: 3700,
    });
  });

  it('GST included (default) is unchanged: no tax added, same total as before', () => {
    const bill = saleBillTotals(
      [{ qty: '3', unitPricePaise: 1049, discountPaise: 0, taxRateBp: 1800 }],
      {
        invoiceType: 'gst_included',
        billDiscountPaise: 0,
        extraChargesPaise: 0,
      },
    );
    expect(bill).toMatchObject({
      subtotalPaise: 3147,
      taxPaise: 0,
      roundOffPaise: -47,
      totalPaise: 3100,
    });
  });

  it('agrees with old DSB saveInvoice (GST on the after-discount value, rupee total) for shop-like bills', () => {
    const oldBills = [
      [
        { qty: 2, rate: 120, gst: 18 },
        { qty: 1, rate: 55, gst: 5 },
      ],
      [{ qty: 3, rate: 99.5, gst: 12 }],
      [
        { qty: 1, rate: 1499, gst: 28 },
        { qty: 5, rate: 10, gst: 0 },
      ],
    ];
    for (const lines of oldBills) {
      const old = calculateLegacyDsbInvoiceTotals(lines.map((l) => ({ ...l, disc: 0 })));
      const pro = saleBillTotals(
        lines.map((l) => ({
          qty: String(l.qty),
          unitPricePaise: Math.round(l.rate * 100),
          discountPaise: 0,
          taxRateBp: l.gst * 100,
        })),
        { invoiceType: 'gst_extra', billDiscountPaise: 0, extraChargesPaise: 0 },
      );
      expect(pro.totalPaise).toBe(old.grandTotalPaise);
    }
  });

  it('refuses a bill discount on a GST-extra invoice and an item discount above its value', () => {
    expect(() =>
      saleBillTotals([{ qty: 1, unitPricePaise: 100, discountPaise: 0, taxRateBp: 1800 }], {
        invoiceType: 'gst_extra',
        billDiscountPaise: 1,
        extraChargesPaise: 0,
      }),
    ).toThrow(/bill discount/i);
    expect(() =>
      saleLineTotals(
        { qty: 1, unitPricePaise: 100, discountPaise: 101, taxRateBp: 0 },
        'gst_extra',
      ),
    ).toThrow();
  });
});
