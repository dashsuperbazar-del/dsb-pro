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
  peekSnapshot,
  putSnapshot,
  snapshotDiskIdle,
  snapshotUserId,
} from './routeSnapshot';

async function coldStart(userId: string | null) {
  await snapshotDiskIdle();
  forgetSnapshotsInMemory();
  auth.userId = userId;
  return snapshotUserId();
}

beforeEach(async () => {
  auth.userId = 'u1';
  clearSnapshots();
  await snapshotDiskIdle();
});

describe('SP4 cold start', () => {
  it('a saved snapshot is back after the tab was closed, for the same user only', async () => {
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
    await snapshotDiskIdle();
    expect(await (await openRouteSnapshotDb()).snapshots.count()).toBe(0);
  });
  it('signed out at startup shows nothing and wipes disk', async () => {
    putSnapshot('suppliers', 'u1', 's1', 1);
    expect(await coldStart(null)).toBe('');
    await coldStart('u1');
    expect(peekSnapshot('suppliers', 'u1')).toBeNull();
  });
  it('sign-out (auth event without a session) wipes disk', async () => {
    putSnapshot('suppliers', 'u1', 's1', 1);
    auth.listener!(null);
    await coldStart('u1');
    expect(peekSnapshot('suppliers', 'u1')).toBeNull();
  });
  it('an auth event for another user wipes disk; the same user keeps it', async () => {
    putSnapshot('a', 'u1', 's1', 1);
    auth.listener!({ user: { id: 'u1' } });
    expect(peekSnapshot('a', 'u1')).toBeNull(); // memory is still dropped on every event
    await coldStart('u1');
    expect(peekSnapshot('a', 'u1')?.value).toBe(1);
    auth.listener!({ user: { id: 'u9' } });
    await coldStart('u1');
    expect(peekSnapshot('a', 'u1')).toBeNull();
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
    for (const n of ['old', 'bad', 'odd', 'w', 'f']) expect(peekSnapshot(n, 'u1')).toBeNull();
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
    const rows = await (await openRouteSnapshotDb()).snapshots.toArray();
    expect(rows.reduce((t, r) => t + r.size, 0)).toBeLessThanOrEqual(4_000_000);
  });
  it('drop and clear also remove the disk copy', async () => {
    putSnapshot('a', 'u1', 's1', 1);
    putSnapshot('b', 'u1', 's1', 2);
    dropSnapshot('a');
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
    putSnapshot('a', 'u1', 's1', 'new');
    await snapshotUserId();
    expect(peekSnapshot('a', 'u1')?.value).toBe('new');
  });
});
