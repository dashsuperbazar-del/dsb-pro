import { describe, expect, it } from 'vitest';
import { chartPoints, pricePoints, priceSummary } from './priceHistory';

const row = (date: string, baseQty: number, lineTotalPaise: number) =>
  ({
    billId: date,
    businessDate: date,
    partyId: null,
    unitName: 'case',
    unitLevel: 1,
    qty: 1,
    baseQty,
    unitPricePaise: lineTotalPaise,
    lineTotalPaise,
  }) as never;

describe('price history', () => {
  it('compares purchases in different units by cost per base unit, oldest first', () => {
    const pts = pricePoints([row('2026-10-05', 12, 1200), row('2026-10-01', 24, 2160)]);
    expect(pts.map((p) => [p.date, p.perBasePaise])).toEqual([
      ['2026-10-01', 90],
      ['2026-10-05', 100],
    ]);
    expect(priceSummary(pts)).toEqual({ last: 100, min: 90, max: 100, changeFromPrevious: 10 });
  });
  it('ignores rows without a base quantity and handles empty or single histories', () => {
    expect(pricePoints([row('2026-10-01', 0, 100)])).toEqual([]);
    expect(priceSummary([])).toBeNull();
    const one = pricePoints([row('2026-10-01', 2, 100)]);
    expect(priceSummary(one)?.changeFromPrevious).toBeNull();
    expect(chartPoints(one)).toEqual([]);
  });
  it('draws a flat series in the middle and spans the width', () => {
    const pts = chartPoints(pricePoints([row('2026-10-01', 1, 50), row('2026-10-02', 1, 50)]));
    expect(pts.map((p) => p.y)).toEqual([50, 50]);
    expect(pts[0]!.x).toBe(12);
    expect(pts[1]!.x).toBe(308);
  });
});
