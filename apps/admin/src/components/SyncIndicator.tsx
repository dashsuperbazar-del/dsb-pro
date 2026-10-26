import { useEffect, useState } from 'preact/hooks';
import { appRoute } from '../lib/paths';
import { getLocalSyncSummary, type LocalSyncSummary } from '../lib/offlineSync';

// Header pill: Online / Offline / Syncing N / N need attention. Reads only this device's existing sync
// state (runtime flags + local outbox/conflict counts); it never starts a sync or calls the server.
export function syncLabel(s: LocalSyncSummary): { text: string; tone: string } {
  if (s.conflicts > 0)
    return {
      text: `${s.conflicts} need${s.conflicts === 1 ? 's' : ''} attention`,
      tone: 'attention',
    };
  if (!s.online) return { text: s.pending ? `Offline · ${s.pending}` : 'Offline', tone: 'offline' };
  if (s.pending > 0) return { text: `Syncing ${s.pending}`, tone: 'syncing' };
  return { text: 'Online', tone: 'online' };
}
export function SyncIndicator() {
  const [summary, setSummary] = useState<LocalSyncSummary | null>(null);
  useEffect(() => {
    let alive = true;
    const read = () =>
      void getLocalSyncSummary().then(
        (s) => alive && setSummary(s),
        () => undefined,
      );
    read();
    window.addEventListener('dsb-sync-state', read);
    window.addEventListener('online', read);
    window.addEventListener('offline', read);
    const timer = window.setInterval(read, 5000);
    return () => {
      alive = false;
      window.removeEventListener('dsb-sync-state', read);
      window.removeEventListener('online', read);
      window.removeEventListener('offline', read);
      window.clearInterval(timer);
    };
  }, []);
  if (!summary) return null;
  const { text, tone } = syncLabel(summary);
  return (
    <a class="sync-pill" data-tone={tone} href={appRoute.sync} title="Sync & offline status">
      <span class="dot" aria-hidden="true" />
      <span>{text}</span>
    </a>
  );
}
