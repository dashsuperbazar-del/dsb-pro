import { describe, expect, it } from 'vitest';
import { invariantLabel, invariantRows } from './invariants';

describe('D4a invariant rows', () => {
  it('lists every numeric check except ok, including unknown new ones', () => {
    const rows = invariantRows({
      ok: false,
      saleTotalViolations: 0,
      settlementViolations: 2,
      brandNewCheckViolations: 1,
      note: 'x',
      flag: true,
    });
    expect(rows).toEqual([
      { code: 'saleTotalViolations', count: 0 },
      { code: 'settlementViolations', count: 2 },
      { code: 'brandNewCheckViolations', count: 1 },
    ]);
  });
  it('gives known codes a label and unknown codes a readable fallback', () => {
    expect(invariantLabel('settlementViolations')).toBe('Opening settlements');
    expect(invariantLabel('brandNewCheckViolations')).toBe('Brand New Check');
  });
  it('treats a malformed payload as no rows', () => {
    expect(invariantRows(null)).toEqual([]);
    expect(invariantRows('bad')).toEqual([]);
  });
});
