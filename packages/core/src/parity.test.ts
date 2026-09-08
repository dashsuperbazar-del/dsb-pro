import { describe, expect, it } from 'vitest';
import { compareLegacyDsbInvoice, compareLegacyDsbInvoices } from './parity';

describe('legacy DSB invoice parity harness', () => {
  const invoice = {
    id: 'INV-REAL-SHAPE-1',
    items: [{ qty: 2, rate: 100, disc: 10, gst: 18 }, { qty: 3, rate: 50, gst: 5 }],
    extraCharges: [{ amount: 20 }],
    grandTotal: 390,
  };

  it('reports exact paisa parity', () => {
    expect(compareLegacyDsbInvoice(invoice)).toEqual({
      id: invoice.id,
      expectedPaise: 39000,
      actualPaise: 39000,
      deltaPaise: 0,
      matches: true,
    });
  });

  it('reports a mismatch without hiding the delta', () => {
    const result = compareLegacyDsbInvoice({ ...invoice, grandTotal: 391 });
    expect(result.matches).toBe(false);
    expect(result.deltaPaise).toBe(-100);
  });

  it('cannot pass the Phase 2 gate with fewer than 50 records', () => {
    const report = compareLegacyDsbInvoices(Array.from({ length: 49 }, (_, i) => ({ ...invoice, id: `INV-${i}` })));
    expect(report.count).toBe(49);
    expect(report.mismatches).toBe(0);
    expect(report.passed).toBe(false);
  });

  it('passes only with at least 50 exact matches', () => {
    const report = compareLegacyDsbInvoices(Array.from({ length: 50 }, (_, i) => ({ ...invoice, id: `INV-${i}` })));
    expect(report.count).toBe(50);
    expect(report.matches).toBe(50);
    expect(report.maxAbsDeltaPaise).toBe(0);
    expect(report.passed).toBe(true);
  });

  it('fails a 50-record run if even one invoice differs by a paisa', () => {
    const records = Array.from({ length: 50 }, (_, i) => ({ ...invoice, id: `INV-${i}` }));
    records[23] = { ...records[23], grandTotal: 390.01 };
    const report = compareLegacyDsbInvoices(records);
    expect(report.mismatches).toBe(1);
    expect(report.maxAbsDeltaPaise).toBe(1);
    expect(report.passed).toBe(false);
  });
});
