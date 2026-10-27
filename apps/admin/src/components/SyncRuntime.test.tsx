// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';

const h = vi.hoisted(() => ({ start: vi.fn(async () => undefined), stop: vi.fn() }));
vi.mock('../lib/offlineSync', () => ({ startOfflineSync: h.start, stopOfflineSync: h.stop }));

import { SyncRuntime } from './SyncRuntime';
import type { SessionState } from '../lib/useSession';

const active = (role: 'owner' | 'cashier', shopIds: string[]): SessionState => ({
  status: 'active',
  session: { user: { id: 'u1' } } as never,
  membership: { tenantId: 't', role, shopIds },
  offline: false,
  verified: true,
});

afterEach(() => {
  h.start.mockClear();
  h.stop.mockClear();
});

test('a role or shop change re-starts in place: the loop is never stopped for it', async () => {
  const root = document.createElement('div');
  await act(async () => render(<SyncRuntime session={active('owner', ['a'])} />, root));
  expect(h.start).toHaveBeenCalledTimes(1);
  await act(async () => render(<SyncRuntime session={active('cashier', ['a'])} />, root));
  await act(async () => render(<SyncRuntime session={active('cashier', ['b'])} />, root));
  expect(h.start).toHaveBeenCalledTimes(3);
  expect(h.start).toHaveBeenLastCalledWith({
    userId: 'u1',
    membership: { tenantId: 't', role: 'cashier', shopIds: ['b'] },
  });
  expect(h.stop).not.toHaveBeenCalled();
  await act(async () => render(<SyncRuntime session={{ status: 'signed-out' }} />, root));
  expect(h.stop).toHaveBeenCalled();
});
