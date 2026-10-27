import { beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('./client', () => ({ getSupabaseClient: () => ({ from: mocks.from, rpc: mocks.rpc }) }));
import { listRecentExpenses } from './reports';

beforeEach(() => vi.resetAllMocks());

function chain(result: { data: unknown; error: unknown }) {
  const calls: [string, unknown[]][] = [];
  const q: Record<string, unknown> = {};
  for (const name of ['select', 'eq', 'order', 'limit']) {
    q[name] = (...args: unknown[]) => {
      calls.push([name, args]);
      return name === 'limit' ? Promise.resolve(result) : q;
    };
  }
  return { q, calls };
}

test("reads only this shop's posted expenses from the expenses table, newest first", async () => {
  const rows = [
    {
      id: 'e1',
      business_date: '2026-10-27',
      category: 'Rent',
      description: 'Rent',
      amount_paise: 1250000,
      mode: 'cash',
    },
  ];
  const { q, calls } = chain({ data: rows, error: null });
  mocks.from.mockReturnValue(q);
  expect(await listRecentExpenses('shop-1', 5)).toEqual(rows);
  expect(mocks.from).toHaveBeenCalledWith('expenses');
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(calls).toContainEqual(['eq', ['shop_id', 'shop-1']]);
  expect(calls).toContainEqual(['eq', ['status', 'POSTED']]);
  expect(calls).toContainEqual(['order', ['business_date', { ascending: false }]]);
  expect(calls).toContainEqual(['limit', [5]]);
});

test('a refused or failed read throws (the screen then leaves the list out)', async () => {
  const { q } = chain({ data: null, error: { code: '42501', message: 'permission denied' } });
  mocks.from.mockReturnValue(q);
  await expect(listRecentExpenses('shop-1')).rejects.toBeDefined();
});
