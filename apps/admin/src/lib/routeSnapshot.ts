import { getSession, onAuthStateChange } from '@dsb-pro/adapters';
import { openRouteSnapshotDb, type RouteSnapshotDb, type RouteSnapshotRow } from '@dsb-pro/sync';

// SP2: instant revisits. Old DSB rendered every screen from memory; Pro waited on the network every time.
// A screen now shows its last successful list immediately (labelled with its age) and refreshes in the
// background. Snapshots are DISPLAY data only: anything that moves money or stock still reads fresh data
// first. They are keyed by signed-in user and shop.
// SP4: snapshots are also kept in IndexedDB so a cold start shows them at once.
// - Only the signed-in user's rows are loaded; a change of signed-in user (auth event or session read)
//   drops memory and wipes every other user's rows (sign-out wipes all). Token refreshes change nothing.
// - A write is refused unless it belongs to the user signed in now, checked again when it reaches disk,
//   so a fetch that finishes after sign-out or a user switch never re-stores the old user's figures.
// - A peek only shows a snapshot of the active shop (the last shop this user saw, or the one the screen
//   names); shops dropped from the user's membership are wiped, and a refused refresh drops the copy.
// - 12 h expiry, 1 MB per row, 4 MB total (oldest evicted); unreadable rows are ignored; disk failures
//   are silent (the screen just loads fresh). Accepted limitation: age uses the device clock.
export type Snapshot<T> = { userId: string; shopId: string; at: number; value: T };

const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const MAX_ROW_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 4_000_000;
const store = new Map<string, Snapshot<unknown>>();
const activeShop = new Map<string, string>();
let wired = false;
let currentUid: string | null = null; // null = not known yet
let hydratedFor: string | null = null;
let epoch = 0;
let queue: Promise<void> = Promise.resolve();
const hooks = { hydrateTimeoutMs: 1500, beforeDiskRead: null as null | (() => Promise<void>) };

/** Test seam: shorten the startup wait or hold the disk read. */
export function setSnapshotTestHooks(next: Partial<typeof hooks>) {
  Object.assign(hooks, next);
}

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

/** The signed-in user is now `uid` ('' = nobody). Only a real change drops anything. */
function signedInAs(uid: string) {
  if (uid === currentUid) return;
  const firstKnown = currentUid === null;
  currentUid = uid;
  if (firstKnown) {
    // nothing was written to disk while the user was unknown; keep only this user's memory entries
    for (const [name, s] of store) if (s.userId !== uid) store.delete(name);
    for (const id of activeShop.keys()) if (id !== uid) activeShop.delete(id);
  } else {
    store.clear();
    activeShop.clear();
    hydratedFor = null;
    epoch++;
  }
  void disk((db) =>
    uid ? db.snapshots.where('userId').notEqual(uid).delete() : db.snapshots.clear(),
  );
}

function wire() {
  if (wired) return;
  try {
    onAuthStateChange((session) => signedInAs(session?.user?.id ?? ''));
    wired = true;
  } catch {
    // no auth client yet (tests, signed-out boot); keys still carry the user id
  }
}

function persist(name: string, snap: Snapshot<unknown>) {
  const e = epoch;
  const owner = snap.userId;
  const key = `${owner}:${name}`;
  const stillOwner = () => e === epoch && currentUid === owner;
  let json: string;
  try {
    json = JSON.stringify(snap.value) ?? '';
  } catch {
    json = '';
  }
  if (!json || json.length > MAX_ROW_BYTES) {
    // never let an older disk copy outlive a newer value that could not be stored
    void disk((db) => (stillOwner() ? db.snapshots.delete(key) : Promise.resolve()));
    return;
  }
  const row: RouteSnapshotRow = {
    key,
    userId: owner,
    name,
    shopId: snap.shopId,
    at: snap.at,
    json,
    size: json.length,
  };
  void disk((db) =>
    db.transaction('rw', db.snapshots, async () => {
      if (!stillOwner()) return;
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

/** Loads this user's disk snapshots into memory once per sign-in. Late results still apply. */
async function hydrate(userId: string): Promise<void> {
  if (!hasDisk() || !userId || hydratedFor === userId) return;
  hydratedFor = userId;
  const e = epoch;
  const found: RouteSnapshotRow[] = [];
  const work = disk(async (db) => {
    if (hooks.beforeDiskRead) await hooks.beforeDiskRead();
    if (e !== epoch) return;
    found.push(...(await db.snapshots.where('userId').equals(userId).toArray()));
  }).then(() => {
    if (e !== epoch || currentUid !== userId) return; // a sign-in change happened meanwhile
    const now = Date.now();
    let newest: Snapshot<unknown> | null = null;
    for (const r of found) {
      const s = readRow(r, userId, now);
      if (!s) continue;
      if (!newest || s.at > newest.at) newest = s;
      const cur = store.get(r.name);
      if (cur && cur.userId === userId && cur.at >= s.at) continue;
      store.set(r.name, s);
    }
    if (newest && !activeShop.has(userId)) activeShop.set(userId, newest.shopId);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise((r) => (timer = setTimeout(r, hooks.hydrateTimeoutMs)))]);
  clearTimeout(timer);
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
  if (currentUid !== null && currentUid !== userId) return; // that user is no longer signed in
  const snap = { userId, shopId, at: now, value };
  store.set(name, snap);
  activeShop.set(userId, shopId);
  if (currentUid === userId) persist(name, snap);
}

/**
 * The last snapshot of `name` for this user and shop, or null. Without `shopId` the active shop is used:
 * the shop this user last saw (from memory or the newest disk row) or the one noted from membership.
 */
export function peekSnapshot<T>(
  name: string,
  userId: string,
  shopId?: string,
  now = Date.now(),
): Snapshot<T> | null {
  wire();
  const s = store.get(name) as Snapshot<T> | undefined;
  if (!s || !userId || s.userId !== userId) return null;
  const shop = shopId || activeShop.get(userId);
  if (!shop || s.shopId !== shop) return null;
  if (now - s.at > MAX_AGE_MS) {
    store.delete(name);
    return null;
  }
  return s;
}

/**
 * Records the shops this user may see (from a fresh membership read) and the active one. Snapshots of any
 * other shop are dropped from memory and disk.
 */
export function noteSnapshotShops(userId: string, shopIds: string[], active: string) {
  wire();
  if (!userId || !active || (currentUid !== null && currentUid !== userId)) return;
  activeShop.set(userId, active);
  const allowed = new Set([...(Array.isArray(shopIds) ? shopIds : []), active]);
  for (const [name, s] of store)
    if (s.userId === userId && !allowed.has(s.shopId)) store.delete(name);
  void disk((db) =>
    db.snapshots.filter((r) => r.userId === userId && !allowed.has(r.shopId)).delete(),
  );
}

/** Drops `name` for this user (default: the user signed in now) from memory and disk. */
export function dropSnapshot(name: string, userId: string = currentUid ?? '') {
  const s = store.get(name);
  if (s && (!userId || s.userId === userId)) store.delete(name);
  if (userId) void disk((db) => db.snapshots.delete(`${userId}:${name}`));
}

/** A refresh failed. If the server refused this user (auth, permission, membership), drop the copy. */
export function snapshotRefreshFailed(name: string, error: unknown, userId = currentUid ?? '') {
  const e = error as { status?: unknown; code?: unknown; message?: unknown } | null;
  const status = Number(e?.status);
  const text = `${String(e?.code ?? '')} ${String(e?.message ?? error)}`;
  if (
    status === 401 ||
    status === 403 ||
    /\b(401|403|42501|PGRST301)\b|not permitted|permission denied|no tenant membership|not a member|jwt|restricted by your role/i.test(
      text,
    )
  )
    dropSnapshot(name, userId);
}

export function clearSnapshots() {
  store.clear();
  activeShop.clear();
  hydratedFor = null;
  currentUid = null;
  epoch++;
  void disk((db) => db.snapshots.clear());
}
/** Drops memory only, as closing the tab does. */
export function forgetSnapshotsInMemory() {
  store.clear();
  activeShop.clear();
  hydratedFor = null;
  currentUid = null;
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
  signedInAs(userId);
  await hydrate(userId);
  return userId;
}
