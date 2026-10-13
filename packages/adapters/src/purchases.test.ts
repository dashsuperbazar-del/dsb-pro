import { expect, test, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({ membership: vi.fn(), from: vi.fn() }));
vi.mock('./tenancy', () => ({ getCurrentMembership: mocks.membership }));
vi.mock('./client', () => ({ getSupabaseClient: () => ({ from: mocks.from }) }));
import { listPurchaseHistory } from './purchases';
beforeEach(() => {
  vi.resetAllMocks();
});
test('cashiers and memberships from another shop cannot query purchase costs', async () => {
  mocks.membership.mockResolvedValue({ role: 'cashier', shopIds: ['shop'] });
  await expect(listPurchaseHistory('shop')).rejects.toThrow(/restricted/);
  mocks.membership.mockResolvedValue({ role: 'owner', shopIds: ['other'] });
  await expect(listPurchaseHistory('shop')).rejects.toThrow(/restricted/);
  expect(mocks.from).not.toHaveBeenCalled();
});
test('history pages use a shop filter and stable date/time/id order, preserving money as text', async () => {
  mocks.membership.mockResolvedValue({ role: 'owner', shopIds: ['shop'] });
  const q = { select: vi.fn(), eq: vi.fn(), is: vi.fn(), order: vi.fn(), range: vi.fn() };
  for (const name of ['select', 'eq', 'is', 'order'] as const) q[name].mockReturnValue(q);
  q.range.mockResolvedValue({ data: [{ total_paise: '9007199254740993' }], error: null });
  mocks.from.mockReturnValue(q);
  expect(await listPurchaseHistory('shop', 50)).toEqual([{ total_paise: '9007199254740993' }]);
  expect(q.eq).toHaveBeenCalledWith('shop_id', 'shop');
  expect(q.range).toHaveBeenCalledWith(50, 99);
  expect(q.order.mock.calls.map((c) => c[0])).toEqual(['business_date', 'created_at', 'id']);
  expect(q.select.mock.calls[0][0]).toContain('total_paise::text');
});
