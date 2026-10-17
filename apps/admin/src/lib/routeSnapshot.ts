import { getSession, onAuthStateChange } from '@dsb-pro/adapters';

// SP2: instant revisits. Old DSB rendered every screen from memory; Pro waited on the network every time.
// A screen now shows its last successful list immediately (labelled with its age) and refreshes in the
// background. Snapshots are DISPLAY data only: anything that moves money or stock still reads fresh data
// first. They live in this tab's memory only (nothing on disk), are keyed by signed-in user and shop, and
// are dropped on any sign-in change.
export type Snapshot<T> = { userId: string; shopId: string; at: number; value: T };

const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const store = new Map<string, Snapshot<unknown>>();
let wired = false;

function wire() {
  if (wired) return;
  try {
    onAuthStateChange(() => store.clear());
    wired = true;
  } catch {
    // no auth client yet (tests, signed-out boot); keys still carry the user id
  }
}

export function putSnapshot<T>(
  name: string,
  userId: string,
  shopId: string,
  value: T,
  now = Date.now(),
) {
  wire();
  if (!userId || !shopId) return;
  store.set(name, { userId, shopId, at: now, value });
}

/** The last snapshot of `name` for this user (and shop, when known), or null. */
export function peekSnapshot<T>(
  name: string,
  userId: string,
  shopId?: string,
  now = Date.now(),
): Snapshot<T> | null {
  wire();
  const s = store.get(name) as Snapshot<T> | undefined;
  if (!s || !userId || s.userId !== userId) return null;
  if (shopId && s.shopId !== shopId) return null;
  if (now - s.at > MAX_AGE_MS) {
    store.delete(name);
    return null;
  }
  return s;
}

export function dropSnapshot(name: string) {
  store.delete(name);
}
export function clearSnapshots() {
  store.clear();
}

export function snapshotAge(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

/** The signed-in user id from the local session, or '' (never throws; no snapshot is shown for ''). */
export async function snapshotUserId(): Promise<string> {
  try {
    return (await getSession())?.user.id ?? '';
  } catch {
    return '';
  }
}
