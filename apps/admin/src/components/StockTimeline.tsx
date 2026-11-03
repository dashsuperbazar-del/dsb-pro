import { formatQuantity } from '@dsb-pro/core';
import { listItemStockTimeline, type StockTimelineRow } from '@dsb-pro/adapters';
import { useState } from 'preact/hooks';
import { errorText } from '../lib/friendlyError';

const LABEL: Record<string, string> = {
  PURCHASE: 'Purchase',
  PURCHASE_VOID: 'Purchase voided',
  PURCHASE_RETURN: 'Return to supplier',
  PURCHASE_RETURN_VOID: 'Supplier return voided',
  SUPPLIER_RETURN: 'Return to supplier',
  SALE: 'Sale',
  SALE_VOID: 'Sale voided',
  SALE_RETURN: 'Customer return',
  SALE_RETURN_VOID: 'Customer return voided',
  RETURN: 'Return',
  RETURN_TO_SELLABLE: 'Return back to stock',
  ADJUSTMENT: 'Stock adjust',
  COUNT_STOCK: 'Stock count',
  OPENING: 'Opening stock',
};
export const movementLabel = (t: string) => LABEL[t] ?? t.replace(/_/g, ' ').toLowerCase();

/** Old DSB "stock history": the item's latest movements, loaded only when opened. Display only. */
export function StockTimeline(props: { shopId: string; itemId: string; baseUnit: string }) {
  const [rows, setRows] = useState<StockTimelineRow[] | null>(null);
  const [error, setError] = useState('');
  function onToggle(e: Event) {
    if (!(e.currentTarget as HTMLDetailsElement).open || rows) return;
    listItemStockTimeline(props.shopId, props.itemId).then(setRows, (x: unknown) =>
      setError(errorText(x)),
    );
  }
  return (
    <details class="card" data-testid="stock-timeline" onToggle={onToggle}>
      <summary>Stock history</summary>
      {error && <p role="alert">{error}</p>}
      {!rows && !error && <p class="muted">Loading…</p>}
      {rows && rows.length === 0 && <p class="muted">No stock movements yet.</p>}
      {rows && rows.length > 0 && (
        <ul class="record-list">
          {rows.map((r, i) => (
            <li key={i}>
              <span>{new Date(r.at).toLocaleString()}</span> · {movementLabel(r.sourceType)} ·{' '}
              <strong class="num">
                {r.qtyBase > 0 ? '+' : ''}
                {formatQuantity(r.qtyBase)} {props.baseUnit}
              </strong>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
