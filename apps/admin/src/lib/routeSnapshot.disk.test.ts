import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({
  listener: null as null | ((s: unknown) => void),
  userId: 'u1' as string | null,
}));
vi.mock('@dsb-pro/adapters', () => ({
  onAuthStateChange: vi.fn((cb: (s: unknown) => void) => {
    auth.listener = cb;
    return () => {};
  }),
  getSession: vi.fn(async () => (auth.userId ? { user: { id: auth.userId } } : null)),
}));
import { openRouteSnapshotDb } from '@dsb-pro/sync';
import {
  clearSnapshots,
  dropSnapshot,
  forgetSnapshotsInMemory,
  noteSnapshotShops,
  peekSnapshot,
  putSnapshot,
  setSnapshotTestHooks,
  snapshotDiskIdle,
  snapshotRefreshFailed,
  snapshotUserId,
} from './routeSnapshot';

const session = (id: string | null) => (id ? { user: { id } } : null);
async function coldStart(userId: string | null) {
  await snapshotDiskIdle();
  forgetSnapshotsInMemory();
  auth.userId = userId;
  return snapshotUserId();
}
async function diskRows() {
  await snapshotDiskIdle();
  return (await openRouteSnapshotDb()).snapshots.toArray();
}

beforeEach(async () => {
  setSnapshotTestHooks({ hydrateTimeoutMs: 1500, beforeDiskRead: null });
  auth.userId = 'u1';
  clearSnapshots();
  await snapshotDiskIdle();
  await snapshotUserId();
});

describe('SP4 cold start', () => {
  it('a saved snapshot is back after the tab was closed, for the same user and shop only', async () => {
    putSnapshot('suppliers', 'u1', 's1', { rows: [1] });
    expect(await coldStart('u1')).toBe('u1');
    const s = peekSnapshot<{ rows: number[] }>('suppliers', 'u1');
    expect(s?.value).toEqual({ rows: [1] });
    expect(s?.shopId).toBe('s1');
    expect(peekSnapshot('suppliers', 'u1', 's2')).toBeNull();
  });
  it('another user never sees it, and it is wiped from disk', async () => {
    putSnapshot('suppliers', 'u1', 's1', 1);
    await coldStart('u2');
    expect(peekSnapshot('suppliers', 'u2')).toBeNull();
    expect(peekSnapshot('suppliers', 'u1')).toBeNull();
    expect(await diskRows()).toHaveLength(0);
  });
  it('signed out at startup shows nothing and wipes disk', async () => {
    putSnapshot('suppliers', 'u1', 's1', 1);
    expect(await coldStart(null)).toBe('');
    expect(await diskRows()).toHaveLength(0);
  });
  it('sign-out (auth event without a session) wipes disk', async () => {
    putSnapshot('suppliers', 'u1', 's1', 1);
    auth.listener!(null);
    expect(peekSnapshot('suppliers', 'u1')).toBeNull();
    expect(await diskRows()).toHaveLength(0);
  });
  it('a token refresh for the same user changes nothing; another user wipes disk', async () => {
    putSnapshot('a', 'u1', 's1', 1);
    auth.listener!(session('u1'));
    expect(peekSnapshot('a', 'u1')?.value).toBe(1);
    auth.listener!(session('u9'));
    expect(peekSnapshot('a', 'u1')).toBeNull();
    expect(await diskRows()).toHaveLength(0);
  });
  it('a fetch for A that lands after sign-out is not stored, and B rows survive', async () => {
    auth.listener!(null);
    putSnapshot('late', 'u1', 's1', 'A figures');
    expect(peekSnapshot('late', 'u1')).toBeNull();
    expect(await diskRows()).toHaveLength(0);
    auth.listener!(session('u2'));
    putSnapshot('mine', 'u2', 's1', 'B figures');
    putSnapshot('late', 'u1', 's1', 'A figures');
    const rows = await diskRows();
    expect(rows.map((r) => r.key)).toEqual(['u2:mine']);
  });
  it('a write queued before a user switch never reaches disk', async () => {
    let release!: () => void;
    setSnapshotTestHooks({ beforeDiskRead: () => new Promise((r) => (release = r)) });
    const hold = coldStart('u1');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    // the startup read is holding the disk queue: queue a write for u1, then switch to u2
    putSnapshot('q', 'u1', 's1', 1);
    auth.listener!(session('u2'));
    release();
    await hold;
    setSnapshotTestHooks({ beforeDiskRead: null });
    expect(await diskRows()).toHaveLength(0);
  });
  it('expired, corrupt and malformed rows are ignored safely', async () => {
    putSnapshot('old', 'u1', 's1', 1, Date.now() - 13 * 3600_000);
    await snapshotDiskIdle();
    const db = await openRouteSnapshotDb();
    const now = Date.now();
    await db.snapshots.bulkPut([
      { key: 'u1:bad', userId: 'u1', name: 'bad', shopId: 's1', at: now, json: '{nope', size: 5 },
      { key: 'u1:odd', userId: 'u1', name: 'odd', shopId: '', at: now, json: '1', size: 1 },
      { key: 'u1:w', userId: 'u1', name: 'w', shopId: 's1', at: 'x' as never, json: '1', size: 1 },
      {
        key: 'u1:f',
        userId: 'u1',
        name: 'f',
        shopId: 's1',
        at: now + 3600_000,
        json: '1',
        size: 1,
      },
    ]);
    await coldStart('u1');
    for (const n of ['old', 'bad', 'odd', 'w', 'f']) expect(peekSnapshot(n, 'u1', 's1')).toBeNull();
  });
  it('oversized values stay in memory only; total size is capped oldest-first', async () => {
    putSnapshot('huge', 'u1', 's1', 'x'.repeat(1_100_000));
    expect(peekSnapshot('huge', 'u1')).not.toBeNull();
    const big = 'y'.repeat(900_000);
    for (let i = 0; i < 6; i++) putSnapshot(`n${i}`, 'u1', 's1', big, Date.now() - 60_000 + i);
    await coldStart('u1');
    expect(peekSnapshot('huge', 'u1')).toBeNull();
    expect(peekSnapshot('n0', 'u1')).toBeNull();
    expect(peekSnapshot('n5', 'u1')?.value).toBe(big);
    const rows = await diskRows();
    expect(rows.reduce((t, r) => t + r.size, 0)).toBeLessThanOrEqual(4_000_000);
  });
  it('drop is keyed by user; clear removes everything', async () => {
    putSnapshot('a', 'u1', 's1', 1);
    putSnapshot('b', 'u1', 's1', 2);
    dropSnapshot('a', 'u2');
    expect(peekSnapshot('a', 'u1')?.value).toBe(1);
    dropSnapshot('a', 'u1');
    await coldStart('u1');
    expect(peekSnapshot('a', 'u1')).toBeNull();
    expect(peekSnapshot('b', 'u1')?.value).toBe(2);
    clearSnapshots();
    await coldStart('u1');
    expect(peekSnapshot('b', 'u1')).toBeNull();
  });
  it('a fresh value written during startup is not replaced by the older disk copy', async () => {
    putSnapshot('a', 'u1', 's1', 'old', Date.now() - 1000);
    await snapshotDiskIdle();
    forgetSnapshotsInMemory();
    await snapshotUserId();
    putSnapshot('a', 'u1', 's1', 'new');
    expect(peekSnapshot('a', 'u1')?.value).toBe('new');
  });
});

describe('SP4 shop scoping', () => {
  it('a snapshot of another shop than the active one is not shown', async () => {
    putSnapshot('list', 'u1', 's1', 1);
    noteSnapshotShops('u1', ['s1', 's2'], 's2');
    expect(peekSnapshot('list', 'u1')).toBeNull();
    expect(peekSnapshot('list', 'u1', 's1')?.value).toBe(1);
  });
  it('a shop removed from the membership is wiped from memory and disk', async () => {
    putSnapshot('list', 'u1', 's1', 1);
    noteSnapshotShops('u1', ['s2'], 's2');
    expect(peekSnapshot('list', 'u1', 's1')).toBeNull();
    expect(await diskRows()).toHaveLength(0);
  });
  it('a refresh refused for permission or membership drops the copy; a network error keeps it', async () => {
    putSnapshot('list', 'u1', 's1', 1);
    snapshotRefreshFailed('list', new Error('Failed to fetch'));
    expect(peekSnapshot('list', 'u1')?.value).toBe(1);
    snapshotRefreshFailed('list', Object.assign(new Error('denied'), { status: 403 }));
    expect(peekSnapshot('list', 'u1')).toBeNull();
    putSnapshot('list', 'u1', 's1', 1);
    snapshotRefreshFailed('list', new Error('No tenant membership.'));
    expect(peekSnapshot('list', 'u1')).toBeNull();
    expect(await diskRows()).toHaveLength(0);
  });
});

describe('SP4 slow or interrupted startup', () => {
  it('rows that arrive after the startup wait still apply', async () => {
    putSnapshot('a', 'u1', 's1', 1);
    await snapshotDiskIdle();
    let release!: () => void;
    setSnapshotTestHooks({
      hydrateTimeoutMs: 5,
      beforeDiskRead: () => new Promise((r) => (release = r)),
    });
    expect(await coldStart('u1')).toBe('u1');
    expect(peekSnapshot('a', 'u1')).toBeNull();
    release();
    await snapshotDiskIdle();
    await Promise.resolve();
    expect(peekSnapshot('a', 'u1')?.value).toBe(1);
  });
  it('an auth event during startup discards what was read', async () => {
    putSnapshot('a', 'u1', 's1', 1);
    await snapshotDiskIdle();
    let release!: () => void;
    setSnapshotTestHooks({ beforeDiskRead: () => new Promise((r) => (release = r)) });
    const start = coldStart('u1');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    auth.listener!(session('u2'));
    release();
    await start;
    await snapshotDiskIdle();
    expect(peekSnapshot('a', 'u1')).toBeNull();
    expect(peekSnapshot('a', 'u2')).toBeNull();
    expect(await diskRows()).toHaveLength(0);
  });
});
