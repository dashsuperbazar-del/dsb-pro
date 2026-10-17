import { useEffect, useState } from 'preact/hooks';
import { listItemPurchasePrices, type ItemPurchasePrice, type Party } from '@dsb-pro/adapters';
import { chartPoints, pricePoints, priceSummary } from '../lib/priceHistory';
import { rupees } from '../lib/money';

// I08: recent purchase cost of an item, per base unit, with a small trend line. Read-only.
export function PriceHistory(props: {
  shopId: string;
  itemId: string;
  baseUnit: string;
  parties: Party[];
}) {
  const { shopId, itemId } = props;
  const [rows, setRows] = useState<ItemPurchasePrice[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setRows(null);
    setError('');
    if (!shopId || !itemId) return;
    listItemPurchasePrices(shopId, itemId).then(
      (r) => alive && setRows(r),
      (e) => alive && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
  }, [shopId, itemId]);

  if (error) return <p class="muted">Purchase price history is unavailable right now.</p>;
  if (rows === null) return <p class="muted">Loading purchase prices…</p>;
  const points = pricePoints(rows);
  const summary = priceSummary(points);
  if (!summary) return <p class="muted">No purchases of this item yet.</p>;
  const pts = chartPoints(points);
  const name = (id: string | null) => props.parties.find((p) => p.id === id)?.name ?? 'No supplier';
  return (
    <section aria-label="Purchase price history" class="price-history">
      <p>
        Last cost {rupees(summary.last)} per {props.baseUnit}
        {summary.changeFromPrevious !== null && summary.changeFromPrevious !== 0 && (
          <>
            {' '}
            ({summary.changeFromPrevious > 0 ? 'up' : 'down'}{' '}
            {rupees(Math.abs(summary.changeFromPrevious))})
          </>
        )}{' '}
        · range {rupees(summary.min)}–{rupees(summary.max)}
      </p>
      {pts.length > 1 && (
        <svg viewBox="0 0 320 100" role="img" aria-label="Purchase cost trend" class="price-chart">
          <polyline
            points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          />
          {pts.map((p) => (
            <circle key={p.point.row.billId + p.x} cx={p.x} cy={p.y} r="3" fill="currentColor">
              <title>
                {p.point.date}: {rupees(p.point.perBasePaise)} per {props.baseUnit}
              </title>
            </circle>
          ))}
        </svg>
      )}
      <ul>
        {[...points]
          .reverse()
          .slice(0, 5)
          .map((p) => (
            <li key={p.row.billId + p.row.unitLevel + p.row.qty}>
              {p.date} · {name(p.row.partyId)} · {p.row.qty} {p.row.unitName} at{' '}
              {rupees(p.row.unitPricePaise)} = {rupees(p.perBasePaise)} per {props.baseUnit}
            </li>
          ))}
      </ul>
    </section>
  );
}
