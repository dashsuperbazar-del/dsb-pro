import type { ItemPurchasePrice } from '@dsb-pro/adapters';

// Line price per base (smallest) unit, so purchases in different units compare. It is the line price before
// any bill-level discount, extra charges or round-off. Paise, rounded for display only; nothing is stored or
// posted from it.
export type PricePoint = { date: string; perBasePaise: number; row: ItemPurchasePrice };

export function pricePoints(rows: ItemPurchasePrice[]): PricePoint[] {
  return (
    rows
      .filter((r) => r.baseQty > 0 && r.lineTotalPaise >= 0)
      .map((r) => ({
        date: r.businessDate,
        perBasePaise: Math.round(r.lineTotalPaise / r.baseQty),
        row: r,
      }))
      // Same business date: the bill entered later is the later purchase.
      .sort(
        (a, b) => a.date.localeCompare(b.date) || a.row.createdAt.localeCompare(b.row.createdAt),
      )
  );
}

export function priceSummary(points: PricePoint[]) {
  if (!points.length) return null;
  const values = points.map((p) => p.perBasePaise);
  const last = points[points.length - 1]!;
  const prev = points.length > 1 ? points[points.length - 2]! : null;
  return {
    last: last.perBasePaise,
    min: Math.min(...values),
    max: Math.max(...values),
    changeFromPrevious: prev ? last.perBasePaise - prev.perBasePaise : null,
  };
}

// Polyline coordinates in a W×H box with padding; a flat series sits in the middle.
export function chartPoints(points: PricePoint[], w = 320, h = 100, pad = 12) {
  if (points.length < 2) return [];
  const values = points.map((p) => p.perBasePaise);
  const min = Math.min(...values);
  const range = Math.max(...values) - min;
  return points.map((p, i) => ({
    x: pad + (i / (points.length - 1)) * (w - pad * 2),
    y: range === 0 ? h / 2 : pad + (h - pad * 2) * (1 - (p.perBasePaise - min) / range),
    point: p,
  }));
}
