export interface InvoiceLineInput {
  qty: number;
  unitPricePaise: number;
  /** Discount in basis points: 100 = 1%, 10000 = 100%. */
  discountBps?: number;
  /** Informational only in DSB Pro: prices are final/all-inclusive. */
  taxRateBps?: number;
}

export interface ExtraChargeInput {
  name?: string;
  amountPaise: number;
}

export interface LineTotals {
  grossPaise: number;
  discountPaise: number;
  netPaise: number;
  taxRateBps: number;
}

export interface InvoiceTotals {
  subtotalPaise: number;
  discountPaise: number;
  extraChargesPaise: number;
  grandTotalPaise: number;
  lines: LineTotals[];
}

function assertMoney(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer paise value`);
}

function assertBps(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10000) throw new Error(`${name} must be an integer from 0 to 10000 basis points`);
}

export function percentToBasisPoints(percent: number): number {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('percent must be between 0 and 100');
  return Math.round(percent * 100);
}

export function calculateLineTotals(line: InvoiceLineInput): LineTotals {
  if (!Number.isFinite(line.qty) || line.qty <= 0) throw new Error('qty must be a finite positive number');
  assertMoney(line.unitPricePaise, 'unitPricePaise');
  const discountBps = line.discountBps ?? 0;
  const taxRateBps = line.taxRateBps ?? 0;
  assertBps(discountBps, 'discountBps');
  assertBps(taxRateBps, 'taxRateBps');

  // Quantity may be fractional, but money crosses the boundary exactly once here
  // and is integer paise from this point onward.
  const grossPaise = Math.round(line.qty * line.unitPricePaise);
  const discountPaise = Math.round(grossPaise * discountBps / 10000);
  const netPaise = grossPaise - discountPaise;
  return { grossPaise, discountPaise, netPaise, taxRateBps };
}

/**
 * DSB Pro canonical invoice rule: final prices are GST-inclusive. Tax rate is
 * retained for printing/reporting but is never added on top of the sale price.
 */
export function calculateInvoiceTotals(lines: InvoiceLineInput[], charges: ExtraChargeInput[] = []): InvoiceTotals {
  if (!lines.length) throw new Error('invoice must contain at least one line');
  const lineTotals = lines.map(calculateLineTotals);
  const subtotalPaise = lineTotals.reduce((sum, line) => sum + line.grossPaise, 0);
  const discountPaise = lineTotals.reduce((sum, line) => sum + line.discountPaise, 0);
  const extraChargesPaise = charges.reduce((sum, charge) => {
    assertMoney(charge.amountPaise, 'amountPaise');
    return sum + charge.amountPaise;
  }, 0);
  const grandTotalPaise = subtotalPaise - discountPaise + extraChargesPaise;
  if (!Number.isSafeInteger(grandTotalPaise)) throw new Error('grand total exceeds safe integer range');
  return { subtotalPaise, discountPaise, extraChargesPaise, grandTotalPaise, lines: lineTotals };
}

export interface LegacyDsbLine {
  qty: number;
  rate: number;
  disc?: number;
  gst?: number;
}

export interface LegacyDsbCharge {
  amount: number;
}

export interface LegacyDsbTotals {
  subtotalRupees: number;
  discountRupees: number;
  gstRupees: number;
  extraRupees: number;
  grandTotalRupees: number;
  grandTotalPaise: number;
}

/**
 * Historical reconciliation only. This mirrors DSB saveInvoice() byte-for-byte
 * in ordering: subtotal, percentage discount, GST on after-discount value,
 * extras, then Math.round() of the final RUPEE amount. Do not use for new DSB Pro
 * invoices because the locked plan says GST is informational/all-inclusive.
 */
export function calculateLegacyDsbInvoiceTotals(lines: LegacyDsbLine[], charges: LegacyDsbCharge[] = []): LegacyDsbTotals {
  const subtotalRupees = lines.reduce((sum, line) => sum + line.qty * line.rate, 0);
  const discountRupees = lines.reduce((sum, line) => sum + (line.qty * line.rate * (line.disc || 0) / 100), 0);
  const gstRupees = lines.reduce((sum, line) => {
    const afterDiscount = line.qty * line.rate * (1 - (line.disc || 0) / 100);
    return sum + afterDiscount * (line.gst || 0) / 100;
  }, 0);
  const extraRupees = charges.reduce((sum, charge) => sum + charge.amount, 0);
  const grandTotalRupees = Math.round(subtotalRupees - discountRupees + gstRupees + extraRupees);
  return {
    subtotalRupees,
    discountRupees,
    gstRupees,
    extraRupees,
    grandTotalRupees,
    grandTotalPaise: grandTotalRupees * 100,
  };
}
