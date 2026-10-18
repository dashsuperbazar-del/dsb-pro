import { getSession, onAuthStateChange } from '@dsb-pro/adapters';
import { openRouteSnapshotDb, type RouteSnapshotDb, type RouteSnapshotRow } from '@dsb-pro/sync';

// SP2: instant revisits. Old DSB rendered every screen from memory; Pro waited on the network every time.
// A screen now shows its last successful list immediately (labelled with its age) and refreshes in the
// background. Snapshots are DISPLAY data only: anything that moves money or stock still reads fresh data
// first. They are keyed by signed-in user and shop, and memory is dropped on any sign-in change.
// SP4: snapshots are also kept in IndexedDB so a cold start shows them at once. Disk rows carry the user
// id; only the signed-in user's rows are ever loaded, and rows of anyone else are wiped on sign-out, on an
// auth event for another user, on every write and at startup. Each row and the total are capped (oldest
// evicted) and unreadable rows are ignored. Disk failures are silent: the screen just loads fresh.
export type Snapshot<T> = { userId: string; shopId: string; at: number; value: T };

const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const MAX_ROW_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 4_000_000;
const HYDRATE_TIMEOUT_MS = 1500;
const store = new Map<string, Snapshot<unknown>>();
let wired = false;
let hydratedFor: string | null = null;
let epoch = 0;
let queue: Promise<void> = Promise.resolve();

function hasDisk() {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}
/** Serialized disk work; never rejects. */
function disk(op: (db: RouteSnapshotDb) => Promise<unknown>): Promise<void> {
  if (!hasDisk()) return queue;
  queue = queue.then(async () => {
    try {
      await op(await openRouteSnapshotDb());
    } catch {
      // display cache only: ignore
    }
  });
  return queue;
}
/** Resolves once queued disk writes and wipes have finished. */
export function snapshotDiskIdle(): Promise<void> {
  return queue;
}

function wire() {
  if (wired) return;
  try {
    onAuthStateChange((session) => {
      store.clear();
      hydratedFor = null;
      epoch++;
      const uid = session?.user?.id ?? '';
      void disk((db) =>
        uid ? db.snapshots.where('userId').notEqual(uid).delete() : db.snapshots.clear(),
      );
    });
    wired = true;
  } catch {
    // no auth client yet (tests, signed-out boot); keys still carry the user id
  }
}

function persist(name: string, snap: Snapshot<unknown>) {
  let json: string;
  try {
    json = JSON.stringify(snap.value) ?? '';
  } catch {
    json = '';
  }
  const key = `${snap.userId}:${name}`;
  if (!json || json.length > MAX_ROW_BYTES) {
    // never let an older disk copy outlive a newer value that could not be stored
    void disk((db) => db.snapshots.delete(key));
    return;
  }
  const row: RouteSnapshotRow = {
    key,
    userId: snap.userId,
    name,
    shopId: snap.shopId,
    at: snap.at,
    json,
    size: json.length,
  };
  void disk((db) =>
    db.transaction('rw', db.snapshots, async () => {
      await db.snapshots.where('userId').notEqual(row.userId).delete();
      await db.snapshots.put(row);
      const rows = await db.snapshots.orderBy('at').toArray();
      let total = rows.reduce((t, r) => t + (Number(r.size) || 0), 0);
      for (const r of rows) {
        if (total <= MAX_TOTAL_BYTES) break;
        await db.snapshots.delete(r.key);
        total -= Number(r.size) || 0;
      }
    }),
  );
}

function readRow(r: RouteSnapshotRow, userId: string, now: number): Snapshot<unknown> | null {
  if (!r || r.userId !== userId || typeof r.name !== 'string' || !r.name) return null;
  if (typeof r.shopId !== 'string' || !r.shopId) return null;
  if (typeof r.at !== 'number' || !Number.isFinite(r.at)) return null;
  if (r.at > now + 60_000 || now - r.at > MAX_AGE_MS) return null;
  if (typeof r.json !== 'string' || r.json.length > MAX_ROW_BYTES) return null;
  try {
    return { userId, shopId: r.shopId, at: r.at, value: JSON.parse(r.json) as unknown };
  } catch {
    return null;
  }
}

/** Loads this user's disk snapshots into memory once per sign-in; wipes everyone else's. */
async function hydrate(userId: string): Promise<void> {
  if (!hasDisk() || hydratedFor === userId) return;
  const e = epoch;
  if (!userId) {
    await disk((db) => db.snapshots.clear());
    return;
  }
  const found: RouteSnapshotRow[] = [];
  const work = disk(async (db) => {
    await db.snapshots.where('userId').notEqual(userId).delete();
    found.push(...(await db.snapshots.where('userId').equals(userId).toArray()));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise((r) => (timer = setTimeout(r, HYDRATE_TIMEOUT_MS)))]);
  clearTimeout(timer);
  if (e !== epoch) return; // a sign-in change happened meanwhile: show nothing from before it
  const now = Date.now();
  for (const r of found) {
    const s = readRow(r, userId, now);
    if (!s) continue;
    const cur = store.get(r.name);
    if (cur && cur.userId === userId && cur.at >= s.at) continue;
    store.set(r.name, s);
  }
  hydratedFor = userId;
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
  const snap = { userId, shopId, at: now, value };
  store.set(name, snap);
  persist(name, snap);
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
  void disk((db) => db.snapshots.filter((r) => r.name === name).delete());
}
export function clearSnapshots() {
  store.clear();
  hydratedFor = null;
  epoch++;
  void disk((db) => db.snapshots.clear());
}
/** Drops memory only, as closing the tab does. */
export function forgetSnapshotsInMemory() {
  store.clear();
  hydratedFor = null;
}

export function snapshotAge(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

/**
 * The signed-in user id from the local session, or '' (never throws; no snapshot is shown for '').
 * SP4: on the first call after a cold start it also loads that user's saved snapshots from disk.
 */
export async function snapshotUserId(): Promise<string> {
  wire();
  let userId: string;
  try {
    userId = (await getSession())?.user.id ?? '';
  } catch {
    return '';
  }
  await hydrate(userId);
  return userId;
}
