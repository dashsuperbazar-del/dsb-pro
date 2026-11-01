import { useEffect, useRef, useState } from 'preact/hooks';
import { unitDifferences, type SyncedItem } from '@dsb-pro/sync';
import { sameName, suggestRename, type ReviewCard } from '../lib/syncReview';
import './d9.css';

// One "needs review" card (D9): plain title and sentence, when/where, what is affected, the fix that fits,
// one "Mark reviewed", and the raw technical text only inside a collapsed "Details".

const when = (ms: number) => (ms ? new Date(ms).toLocaleString() : '');
const WHERE: Record<ReviewCard['where'], string> = {
  device: 'Seen on this device',
  shop: 'Recorded for the shop (another device or earlier)',
  both: 'On this device and recorded for the shop',
};

export function describeUnits(f: {
  unit1: string;
  unit2?: string | null;
  unit3?: string | null;
  conv1?: number | null;
  conv2?: number | null;
}) {
  const parts = [f.unit1];
  if (f.unit2) parts.push(`1 ${f.unit1} = ${f.conv1 ?? '?'} ${f.unit2}`);
  if (f.unit3) parts.push(`1 ${f.unit2 ?? ''} = ${f.conv2 ?? '?'} ${f.unit3}`);
  return parts.length === 1 ? `${f.unit1} only` : parts.join(' · ');
}
const gst = (bp: number | null | undefined) =>
  bp === null || bp === undefined ? 'not set' : `${bp / 100}%`;

export function ReviewCardView(props: {
  card: ReviewCard;
  busy: boolean;
  /** The user may also clear the shop-wide record (owner or manager). */
  canShop: boolean;
  catalog: readonly SyncedItem[];
  onReview: (card: ReviewCard) => void;
  onUseExisting: (card: ReviewCard, existing: SyncedItem, confirmed: boolean) => void;
  onRename: (card: ReviewCard, name: string, ids: { clientId: string; itemId: string }) => void;
  /** The existing item is not on this device yet: ask for a sync. */
  onNeedExisting?: () => void;
}) {
  const { card, busy, canShop } = props;
  const [panel, setPanel] = useState<'' | 'use' | 'rename'>('');
  const [same, setSame] = useState(false);
  const item = card.item;
  const existing = item
    ? (props.catalog.find((c) => c.is_active && sameName(c.name, item.fields.name)) ?? null)
    : null;
  const diffs = item && existing ? unitDifferences(item.fields, existing) : [];
  const missing = panel === 'use' && Boolean(item) && !existing;
  useEffect(() => {
    // While the panel waits for the existing item, ask for a sync now and then (never a tight loop).
    if (!missing || !props.onNeedExisting) return;
    props.onNeedExisting();
    const timer = window.setInterval(() => props.onNeedExisting?.(), 4000);
    return () => window.clearInterval(timer);
  }, [missing]);
  const held = card.state === 'held';
  const [name, setName] = useState(item ? suggestRename(item) : '');
  const ids = useRef<{ clientId: string; itemId: string } | null>(null);
  const clash = props.catalog.some((c) => c.is_active && sameName(c.name, name));
  const nameOk = name.trim() !== '' && !clash && !(item && sameName(name, item.fields.name));
  const shopNote = card.serverIds.length > 0 && !canShop;
  async function copy() {
    try {
      await navigator.clipboard.writeText(card.details.join('\n'));
    } catch {
      /* the text is selectable in the box */
    }
  }
  return (
    <article
      class="review-card"
      data-testid="review-card"
      data-kind={card.kind}
      aria-label={card.title}
    >
      <h3 class="review-title">{card.title}</h3>
      <p class="review-sentence">
        {card.sentence}
        {card.money && <span class="badge warning review-money">Involves money</span>}
      </p>
      <p class="review-meta">
        {held ? 'Reviewed. Still on hold: nothing was posted. ' : ''}
        {when(card.happenedAt)} · {WHERE[card.where]}
      </p>
      {card.affected.length > 0 && (
        <div class="review-affected">
          <strong>Bills waiting on this item</strong>
          <ul>
            {card.affected.map((a) => (
              <li>
                <a href={a.href}>{a.label}</a>
              </li>
            ))}
          </ul>
          <small class="muted">Nothing was posted for these.</small>
        </div>
      )}
      <div class="review-actions">
        {card.fix === 'item-name' && item && (
          <>
            <button
              type="button"
              class={panel === 'use' ? 'primary' : ''}
              aria-expanded={panel === 'use'}
              disabled={busy}
              onClick={() => setPanel(panel === 'use' ? '' : 'use')}
            >
              Use the existing item
            </button>
            <button
              type="button"
              aria-expanded={panel === 'rename'}
              disabled={busy}
              onClick={() => {
                setPanel(panel === 'rename' ? '' : 'rename');
                ids.current ??= { clientId: crypto.randomUUID(), itemId: crypto.randomUUID() };
              }}
            >
              Rename and create
            </button>
          </>
        )}
        {card.fix !== 'item-name' && card.link && (
          <a class="button-link primary" href={card.link.href}>
            {card.link.label}
          </a>
        )}
        {card.fix === 'item-name' && card.link && (
          <a class="button-link" href={card.link.href}>
            {card.link.label}
          </a>
        )}
        {!held && (
          <button type="button" disabled={busy} onClick={() => props.onReview(card)}>
            Mark reviewed
          </button>
        )}
      </div>
      {!held && (
        <p class="review-hint">
          Mark reviewed only hides this alert. Nothing is deleted, changed or posted.
          {shopNote &&
            ' Only the owner or a manager can clear it for the shop: this clears it on this device only.'}
        </p>
      )}
      {panel === 'use' && item && (
        <div class="review-panel" role="group" aria-label="Use the existing item">
          {existing ? (
            <>
              <div class="review-compare">
                <dl>
                  <dt class="review-col">Your new item (refused)</dt>
                  <dd>{item.fields.name}</dd>
                  <dd>{describeUnits(item.fields)}</dd>
                  <dd>GST {gst(item.fields.taxRateBp)}</dd>
                </dl>
                <dl>
                  <dt class="review-col">Existing item in the shop</dt>
                  <dd>{existing.name}</dd>
                  <dd>{describeUnits(existing)}</dd>
                  <dd>GST {gst(existing.tax_rate_bp)}</dd>
                </dl>
              </div>
              {diffs.length > 0 ? (
                <div role="alert" class="alert" data-testid="units-differ">
                  <strong>
                    The units are different, so these bills cannot use the existing item.
                  </strong>
                  <ul>
                    {diffs.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                  A quantity entered in the new item&apos;s unit would be posted in the existing
                  item&apos;s unit. Use &quot;Rename and create&quot; to keep your units, or correct
                  the bills in Purchases.
                </div>
              ) : (
                <>
                  <label class="review-confirm">
                    <input
                      type="checkbox"
                      checked={same}
                      onChange={(e) => setSame((e.currentTarget as HTMLInputElement).checked)}
                    />{' '}
                    These are the same product
                  </label>
                  <p class="review-hint">
                    The units match. Waiting bills will use the existing item.
                  </p>
                  <button
                    type="button"
                    class="primary"
                    disabled={busy || !same}
                    onClick={() => props.onUseExisting(card, existing, same)}
                  >
                    Use this item
                  </button>
                </>
              )}
            </>
          ) : (
            <p class="review-hint">
              The existing item is not on this device yet. Connect and press Sync now, then try
              again.
            </p>
          )}
        </div>
      )}
      {panel === 'rename' && item && (
        <div class="review-panel" role="group" aria-label="Rename and create">
          <label>
            New item name
            <input
              value={name}
              onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
              maxLength={120}
              autoComplete="off"
            />
          </label>
          <p class="review-hint">
            Suggestion: {suggestRename(item)}. The units stay as you entered them (
            {describeUnits(item.fields)}).
            {clash && ' An item with this name already exists: choose another name.'}
          </p>
          <button
            type="button"
            class="primary"
            disabled={busy || !nameOk}
            onClick={() => {
              ids.current ??= { clientId: crypto.randomUUID(), itemId: crypto.randomUUID() };
              props.onRename(card, name.trim(), ids.current);
            }}
          >
            Create with this name
          </button>
        </div>
      )}
      <details class="review-details">
        <summary>Details</summary>
        <pre class="review-raw">{card.details.join('\n')}</pre>
        <button type="button" class="small" onClick={() => void copy()}>
          Copy details
        </button>
      </details>
    </article>
  );
}
