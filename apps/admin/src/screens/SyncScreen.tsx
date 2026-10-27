import { errorText } from '../lib/friendlyError';
import { HomeRow } from '../components/HomeRow';
import { ScrollTable } from '../components/ScrollTable';
import { rupees } from '../lib/money';
import { friendlySaleName, saleStateLabel } from '../lib/saleDone';
import { useUserId } from '../lib/useUserId';
import { useEffect, useState } from 'preact/hooks';
import type { LocalSyncConflict } from '@dsb-pro/sync';
import { appRoute } from '../lib/paths';
import {
  forceRetryNow,
  getSyncDashboard,
  resolveConflictLocally,
  resolveConflictOnServer,
  runSyncNow,
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
      setError(errorText(e));
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
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function resolve(conflict: LocalSyncConflict) {
    await act(() => resolveConflictLocally(conflict));
  }
  const waiting = dashboard?.health.outboxCount ?? 0;
  const attention = dashboard
    ? dashboard.conflicts.filter((c) => c.status === 'OPEN').length +
      dashboard.serverConflicts.filter((c) => c.status === 'OPEN').length
    : 0;
  const online = dashboard?.state.online ?? true;
  const headline = !dashboard
    ? ''
    : attention > 0
      ? `${attention} ${attention === 1 ? 'item needs' : 'items need'} your attention`
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
        <a href={appRoute.home}>← Home</a>
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
                {attention} need attention
              </span>
            </div>
            <p class="muted">
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
          <HomeRow
            name="sync-local-conflicts"
            title="Needs review on this device"
            label="Sync conflicts"
            userId={userId}
            count={dashboard.conflicts.filter((c) => c.status === 'OPEN').length}
            tone={dashboard.conflicts.some((c) => c.status === 'OPEN') ? 'danger' : 'neutral'}
            summary="refused or changed after saving"
            forceOpen={dashboard.conflicts.some((c) => c.status === 'OPEN')}
          >
            {dashboard.conflicts.filter((c) => c.status === 'OPEN').length ? (
              <ul>
                {dashboard.conflicts
                  .filter((c) => c.status === 'OPEN')
                  .map((c) => (
                    <li>
                      <strong>{c.kind}</strong> · {c.target}
                      {c.clientId ? ' · ' + c.clientId : ''}
                      <br />
                      {c.reason}{' '}
                      <button disabled={busy} onClick={() => void resolve(c)}>
                        Mark reviewed locally
                      </button>
                    </li>
                  ))}
              </ul>
            ) : (
              <p>No open local conflicts.</p>
            )}
          </HomeRow>
          <HomeRow
            name="sync-server-conflicts"
            title="Shop-wide conflicts"
            label="Server sync conflicts"
            userId={userId}
            count={dashboard.serverConflicts.filter((c) => c.status === 'OPEN').length}
            tone={dashboard.serverConflicts.some((c) => c.status === 'OPEN') ? 'danger' : 'neutral'}
            summary="seen by every device"
            forceOpen={dashboard.serverConflicts.some((c) => c.status === 'OPEN')}
          >
            {dashboard.serverConflicts.filter((c) => c.status === 'OPEN').length ? (
              <ul>
                {dashboard.serverConflicts
                  .filter((c) => c.status === 'OPEN')
                  .map((c) => (
                    <li>
                      <strong>{c.kind}</strong> · {c.target}
                      {c.op_client_id ? ' · ' + c.op_client_id : ''}
                      <br />
                      {c.reason}{' '}
                      <button
                        disabled={busy}
                        onClick={() => void act(() => resolveConflictOnServer(c.id))}
                      >
                        Mark reviewed for shop
                      </button>
                    </li>
                  ))}
              </ul>
            ) : (
              <p>No open server conflicts visible to this account.</p>
            )}
          </HomeRow>
        </>
      )}
    </main>
  );
}
