// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';

const h = vi.hoisted(() => ({
  session: { user: { id: 'A' } } as { user: { id: string } } | null,
  membership: vi.fn(),
  authCb: null as null | ((s: unknown) => void),
}));
vi.mock('@dsb-pro/adapters', async (orig) => ({
  ...(await orig<typeof import('@dsb-pro/adapters')>()),
  getSession: async () => h.session,
  onAuthStateChange: (cb: (s: unknown) => void) => {
    h.authCb = cb;
    return () => undefined;
  },
  getCurrentMembership: h.membership,
  registerCurrentDevice: async () => 'device-row',
  resetDefaultShopInFlight: () => undefined,
}));

import { cacheOfflineMembership } from '@dsb-pro/sync';
import { useSession, type SessionState } from './useSession';

let seen: SessionState[] = [];
let seenVerified: SessionState[] = [];
function Probe() {
  seen.push(useSession());
  seenVerified.push(useSession({ requireVerified: true }));
  return null;
}
function Single() {
  seen.push(useSession());
  return null;
}
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
let root: HTMLElement;
beforeEach(() => {
  localStorage.clear();
  seen = [];
  seenVerified = [];
  h.session = { user: { id: 'A' } };
  h.membership.mockReset();
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
});
const cacheOwner = () =>
  cacheOfflineMembership({ userId: 'A', tenantId: 't', role: 'owner', shopIds: ['s'] });

test('cached owner opens at once as unverified; the server saying cashier replaces it and owner UI never verifies', async () => {
  cacheOwner();
  let answer!: (v: unknown) => void;
  h.membership.mockReturnValue(new Promise((r) => (answer = r)));
  await act(async () => render(<Probe />, root));
  await flush();
  const first = seen.at(-1)!;
  expect(first).toMatchObject({ status: 'active', verified: false, membership: { role: 'owner' } });
  // owner-only screens stay on "loading" until the server answers
  expect(seenVerified.at(-1)).toEqual({ status: 'loading' });
  answer(
    [{ tenant_id: 't', role: 'cashier', shop_ids: ['s'] }].length
      ? { tenantId: 't', role: 'cashier', shopIds: ['s'] }
      : null,
  );
  await flush();
  expect(seen.at(-1)).toMatchObject({
    status: 'active',
    verified: true,
    membership: { role: 'cashier' },
  });
  expect(seenVerified.at(-1)).toMatchObject({ status: 'active', membership: { role: 'cashier' } });
  // never was an owner state offered as verified
  expect(seenVerified.some((s) => s.status === 'active' && s.membership.role === 'owner')).toBe(
    false,
  );
});

test('the same membership from the server confirms in place (verified, same role)', async () => {
  cacheOwner();
  h.membership.mockResolvedValue({ tenantId: 't', role: 'owner', shopIds: ['s'] });
  await act(async () => render(<Probe />, root));
  await flush();
  expect(seen.at(-1)).toMatchObject({
    status: 'active',
    verified: true,
    membership: { role: 'owner' },
  });
});

test('a no-tenant answer replaces the cached state', async () => {
  cacheOwner();
  h.membership.mockResolvedValue(null);
  await act(async () => render(<Probe />, root));
  await flush();
  expect(seen.at(-1)!.status).toBe('no-tenant');
});

test('a non-network server error replaces the cached state with an error', async () => {
  cacheOwner();
  h.membership.mockRejectedValue(Object.assign(new Error('permission denied'), { code: '42501' }));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await act(async () => render(<Probe />, root));
  await flush();
  expect(seen.at(-1)!.status).toBe('error');
});

test("user B signing in never reuses user A's membership read or cached membership", async () => {
  cacheOwner();
  h.membership.mockImplementation(async () => ({ tenantId: 't', role: 'owner', shopIds: ['s'] }));
  await act(async () => render(<Single />, root));
  await flush();
  h.membership.mockClear();
  h.membership.mockResolvedValue({ tenantId: 'tB', role: 'cashier', shopIds: ['sB'] });
  await act(async () => {
    h.authCb?.({ user: { id: 'B' } });
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(h.membership).toHaveBeenCalledTimes(1);
  const last = seen.at(-1)!;
  expect(last).toMatchObject({ status: 'active', membership: { tenantId: 'tB', role: 'cashier' } });
});
