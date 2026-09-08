import { calculateLegacyDsbInvoiceTotals, type LegacyDsbCharge, type LegacyDsbLine } from './totals';

/** Shape of a legacy DSB invoice export required for Phase 2 reconciliation. */
export interface LegacyDsbInvoiceRecord {
  id: string;
  items: LegacyDsbLine[];
  extraCharges?: LegacyDsbCharge[];
  /** Stored legacy DSB grand total in rupees (DSB rounded to whole rupees). */
  grandTotal: number;
}

export interface LegacyDsbParityResult {
  id: string;
  expectedPaise: number;
  actualPaise: number;
  deltaPaise: number;
  matches: boolean;
}

export interface LegacyDsbParityReport {
  count: number;
  matches: number;
  mismatches: number;
  maxAbsDeltaPaise: number;
  passed: boolean;
  results: LegacyDsbParityResult[];
}

export function compareLegacyDsbInvoice(invoice: LegacyDsbInvoiceRecord): LegacyDsbParityResult {
  if (!invoice.id) throw new Error('legacy invoice id is required');
  if (!Array.isArray(invoice.items) || invoice.items.length === 0) throw new Error(`legacy invoice ${invoice.id} has no items`);
  if (!Number.isFinite(invoice.grandTotal)) throw new Error(`legacy invoice ${invoice.id} has invalid grandTotal`);

  const expectedPaise = Math.round(invoice.grandTotal * 100);
  const actualPaise = calculateLegacyDsbInvoiceTotals(invoice.items, invoice.extraCharges || []).grandTotalPaise;
  const deltaPaise = actualPaise - expectedPaise;
  return { id: invoice.id, expectedPaise, actualPaise, deltaPaise, matches: deltaPaise === 0 };
}

/**
 * Mechanical Phase 2 gate. The build plan requires at least 50 REAL DSB invoices
 * and exact paisa parity. Synthetic fixtures deliberately cannot satisfy this gate.
 */
export function compareLegacyDsbInvoices(invoices: LegacyDsbInvoiceRecord[], minimumRealInvoices = 50): LegacyDsbParityReport {
  if (!Number.isSafeInteger(minimumRealInvoices) || minimumRealInvoices <= 0) {
    throw new Error('minimumRealInvoices must be a positive integer');
  }
  const results = invoices.map(compareLegacyDsbInvoice);
  const matches = results.filter(result => result.matches).length;
  const mismatches = results.length - matches;
  const maxAbsDeltaPaise = results.reduce((max, result) => Math.max(max, Math.abs(result.deltaPaise)), 0);
  return {
    count: results.length,
    matches,
    mismatches,
    maxAbsDeltaPaise,
    passed: results.length >= minimumRealInvoices && mismatches === 0,
    results,
  };
}
