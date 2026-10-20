import { quantityTimesPaise, type DecimalInput } from './fixedPoint';
import { billRoundOff } from './totals';

/** 'gst_included': prices include GST (default, old behaviour). 'gst_extra': GST is added on top per item. */
export type SaleInvoiceType = 'gst_included' | 'gst_extra';

function assertPaise(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be non-negative whole paise`);
}

/**
 * GST added on top of an item's net value (after its discount): net x rate / 10000, rounded half up once.
 * Mirrors SQL sp_gst_extra_tax exactly (integer arithmetic).
 */
export function saleGstExtraTax(netPaise: number, rateBp: number): number {
  assertPaise(netPaise, 'netPaise');
  if (!Number.isSafeInteger(rateBp) || rateBp < 0 || rateBp > 10000)
    throw new Error('rateBp must be 0..10000');
  const tax = (2n * BigInt(netPaise) * BigInt(rateBp) + 10000n) / 20000n;
  return Number(tax);
}

/** CGST/SGST halves of an intra-state tax amount; the odd paisa goes to CGST. Display only. */
export function splitGst(taxPaise: number): { cgstPaise: number; sgstPaise: number } {
  assertPaise(taxPaise, 'taxPaise');
  const sgstPaise = Math.floor(taxPaise / 2);
  return { cgstPaise: taxPaise - sgstPaise, sgstPaise };
}

export interface SaleLineInput {
  qty: DecimalInput;
  unitPricePaise: number;
  discountPaise: number;
  taxRateBp: number;
}

export interface SaleLineResult {
  grossPaise: number;
  netPaise: number;
  taxPaise: number;
  /** What the item adds to the bill: net (+ GST when GST is extra). Stored as line_total_paise. */
  lineTotalPaise: number;
}

export function saleLineTotals(line: SaleLineInput, invoiceType: SaleInvoiceType): SaleLineResult {
  assertPaise(line.unitPricePaise, 'unitPricePaise');
  assertPaise(line.discountPaise, 'discountPaise');
  const grossPaise = quantityTimesPaise(line.qty, line.unitPricePaise);
  if (line.discountPaise > grossPaise) throw new Error('Item discount exceeds the item value.');
  const netPaise = grossPaise - line.discountPaise;
  const taxPaise = invoiceType === 'gst_extra' ? saleGstExtraTax(netPaise, line.taxRateBp) : 0;
  return { grossPaise, netPaise, taxPaise, lineTotalPaise: netPaise + taxPaise };
}

export interface SaleBillResult {
  lines: SaleLineResult[];
  /** Server subtotal_paise: item values before item discounts, GST included when added on top. */
  subtotalPaise: number;
  /** Item discounts + bill discount. */
  discountPaise: number;
  taxPaise: number;
  extraChargesPaise: number;
  totalBeforeRoundOffPaise: number;
  roundOffPaise: number;
  totalPaise: number;
}

/** Same order of operations as the server (phase4_post_sale_unlocked, 0065); the total is rounded (R0). */
export function saleBillTotals(
  lines: SaleLineInput[],
  options: { invoiceType: SaleInvoiceType; billDiscountPaise: number; extraChargesPaise: number },
): SaleBillResult {
  if (!lines.length) throw new Error('A sale needs at least one item.');
  assertPaise(options.billDiscountPaise, 'billDiscountPaise');
  assertPaise(options.extraChargesPaise, 'extraChargesPaise');
  if (options.invoiceType === 'gst_extra' && options.billDiscountPaise !== 0) {
    throw new Error('A bill discount is not allowed when GST is added on top. Use item discounts.');
  }
  const results = lines.map((line) => saleLineTotals(line, options.invoiceType));
  let subtotal = 0;
  let itemDiscounts = 0;
  let tax = 0;
  results.forEach((r, index) => {
    subtotal += r.grossPaise + r.taxPaise;
    itemDiscounts += lines[index].discountPaise;
    tax += r.taxPaise;
  });
  const discountPaise = itemDiscounts + options.billDiscountPaise;
  if (discountPaise > subtotal) throw new Error('Discount exceeds subtotal.');
  const totalBeforeRoundOffPaise = subtotal - discountPaise + options.extraChargesPaise;
  if (!Number.isSafeInteger(totalBeforeRoundOffPaise + 50))
    throw new Error('Sale total exceeds the safe range.');
  const roundOffPaise = billRoundOff(totalBeforeRoundOffPaise);
  return {
    lines: results,
    subtotalPaise: subtotal,
    discountPaise,
    taxPaise: tax,
    extraChargesPaise: options.extraChargesPaise,
    totalBeforeRoundOffPaise,
    roundOffPaise,
    totalPaise: totalBeforeRoundOffPaise + roundOffPaise,
  };
}
