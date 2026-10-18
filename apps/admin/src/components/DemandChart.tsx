import { useEffect, useState } from 'preact/hooks';
import { listItemSaleMovements, type ItemSaleMovements } from '@dsb-pro/adapters';
import { formatQty, sinceDate, weeklyDemand } from '../lib/demand';

const WEEKS = 8;
const W = 320;
const H = 80;

// I08: units sold per week (net of confirmed returns) for the last 8 weeks. Read-only; loads when shown.
export function DemandChart(props: {
  shopId: string;
  itemId: string;
  baseUnit: string;
  today: string;
}) {
  const { shopId, itemId, today } = props;
  const [data, setData] = useState<ItemSaleMovements | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setData(null);
    setError('');
    if (!shopId || !itemId) return;
    listItemSaleMovements(shopId, itemId, sinceDate(today, WEEKS)).then(
      (r) => alive && setData(r),
      (e) => alive && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
  }, [shopId, itemId, today]);

  if (error) return <p class="muted">Sales history is unavailable right now.</p>;
  if (data === null) return <p class="muted">Loading sales…</p>;
  let weeks;
  try {
    weeks = weeklyDemand(data, today, WEEKS);
  } catch {
    return <p class="muted">Sales history is unavailable right now.</p>;
  }
  if (!data.sales.length && !data.returns.length)
    return <p class="muted">No sales of this item in the last {WEEKS} weeks.</p>;
  const total = weeks.reduce((s, w) => s + w.netMicro, 0);
  const max = Math.max(1, ...weeks.map((w) => w.netMicro));
  const slot = W / WEEKS;
  const label = `Units sold per week: ${formatQty(total)} ${props.baseUnit} over ${WEEKS} weeks, ${weeks
    .map((w) => formatQty(w.netMicro))
    .join(', ')} (oldest first)`;
  return (
    <section aria-label="Weekly demand" class="demand-chart">
      <p>
        Sold in last {WEEKS} weeks: {formatQty(total)} {props.baseUnit} (net of returns)
      </p>
      {data.truncated && <p class="muted">Very many sales: older weeks may be incomplete.</p>}
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} class="price-chart">
        {weeks.map((w, i) => {
          const h = w.netMicro > 0 ? Math.max(1, (w.netMicro / max) * (H - 4)) : 0;
          return (
            <rect
              key={w.start}
              x={i * slot + 4}
              y={H - h}
              width={slot - 8}
              height={h}
              fill="currentColor"
            >
              <title>
                {w.start} to {w.end}: {formatQty(w.netMicro)} {props.baseUnit}
              </title>
            </rect>
          );
        })}
      </svg>
      <details>
        <summary>Weekly figures</summary>
        <ul>
          {[...weeks].reverse().map((w) => (
            <li key={w.start}>
              {w.start} to {w.end}: {formatQty(w.netMicro)} {props.baseUnit}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
