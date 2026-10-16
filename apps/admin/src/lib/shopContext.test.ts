// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi, type Mock } from 'vitest';
import { createShopContext } from './shopContext';

type Deps = Parameters<typeof createShopContext>[0];
let clock = 0;
function setup(over: Partial<Deps> = {}) {
  let session: { user: { id: string } } | null = { user: { id: 'u1' } };
  let authCb: ((s: unknown) => void) | null = null;
  const deps = {
    now: () => clock,
    getSession: vi.fn(async () => session as never),
    getMembership: vi.fn(async () => ({ tenantId: 't', role: 'owner', shopIds: ['s'] }) as never),
    getDefaultShopId: vi.fn(async () => 's'),
    getBusinessDate: vi.fn(async () => '2026-10-16'),
    onAuthChange: (cb: (s: unknown) => void) => {
      authCb = cb;
      return () => {};
    },
    ...over,
  } satisfies Deps;
  const ctx = createShopContext(deps);
  return {
    ctx,
    deps,
    setSession: (s: typeof session) => (session = s),
    fireAuth: (s: unknown) => authCb?.(s),
  };
}
beforeEach(() => (clock = 1_000_000));
afterEach(() => vi.restoreAllMocks());

test('concurrent callers share one membership and one shop read', async () => {
  const { ctx, deps } = setup();
  const [a, b, c] = await Promise.all([ctx.get(), ctx.get(), ctx.get()]);
  expect(a).toBe(b);
  expect(b).toBe(c);
  expect(deps.getMembership).toHaveBeenCalledTimes(1);
  expect(deps.getDefaultShopId).toHaveBeenCalledTimes(1);
});

test('a result is reused inside the ttl and re-read after it, never kept forever', async () => {
  const { ctx, deps } = setup();
  await ctx.get();
  clock += 20_000;
  await ctx.get();
  expect(deps.getMembership).toHaveBeenCalledTimes(1);
  clock += 20_000; // 40 s total: past the 30 s ttl
  await ctx.get();
  expect(deps.getMembership).toHaveBeenCalledTimes(2);
});

test('auth changes, focus and reconnect all force a fresh read', async () => {
  const { ctx, deps, fireAuth } = setup();
  await ctx.get();
  fireAuth({ user: { id: 'u1' } });
  await ctx.get();
  expect(deps.getMembership).toHaveBeenCalledTimes(2);
  window.dispatchEvent(new Event('focus'));
  await ctx.get();
  expect(deps.getMembership).toHaveBeenCalledTimes(3);
  window.dispatchEvent(new Event('online'));
  await ctx.get();
  expect(deps.getMembership).toHaveBeenCalledTimes(4);
});

test('a different signed-in user never receives the previous user’s context', async () => {
  const { ctx, deps, setSession } = setup();
  const first = await ctx.get();
  setSession({ user: { id: 'u2' } });
  (deps.getMembership as Mock).mockResolvedValueOnce({
    tenantId: 'other',
    role: 'cashier',
    shopIds: ['x'],
  } as never);
  const second = await ctx.get();
  expect(first.membership.tenantId).toBe('t');
  expect(second.membership.tenantId).toBe('other');
});

test('a read that started before an invalidation is discarded and the caller transparently gets a fresh one', async () => {
  let release!: (v: unknown) => void;
  const getMembership = vi
    .fn()
    .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    .mockResolvedValue({ tenantId: 'new', role: 'owner', shopIds: ['s'] });
  const { ctx } = setup({ getMembership: getMembership as never });
  const pending = ctx.get();
  await vi.waitFor(() => expect(getMembership).toHaveBeenCalled());
  ctx.invalidate();
  release({ tenantId: 'old', role: 'owner', shopIds: ['s'] });
  expect((await pending).membership.tenantId).toBe('new');
  expect((await ctx.get()).membership.tenantId).toBe('new');
});

test('signed out and no-membership are errors, not an empty context', async () => {
  const a = setup();
  a.setSession(null);
  await expect(a.ctx.get()).rejects.toThrow(/sign/i);
  const b = setup({ getMembership: vi.fn(async () => null) });
  await expect(b.ctx.get()).rejects.toThrow(/membership/i);
});

test('the business date is cached for a minute only, per shop', async () => {
  const { ctx, deps } = setup();
  expect(await ctx.businessDate('s')).toBe('2026-10-16');
  clock += 30_000;
  await ctx.businessDate('s');
  expect(deps.getBusinessDate).toHaveBeenCalledTimes(1);
  await ctx.businessDate('other-shop');
  expect(deps.getBusinessDate).toHaveBeenCalledTimes(2);
  clock += 31_000;
  await ctx.businessDate('s');
  expect(deps.getBusinessDate).toHaveBeenCalledTimes(3);
});

test('a failed read is not cached', async () => {
  const { ctx, deps } = setup();
  (deps.getMembership as Mock).mockRejectedValueOnce(new Error('network'));
  await expect(ctx.get()).rejects.toThrow('network');
  await expect(ctx.get()).resolves.toBeTruthy();
});
