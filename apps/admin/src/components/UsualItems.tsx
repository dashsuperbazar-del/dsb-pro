import { useState } from 'preact/hooks';
import { percentText } from '../lib/billExtras';
import { rupees } from '../lib/money';
import type { UsualItem } from '../lib/usualItems';

export type UsualLoad =
  { state: 'loading' } | { state: 'failed'; message: string } | { state: 'ok'; rows: UsualItem[] };

const FILTER_FROM = 15;

// "Usual items from <supplier>": the items bought from this supplier before, most often bought first.
// Tick today's items, then "Add N items": one row each with the last unit and rate (a suggestion to
// check) and an EMPTY quantity. Items already on the bill are shown as added and cannot be ticked.
export function UsualItems(props: {
  supplierName: string;
  load: UsualLoad;
  onBill: Set<string>;
  open: boolean;
  onToggle: () => void;
  onAdd: (rows: UsualItem[]) => void;
  onRetry: () => void;
  onRepeat?: () => void;
  disabled?: boolean;
}) {
  const { load, onBill, disabled } = props;
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const rows = load.state === 'ok' ? load.rows : [];
  const chosen = rows.filter((r) => picked.includes(r.itemId) && !onBill.has(r.itemId));
  const shown = filter.trim()
    ? rows.filter((r) => r.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : rows;
  return (
    <div class="usual-items" role="group" aria-label="Usual items">
      <div class="usual-head">
        <button
          type="button"
          class="usual-toggle"
          aria-expanded={props.open}
          disabled={disabled}
          onClick={props.onToggle}
        >
          Usual items from {props.supplierName}
          {load.state === 'ok' ? ` (${rows.length})` : ''}
        </button>
        {props.onRepeat && (
          <button type="button" class="link" disabled={disabled} onClick={props.onRepeat}>
            ↺ Repeat last bill
          </button>
        )}
      </div>
      {props.open &&
        (load.state === 'loading' ? (
          <p class="muted">Reading this supplier's bills…</p>
        ) : load.state === 'failed' ? (
          <p class="alert" role="alert">
            Usual items could not be read: {load.message}{' '}
            <button type="button" disabled={disabled} onClick={props.onRetry}>
              Try again
            </button>
          </p>
        ) : !rows.length ? (
          <p class="muted">No earlier bills from this supplier.</p>
        ) : (
          <>
            {rows.length > FILTER_FROM && (
              <input
                type="search"
                aria-label="Filter usual items"
                placeholder="Filter items"
                value={filter}
                onInput={(e) => setFilter(e.currentTarget.value)}
              />
            )}
            <ul class="usual-list">
              {shown.map((r) => {
                const added = onBill.has(r.itemId);
                const extra = [
                  r.discountBp ? `−${percentText(r.discountBp)}%` : '',
                  r.gstBp !== null ? `+${percentText(r.gstBp)}% GST` : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <li key={r.itemId}>
                    <label class={added ? 'usual-row added' : 'usual-row'}>
                      <input
                        type="checkbox"
                        aria-label={`${r.name}${added ? ' (on the bill)' : ''}`}
                        checked={added || picked.includes(r.itemId)}
                        disabled={disabled || added}
                        // onClick, not onChange: another click handler on the page may re-render
                        // before "change" fires, which would undo the tick of a controlled box.
                        onClick={(e) => {
                          const on = e.currentTarget.checked;
                          setPicked((p) =>
                            on ? [...p, r.itemId] : p.filter((id) => id !== r.itemId),
                          );
                        }}
                      />
                      <span class="usual-name">{r.name}</span>
                      <small class="muted">
                        {r.unitName} · {rupees(r.unitPricePaise)}
                        {extra ? ` · ${extra}` : ''} · {r.lastDate}
                        {added ? ' · added' : ''}
                      </small>
                    </label>
                  </li>
                );
              })}
            </ul>
            <button
              type="button"
              class="primary usual-add"
              disabled={disabled || !chosen.length}
              onClick={() => {
                props.onAdd(chosen);
                setPicked([]);
                setFilter('');
              }}
            >
              {chosen.length
                ? `Add ${chosen.length} item${chosen.length === 1 ? '' : 's'}`
                : 'Tick the items on this bill'}
            </button>
          </>
        ))}
    </div>
  );
}
