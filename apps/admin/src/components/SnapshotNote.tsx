import { snapshotAge } from '../lib/routeSnapshot';

// Shown while a screen displays its saved copy and the fresh one is still loading.
export function SnapshotNote({ at }: { at: number | null }) {
  if (at === null) return null;
  return (
    <p class="muted" role="status" data-testid="snapshot-note">
      Showing the list from {snapshotAge(at)} · refreshing…
    </p>
  );
}
