import { useEffect, useState } from 'preact/hooks';
import {
  getDayBook,
  getDefaultShopId,
  getShopBusinessDate,
  listItems,
  type DayBookRow,
} from '@dsb-pro/adapters';
import { appRoute } from '../lib/paths';
import { rupees } from '../lib/money';
import { peekSnapshot, putSnapshot, snapshotUserId } from '../lib/routeSnapshot';

type DaySnapshot = { date: string; row: DayBookRow | null };
const clock = (at: number) =>
  new Date(at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
const isZero = (r: DayBookRow | null) =>
  !r ||
  [r.sales_paise, r.receipts_paise, r.payments_paise, r.expenses_paise, r.net_cashflow_paise].every(
    (n) => Number(n) === 0,
  );

// Home tile: today's day book at a glance (server figures; nothing computed locally).
// Each figure is an old-DSB style stat card; its tone is fixed per figure, never derived from the amount,
// except that a negative net money flow is written in red text on the same neutral panel (never green).
// When the read fails the last saved figures are shown with a calm amber note and their time.
export function DayBookTile({ onRefresh, rev = 0 }: { onRefresh?: () => void; rev?: number } = {}) {
  const [date, setDate] = useState('');
  const [row, setRow] = useState<DayBookRow | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);
  const [stale, setStale] = useState(false);
  const [firstRun, setFirstRun] = useState(false);
  const [local, setLocal] = useState(0);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const userId = await snapshotUserId();
      let snap = peekSnapshot<DaySnapshot>('daybook', userId);
      // Last visit's figures show at once (marked as saved) while the fresh read is on its way.
      if (snap && alive) {
        setDate(snap.value.date);
        setRow(snap.value.row);
        setUpdatedAt(snap.at);
        setSaved(true);
        setStale(false);
        setLoaded(true);
      }
      try {
        const shop = await getDefaultShopId();
        const d = await getShopBusinessDate(shop);
        const r = (await getDayBook(shop, d, d))[0] ?? null;
        if (!alive) return;
        putSnapshot<DaySnapshot>('daybook', userId, shop, { date: d, row: r });
        setDate(d);
        setRow(r);
        setSaved(false);
        setStale(false);
        setError('');
        setUpdatedAt(Date.now());
        setLoaded(true);
        // A brand-new shop (no figures today and no items yet) gets a setup checklist, not zero tiles.
        if (isZero(r)) {
          try {
            const items = await listItems();
            if (alive) setFirstRun(items.length === 0);
          } catch {
            if (alive) setFirstRun(false);
          }
        } else setFirstRun(false);
      } catch (e) {
        if (!alive) return;
        // The disk copy may have been read just after the first look: try once more.
        snap = snap ?? peekSnapshot<DaySnapshot>('daybook', userId);
        if (snap) {
          setDate(snap.value.date);
          setRow(snap.value.row);
          setUpdatedAt(snap.at);
          setSaved(true);
          setStale(true);
          setError('');
          setLoaded(true);
          setFirstRun(false);
        } else setError(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [rev, local]);
  if (error)
    return (
      <section class="card daybook-tile daybook-error" aria-label="Day book today">
        <p role="alert">
          Today’s totals are unavailable. <a href={appRoute.reports}>Open reports</a>
        </p>
      </section>
    );
  if (loaded && firstRun)
    return (
      <section class="card daybook-tile daybook-firstrun" aria-label="Day book today">
        <h2>Set up your shop</h2>
        <p class="muted">Nothing recorded yet. Three steps and you are ready for the first bill.</p>
        <ol class="firstrun-steps">
          <li>
            <a href={appRoute.inventory}>Add items</a>
          </li>
          <li>
            <a href={appRoute.suppliers}>Add suppliers</a>
          </li>
          <li>
            <a href={appRoute.pos}>Make your first sale</a>
          </li>
        </ol>
      </section>
    );
  const v = (k: keyof Omit<DayBookRow, 'business_date'>) =>
    loaded ? rupees(row ? row[k] : 0) : '—';
  const negative = Number(row?.net_cashflow_paise ?? 0) < 0;
  return (
    <section class="card daybook-tile" aria-label="Day book today">
      <h2>Today {date && `· ${date}`}</h2>
      <dl class="tiles">
        <div class="stat tone-accent">
          <dt>Net sales</dt>
          <dd>{v('sales_paise')}</dd>
        </div>
        <div class="stat tone-success">
          <dt>Received</dt>
          <dd>{v('receipts_paise')}</dd>
        </div>
        <div class="stat">
          <dt>Paid out</dt>
          <dd>{v('payments_paise')}</dd>
        </div>
        <div class="stat">
          <dt>Expenses</dt>
          <dd>{v('expenses_paise')}</dd>
        </div>
        <div class={`stat daybook-net${negative ? ' negative' : ''}`}>
          <dt>Net money flow</dt>
          <dd>{v('net_cashflow_paise')}</dd>
        </div>
      </dl>
      {saved && updatedAt !== null && stale && (
        <p class="banner warning" role="status" data-testid="daybook-saved">
          Showing saved figures from {clock(updatedAt)}. They update when you are back online.
        </p>
      )}
      {saved && updatedAt !== null && !stale && (
        <p class="muted" role="status" data-testid="daybook-refreshing">
          Saved figures from {clock(updatedAt)} · updating…
        </p>
      )}
      <div class="daybook-foot">
        <a class="daybook-link" href={appRoute.reports}>
          Full day book
        </a>
        {updatedAt !== null && !saved && (
          <span class="muted" data-testid="daybook-updated">
            Updated {clock(updatedAt)}
          </span>
        )}
        <button
          type="button"
          class="daybook-refresh"
          onClick={() => {
            setLocal((n) => n + 1);
            onRefresh?.();
          }}
        >
          Refresh
        </button>
      </div>
    </section>
  );
}
