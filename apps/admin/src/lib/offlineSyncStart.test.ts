// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// The app opens on the CACHED membership, so the server may answer with a different role/shop moments
// later. Starting sync must stay ONE loop, update the identity in place, and re-restrict a demoted user.
const h = vi.hoisted(() => ({
  restrict: vi.fn(async () => undefined),
  subscribe: vi.fn(() => vi.fn()),
  open: vi.fn(),
}));
vi.mock('@dsb-pro/sync', async (orig) => ({
  ...(await orig<typeof import('@dsb-pro/sync')>()),
  openSyncDb: h.open,
  restrictCachedCostPrices: h.restrict,
  recoverInterruptedOutbox: vi.fn(async () => undefined),
  recoverInterruptedAttempts: vi.fn(async () => undefined),
}));
vi.mock('@dsb-pro/adapters', async (orig) => ({
  ...(await orig<typeof import('@dsb-pro/adapters')>()),
  getOrCreateDeviceId: () => 'dev-1',
  getDefaultShopId: async () => 'shop-default',
  subscribeSyncWakeup: h.subscribe,
  // No session: the first cycle ends in a recorded error, which is all these tests need.
  ensureFreshSession: vi.fn(async () => null),
}));

import { getOfflineRuntimeIdentity, startOfflineSync, stopOfflineSync } from './offlineSync';

const membership = (role: 'owner' | 'cashier', shopIds = ['shop-a']) => ({
  tenantId: 'tenant-1',
  role,
  shopIds,
});

beforeEach(() => {
  stopOfflineSync();
  h.restrict.mockClear();
  h.subscribe.mockClear();
  h.open.mockReset();
  h.open.mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 5));
    return { id: 'db' };
  });
});
afterEach(() => {
  stopOfflineSync();
  vi.restoreAllMocks();
});

test('two rapid starts leave exactly one loop (one interval, one realtime subscription)', async () => {
  const setIntervalSpy = vi.spyOn(window, 'setInterval');
  await Promise.all([
    startOfflineSync({ userId: 'u1', membership: membership('owner') }),
    startOfflineSync({ userId: 'u1', membership: membership('owner') }),
  ]);
  expect(h.subscribe).toHaveBeenCalledTimes(1);
  expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  expect(getOfflineRuntimeIdentity()?.role).toBe('owner');
});

test('a start superseded by a different user installs nothing', async () => {
  await Promise.all([
    startOfflineSync({ userId: 'u1', membership: membership('owner') }),
    startOfflineSync({ userId: 'u2', membership: membership('owner') }),
  ]);
  expect(h.subscribe).toHaveBeenCalledTimes(1);
  expect(getOfflineRuntimeIdentity()?.userId).toBe('u2');
});

test('a role change updates the running loop in place: no second loop, new role', async () => {
  await startOfflineSync({ userId: 'u1', membership: membership('owner') });
  expect(h.restrict).not.toHaveBeenCalled();
  await startOfflineSync({ userId: 'u1', membership: membership('cashier') });
  expect(h.subscribe).toHaveBeenCalledTimes(1);
  expect(h.open).toHaveBeenCalledTimes(1);
  expect(getOfflineRuntimeIdentity()?.role).toBe('cashier');
  // demotion removes the cached cost prices at once
  expect(h.restrict).toHaveBeenCalledTimes(1);
});

test('a reassigned shop updates the running identity in place', async () => {
  await startOfflineSync({ userId: 'u1', membership: membership('owner', ['shop-a']) });
  await startOfflineSync({ userId: 'u1', membership: membership('owner', ['shop-b']) });
  expect(h.subscribe).toHaveBeenCalledTimes(1);
  expect(getOfflineRuntimeIdentity()?.shopId).toBe('shop-b');
});

test('opening directly as a cashier restricts cost prices before the loop starts', async () => {
  await startOfflineSync({ userId: 'u1', membership: membership('cashier') });
  expect(h.restrict).toHaveBeenCalledTimes(1);
});
