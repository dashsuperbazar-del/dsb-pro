// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest';

// A shop change on the running loop: one shop for the whole cycle, and every table pulled from the
// beginning so rows scoped to the new shop are not skipped by the old shop's cursors.
const h = vi.hoisted(() => ({
  pulls: [] as Array<{ table: string; shopId: string }>,
  meta: [] as Array<[string, unknown]>,
}));
const fakeDb = { outbox: { orderBy: () => ({ toArray: async () => [] }) } };
vi.mock('@dsb-pro/sync', async (orig) => ({
  ...(await orig<typeof import('@dsb-pro/sync')>()),
  openSyncDb: async () => fakeDb,
  restrictCachedCostPrices: async () => undefined,
  recoverInterruptedOutbox: async () => 0,
  recoverInterruptedAttempts: async () => 0,
  getSyncCursors: async () => ({}),
  applySyncPull: async () => undefined,
  cacheReturnSources: async () => undefined,
  setMeta: async (_db: unknown, key: string, value: unknown) => void h.meta.push([key, value]),
}));
vi.mock('@dsb-pro/adapters', async (orig) => ({
  ...(await orig<typeof import('@dsb-pro/adapters')>()),
  getOrCreateDeviceId: () => 'dev-1',
  getDefaultShopId: async () => 'shop-default',
  subscribeSyncWakeup: () => () => undefined,
  ensureFreshSession: async () => ({ user: { id: 'u1' } }),
  pullSyncTable: async (a: { table: string; shopId: string }) => {
    h.pulls.push({ table: a.table, shopId: a.shopId });
    return { items: [], barcodes: [], prices: [], customers: [], stock: [] };
  },
  pullReturnSources: async () => [],
  ackSync: async () => undefined,
}));

import { runSyncNow, startOfflineSync, stopOfflineSync } from './offlineSync';

const membership = (shop: string) => ({ tenantId: 't', role: 'owner' as const, shopIds: [shop] });
beforeEach(() => {
  stopOfflineSync();
  h.pulls.length = 0;
  h.meta.length = 0;
});

test('a shop change pulls with the new shop and resets every table cursor once', async () => {
  await startOfflineSync({ userId: 'u1', membership: membership('shop-a') });
  expect(new Set(h.pulls.map((p) => p.shopId))).toEqual(new Set(['shop-a']));
  expect(h.meta).toEqual([]); // first cycle: nothing to reset
  h.pulls.length = 0;
  await startOfflineSync({ userId: 'u1', membership: membership('shop-b') });
  await runSyncNow();
  expect(h.pulls.length).toBeGreaterThan(0);
  expect(new Set(h.pulls.map((p) => p.shopId))).toEqual(new Set(['shop-b']));
  expect(h.meta.map(([k]) => k).sort()).toEqual(
    ['items', 'barcodes', 'prices', 'customers', 'stock'].map((t) => `cursor:${t}`).sort(),
  );
  // a later cycle for the same shop does not reset again
  h.meta.length = 0;
  await runSyncNow();
  expect(h.meta).toEqual([]);
});
