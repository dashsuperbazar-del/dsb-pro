import { expect, test, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({ membership: vi.fn(), from: vi.fn() }));
vi.mock('./tenancy', () => ({ getCurrentMembership: mocks.membership }));
vi.mock('./client', () => ({ getSupabaseClient: () => ({ from: mocks.from }) }));
import { listPurchaseHistory, listSupplierPurchaseLines } from './purchases';
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

function supplierQueries(bills: unknown[], pages: unknown[][]) {
  const chain = (end: 'limit' | 'range') => {
    const q: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const name of ['select', 'eq', 'is', 'in', 'order', 'limit', 'range']) q[name] = vi.fn();
    for (const name of ['select', 'eq', 'is', 'in', 'order', 'limit', 'range'])
      if (name !== end) q[name]!.mockReturnValue(q);
    return q;
  };
  const b = chain('limit');
  b.limit!.mockResolvedValue({ data: bills, error: null });
  const l = chain('range');
  for (const page of pages) l.range!.mockResolvedValueOnce({ data: page, error: null });
  mocks.from.mockImplementation((table: string) => (table === 'purchase_bills' ? b : l));
  return { b, l };
}
const row = (bill: string, line: number) => ({
  purchase_bill_id: bill,
  line_no: line,
  item_id: `i${line}`,
  unit_price_paise: '100',
});
test('supplier lines: POSTED, not deleted, this shop and supplier, newest bill first; bounds checked', async () => {
  mocks.membership.mockResolvedValue({ role: 'owner', shopIds: ['shop'] });
  for (const bad of [0, 101, 1.5])
    await expect(listSupplierPurchaseLines('shop', 'p1', bad)).rejects.toThrow(/Invalid/);
  expect(mocks.from).not.toHaveBeenCalled();
  const { b, l } = supplierQueries(
    [
      { id: 'new', business_date: '2026-10-11', created_at: 'x' },
      { id: 'old', business_date: '2026-10-01', created_at: 'y' },
    ],
    [[row('old', 1), row('new', 2), row('new', 1), row('gone', 1)]],
  );
  const out = await listSupplierPurchaseLines('shop', 'p1', 40);
  expect(b.eq!.mock.calls).toEqual([
    ['shop_id', 'shop'],
    ['party_id', 'p1'],
    ['status', 'POSTED'],
  ]);
  expect(b.is).toHaveBeenCalledWith('deleted_at', null);
  expect(b.order!.mock.calls.map((c) => c[0])).toEqual(['business_date', 'created_at', 'id']);
  expect(b.limit).toHaveBeenCalledWith(40);
  expect(l.eq).toHaveBeenCalledWith('shop_id', 'shop');
  expect(l.in).toHaveBeenCalledWith('purchase_bill_id', ['new', 'old']);
  expect(l.is).toHaveBeenCalledWith('deleted_at', null);
  expect(l.select!.mock.calls[0][0]).toContain('conv1_snapshot,conv2_snapshot');
  expect(l.select!.mock.calls[0][0]).toContain('discount_bp,gst_bp');
  // A line of a bill not in the list (e.g. VOID) is dropped; newest bill first, then line order.
  expect(out.map((o) => [o.purchase_bill_id, o.line_no, o.business_date])).toEqual([
    ['new', 1, '2026-10-11'],
    ['new', 2, '2026-10-11'],
    ['old', 1, '2026-10-01'],
  ]);
});
test('supplier lines are paged to the end, never cut off; an endless history fails', async () => {
  mocks.membership.mockResolvedValue({ role: 'manager', shopIds: ['shop'] });
  const full = Array.from({ length: 500 }, (_, i) => row('b', i + 1));
  const { l } = supplierQueries(
    [{ id: 'b', business_date: '2026-10-01', created_at: 'x' }],
    [full, [row('b', 501)]],
  );
  const out = await listSupplierPurchaseLines('shop', 'p1');
  expect(out).toHaveLength(501);
  expect(l.range!.mock.calls).toEqual([
    [0, 499],
    [500, 999],
  ]);
  expect(l.order!.mock.calls.map((c) => c[0])).toEqual([
    'purchase_bill_id',
    'line_no',
    'id',
    'purchase_bill_id',
    'line_no',
    'id',
  ]);
  supplierQueries(
    [{ id: 'b', business_date: '2026-10-01', created_at: 'x' }],
    Array.from({ length: 41 }, () => full),
  );
  await expect(listSupplierPurchaseLines('shop', 'p1')).rejects.toThrow(/Too many/);
  mocks.membership.mockResolvedValue({ role: 'cashier', shopIds: ['shop'] });
  await expect(listSupplierPurchaseLines('shop', 'p1')).rejects.toThrow(/restricted/);
});
