import { describe, expect, it, vi } from 'vitest';
import { __setSupabaseClientForTest, type DsbSupabaseClient } from './client';
import { listItemPurchasePrices } from './priceHistory';

function fake(lines: unknown[], bills: unknown[]) {
  const calls: Record<string, unknown[]> = {};
  const q = (table: string, result: unknown) => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'order', 'limit', 'in'])
      b[m] = (...args: unknown[]) => {
        (calls[table] ??= []).push([m, ...args]);
        return m === 'limit' || m === 'in' ? Promise.resolve({ data: result, error: null }) : b;
      };
    return b;
  };
  __setSupabaseClientForTest({
    from: vi.fn((t: string) => q(t, t === 'purchase_bill_items' ? lines : bills)),
  } as unknown as DsbSupabaseClient);
  return calls;
}
const line = (bill: string) => ({
  purchase_bill_id: bill,
  unit_level: 1,
  unit_name_snapshot: 'case',
  qty: '2',
  base_qty: '24',
  unit_price_paise: 1000,
  line_total_paise: 2000,
  created_at: 'x',
});

describe('listItemPurchasePrices', () => {
  it('reads this shop and item only and leaves voided or unseen bills out', async () => {
    const calls = fake(
      [line('b1'), line('b2'), line('b3')],
      [
        { id: 'b1', business_date: '2026-10-01', status: 'POSTED', party_id: 'p' },
        { id: 'b2', business_date: '2026-10-02', status: 'VOID', party_id: 'p' },
      ],
    );
    const out = await listItemPurchasePrices('shop', 'item');
    expect(out).toEqual([
      expect.objectContaining({ billId: 'b1', baseQty: 24, qty: 2, lineTotalPaise: 2000 }),
    ]);
    expect(calls.purchase_bill_items).toContainEqual(['eq', 'shop_id', 'shop']);
    expect(calls.purchase_bill_items).toContainEqual(['eq', 'item_id', 'item']);
  });
  it('returns nothing without asking for bills when the item was never bought', async () => {
    const calls = fake([], []);
    expect(await listItemPurchasePrices('shop', 'item')).toEqual([]);
    expect(calls.purchase_bills).toBeUndefined();
  });
  it('refuses a malformed number', async () => {
    fake(
      [{ ...line('b1'), base_qty: 'x' }],
      [{ id: 'b1', business_date: '2026-10-01', status: 'POSTED', party_id: null }],
    );
    await expect(listItemPurchasePrices('shop', 'item')).rejects.toThrow(/unexpected/);
  });
});
