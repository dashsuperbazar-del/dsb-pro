import { HomeRow } from '../components/HomeRow';
import { ScrollTable } from '../components/ScrollTable';
import { rupees } from '../lib/money';
import { friendlySaleName, saleStateLabel } from '../lib/saleDone';
import { useUserId } from '../lib/useUserId';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { SyncedItem } from '@dsb-pro/sync';
import { appRoute } from '../lib/paths';
import { ReviewCardView } from '../components/ReviewCardView';
import { BulkReviewDialog } from '../components/BulkReviewDialog';
import {
  buildReviewCards,
  groupReviewCards,
  hideServerIds,
  readHiddenServerIds,
  type ReviewCard,
} from '../lib/syncReview';
import {
  forceRetryNow,
  getOfflineItems,
  getSyncDashboard,
  markReviewed,
  renameAndCreateItem,
  runSyncNow,
  useExistingItem,
  updateCashierOfflinePolicy,
  waitForOfflineRuntime,
} from '../lib/offlineSync';

type Dashboard = Awaited<ReturnType<typeof getSyncDashboard>>;
const when = (value: number | null) => (value ? new Date(value).toLocaleString() : 'Never');

export function SyncScreen() {
  const userId = useUserId();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function refresh() {
    try {
      await waitForOfflineRuntime();
      setDashboard(await getSyncDashboard());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => {
    void refresh();
    const handler = () => void refresh();
    window.addEventListener('dsb-sync-state', handler);
    const timer = window.setInterval(handler, 2000);
    return () => {
      window.removeEventListener('dsb-sync-state', handler);
      window.clearInterval(timer);
    };
  }, []);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const [note, setNote] = useState('');
  const [catalog, setCatalog] = useState<SyncedItem[]>([]);
  const [catalogReady, setCatalogReady] = useState(false);
  const [bulk, setBulk] = useState<ReviewCard[] | null>(null);
  const [hiddenTick, setHiddenTick] = useState(0);
  const bulkOpener = useRef<HTMLElement | null>(null);
  const canShop = dashboard?.identity.role === 'owner' || dashboard?.identity.role === 'manager';
  const cards = dashboard
    ? buildReviewCards({
        conflicts: dashboard.conflicts,
        serverConflicts: dashboard.serverConflicts,
        items: dashboard.offlineItems,
        purchases: dashboard.purchases,
        billChanges: dashboard.billChanges,
        payments: dashboard.payments,
        sales: dashboard.sales,
        hiddenServerIds: readHiddenServerIds(dashboard.identity.userId),
      })
    : [];
  void hiddenTick;
  const needsCatalog = cards.some((c) => c.fix === 'item-name');
  useEffect(() => {
    if (!needsCatalog) return;
    void getOfflineItems().then(
      (rows) => {
        setCatalog(rows);
        setCatalogReady(true);
      },
      () => undefined,
    );
    // Read again with every refresh: the existing item may arrive with the next pull.
  }, [needsCatalog, dashboard]);
  // The existing item may not have reached this device yet: ask for one sync per card (never a loop).
  const pulled = useRef(new Set<string>());
  useEffect(() => {
    for (const c of cards) {
      const item = c.item;
      if (!catalogReady || c.fix !== 'item-name' || !item || pulled.current.has(c.key)) continue;
      if (
        catalog.some(
          (x) =>
            x.is_active && x.name.trim().toLowerCase() === item.fields.name.trim().toLowerCase(),
        )
      )
        continue;
      pulled.current.add(c.key);
      void runSyncNow().catch(() => undefined);
    }
  });
  const open = cards.filter((c) => c.state === 'open');
  const onHold = cards.filter((c) => c.state === 'held');
  async function clear(card: ReviewCard) {
    const r = await markReviewed({
      localIds: card.localIds,
      serverIds: card.serverIds,
      includeShop: Boolean(canShop),
    });
    hideServerIds(dashboard?.identity.userId, r.shopNotCleared);
    return r.shopNotCleared.length;
  }
  /** Reviews each card on its own: one failure never stops or hides the others. */
  async function review(list: readonly ReviewCard[]) {
    let cleared = 0;
    let failed = 0;
    let deviceOnly = 0;
    await act(async () => {
      for (const card of list) {
        try {
          if (await clear(card)) deviceOnly++;
          cleared++;
        } catch {
          failed++;
        }
      }
    });
    setHiddenTick((n) => n + 1);
    const base = failed
      ? `${cleared} cleared, ${failed} failed (still listed: try again).`
      : list.length === 1
        ? 'Marked reviewed.'
        : `Marked ${cleared} reviewed.`;
    setNote(
      `${base} Nothing was changed or posted.${
        deviceOnly
          ? canShop
            ? ' The shop-wide record could not be cleared (no connection); it is hidden here.'
            : ' Cleared on this device only: only the owner or a manager can clear it for the shop.'
          : ''
      }`,
    );
  }
  async function useExisting(card: ReviewCard, existing: SyncedItem, confirmed: boolean) {
    if (!card.clientId) return;
    const clientId = card.clientId;
    await act(async () => {
      const done = await useExistingItem(
        clientId,
        {
          itemId: existing.id,
          name: existing.name,
          unit1: existing.unit1,
          unit2: existing.unit2,
          unit3: existing.unit3,
          conv1: existing.conv1,
          conv2: existing.conv2,
        },
        confirmed,
      );
      if (done.kind === 'refused') {
        setNote(
          done.reason === 'units-differ'
            ? 'Not changed: the existing item has different units, so the bills stay on hold.'
            : 'Not changed: confirm that these are the same product first.',
        );
        return;
      }
      await clear(card);
      const moved = done.requeued.length;
      setNote(
        `Using '${existing.name}'. ${
          moved
            ? `${moved} waiting ${moved === 1 ? 'bill was' : 'bills were'} sent to sync again.`
            : ''
        }${
          done.notMoved.length
            ? ` ${done.notMoved.length} bill(s) may already have reached the server and were left as they are: check Purchases.`
            : ''
        }`.trim(),
      );
    });
    setHiddenTick((n) => n + 1);
  }
  async function rename(card: ReviewCard, name: string, ids: { clientId: string; itemId: string }) {
    if (!card.clientId) return;
    const clientId = card.clientId;
    await act(async () => {
      const done = await renameAndCreateItem(clientId, { ...ids, name });
      await clear(card);
      setNote(
        `Creating '${name}'. ${
          done.held.length
            ? 'The waiting bills stay on hold and are sent once it is created.'
            : 'It syncs next.'
        }`,
      );
    });
    setHiddenTick((n) => n + 1);
  }
  const waiting = dashboard?.health.outboxCount ?? 0;
  const attention = open.length;
  const online = dashboard?.state.online ?? true;
  const headline = !dashboard
    ? ''
    : attention > 0
      ? `${attention} ${attention === 1 ? 'needs' : 'need'} your attention`
      : onHold.length > 0
        ? `${onHold.length} on hold: reviewed, but still refused`
        : !online
          ? waiting > 0
            ? `Offline. ${waiting} waiting to send — saved on this device.`
            : 'Offline. Sales are saved on this device and sent when you are back online.'
          : waiting > 0
            ? `${waiting} waiting to send.`
            : 'All saved. Nothing waiting.';
  return (
    <main class="page wide">
      <p>
        <a class="back-home" href={appRoute.home}>
          ← Home
        </a>
      </p>
      <h1>Sync & offline</h1>
      {error && (
        <p role="alert" class="alert">
          {error}
        </p>
      )}
      {!dashboard ? (
        <p>Loading sync state…</p>
      ) : (
        <>
          <section
            class={`sync-summary ${attention > 0 ? 'attention' : waiting > 0 || !online ? 'waiting' : ''}`}
            aria-label="Sync health"
          >
            <h2 data-testid="sync-headline">{headline}</h2>
            <div class="sync-chips">
              <span class={`badge ${online ? 'success' : 'warning'}`}>
                {online ? 'Online' : 'Offline'}
              </span>
              <span class={`badge ${waiting > 0 ? 'warning' : ''}`} data-testid="sync-chip-waiting">
                {waiting} waiting
              </span>
              <span
                class={`badge ${attention > 0 ? 'danger' : ''}`}
                data-testid="sync-chip-attention"
              >
                {attention + onHold.length} need attention
              </span>
            </div>
            <p class="hint">
              Sales and bills saved on this device are sent to the shop when you are online.
              Anything the shop refuses stays here until you have looked at it.
            </p>
            {dashboard.health.clockDriftMs !== null && dashboard.health.clockDriftMs > 300000 && (
              <p class="alert">
                This device's clock is more than 5 minutes different from the shop's. Fix the device
                clock before relying on business dates.
              </p>
            )}
            {dashboard.state.lastError && (
              <p class="alert">Last sync issue: {dashboard.state.lastError}</p>
            )}
            <div class="row">
              <button
                class="primary"
                disabled={busy || dashboard.state.running}
                onClick={() => void act(runSyncNow)}
              >
                {dashboard.state.running ? 'Syncing…' : 'Sync now'}
              </button>
              <button disabled={busy} onClick={() => void act(forceRetryNow)}>
                Retry queued work now
              </button>
            </div>
          </section>
          {note && (
            <p role="status" class="alert success-note" data-testid="review-note">
              {note}
            </p>
          )}
          {cards.length > 0 ? (
            <>
              <div class="review-bar">
                <strong data-testid="review-count">
                  {open.length} to look at
                  {onHold.length > 0 &&
                    ` · ${onHold.length} on hold (${onHold.length === 1 ? 'bill or item is' : 'bills or items are'} still refused)`}
                </strong>
                {open.length > 0 && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={(e) => {
                      bulkOpener.current = e.currentTarget as HTMLElement;
                      setBulk(open);
                    }}
                  >
                    Mark all reviewed ({open.length})
                  </button>
                )}
              </div>
              {groupReviewCards(cards).map((g) => (
                <HomeRow
                  key={g.kind}
                  name={`sync-review-${g.kind}`}
                  title={g.title}
                  label={`Needs review: ${g.title}`}
                  userId={userId}
                  count={g.cards.length}
                  tone={g.cards.every((c) => c.state === 'held') ? 'warning' : 'danger'}
                  summary={
                    g.cards.every((c) => c.state === 'held')
                      ? 'reviewed, still on hold'
                      : 'needs your attention'
                  }
                  forceOpen
                >
                  <div class="review-list">
                    {g.cards.map((card) => (
                      <ReviewCardView
                        key={card.key}
                        card={card}
                        busy={busy}
                        canShop={Boolean(canShop)}
                        catalog={catalog}
                        onReview={(c) => void review([c])}
                        onUseExisting={(c, e, ok) => void useExisting(c, e, ok)}
                        onRename={(c, n, ids) => void rename(c, n, ids)}
                        onNeedExisting={() => void runSyncNow().catch(() => undefined)}
                      />
                    ))}
                  </div>
                </HomeRow>
              ))}
            </>
          ) : (
            <p class="review-empty" data-testid="review-empty">
              <strong>Nothing needs review</strong>
              Refused or changed items will show here with a way to fix them.
            </p>
          )}
          {bulk && (
            <BulkReviewDialog
              cards={bulk}
              busy={busy}
              canShop={Boolean(canShop)}
              onCancel={() => {
                setBulk(null);
                bulkOpener.current?.focus();
              }}
              onConfirm={() => {
                const list = bulk;
                setBulk(null);
                void review(list);
              }}
            />
          )}
          <HomeRow
            name="sync-details"
            title="Details"
            label="Sync details"
            userId={userId}
            count={null}
            tone="neutral"
            summary="counts, last sync, device clock"
          >
            <div class="sync-grid">
              <div>
                <strong>Network</strong>
                <br />
                {dashboard.state.online ? 'Online' : 'Offline'}
              </div>
              <div>
                <strong>Waiting to send</strong>
                <br />
                <span data-testid="sync-outbox-count">{dashboard.health.outboxCount}</span>
              </div>
              <div>
                <strong>Sales waiting</strong>
                <br />
                <span data-testid="sync-queued-sales">{dashboard.health.queuedSales}</span>
              </div>
              <div>
                <strong>Need review</strong>
                <br />
                <span data-testid="sync-conflict-count">{dashboard.health.conflictCount}</span>
              </div>
              <div>
                <strong>Last successful sync</strong>
                <br />
                {when(dashboard.health.lastSyncAt)}
              </div>
              <div>
                <strong>Device clock difference</strong>
                <br />
                {dashboard.health.clockDriftMs === null
                  ? 'Unknown'
                  : Math.round(dashboard.health.clockDriftMs / 1000) + ' sec'}
              </div>
            </div>
          </HomeRow>
          <HomeRow
            name="sync-cashier-policy"
            title="Cashiers billing offline"
            label="Offline billing for cashiers"
            userId={userId}
            count={null}
            tone="neutral"
            summary={dashboard.policy.allowCashierOfflineFinalization ? 'allowed' : 'not allowed'}
          >
            <p>
              Owner and manager billing may be saved offline. Cashier offline billing is{' '}
              <strong>
                {dashboard.policy.allowCashierOfflineFinalization ? 'allowed' : 'disabled'}
              </strong>
              .
            </p>
            {dashboard.identity.role === 'owner' && (
              <label>
                <input
                  type="checkbox"
                  checked={dashboard.policy.allowCashierOfflineFinalization}
                  onChange={(e) =>
                    void act(() =>
                      updateCashierOfflinePolicy((e.currentTarget as HTMLInputElement).checked),
                    )
                  }
                />{' '}
                Allow cashiers to finalize sales while offline
              </label>
            )}
          </HomeRow>
          <HomeRow
            name="sync-offline-sales"
            title="Sales saved on this device"
            label="Offline sales"
            userId={userId}
            count={dashboard.sales.length}
            tone={dashboard.sales.some((s) => s.status !== 'SYNCED') ? 'warning' : 'neutral'}
            summary={
              dashboard.sales.length
                ? `${dashboard.sales.filter((s) => s.status !== 'SYNCED').length} not synced`
                : 'none on this device'
            }
            forceOpen={dashboard.sales.some((s) => saleStateLabel(s) === 'needs review')}
          >
            {dashboard.sales.length ? (
              <ScrollTable class="mobile-records">
                <table>
                  <thead>
                    <tr>
                      <th>Sale</th>
                      <th>Status</th>
                      <th class="num">Total</th>
                      <th>Invoice</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard.sales.map((s) => {
                      const state = saleStateLabel(s);
                      return (
                        <tr key={s.clientId}>
                          <td class="record-title">
                            {friendlySaleName(s)}
                            <small class="muted" title={s.provisionalDocNo}>
                              {s.businessDate} · ref {s.provisionalDocNo.slice(0, 10)}
                            </small>
                          </td>
                          <td data-label="Status">
                            <span
                              class={`badge ${state === 'synced' ? 'success' : state === 'waiting' ? 'warning' : 'danger'}`}
                            >
                              {state}
                            </span>
                          </td>
                          <td data-label="Total" class="num">
                            {rupees(s.totalPaise)}
                          </td>
                          <td data-label="Invoice">{s.officialDocNo ?? 'Numbered after sync'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </ScrollTable>
            ) : (
              <p>No offline sales on this device.</p>
            )}
          </HomeRow>
        </>
      )}
    </main>
  );
}
