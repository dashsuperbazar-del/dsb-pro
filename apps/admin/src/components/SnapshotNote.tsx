import { useEffect, useState } from 'preact/hooks';
import { snapshotAge } from '../lib/routeSnapshot';

// Shown while a screen displays its saved copy. While the fresh copy loads it says so; if the refresh failed
// it warns that the figures may be out of date. The age keeps ticking.
export function SnapshotNote({ at, failed = false }: { at: number | null; failed?: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (at === null) return;
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, [at]);
  if (at === null) return null;
  if (failed)
    return (
      <p class="alert" role="alert" data-testid="snapshot-note">
        Could not refresh. These figures are from {snapshotAge(at)} and may be out of date.
      </p>
    );
  return (
    <p class="muted" role="status" data-testid="snapshot-note">
      Showing the list from {snapshotAge(at)} · refreshing…
    </p>
  );
}
