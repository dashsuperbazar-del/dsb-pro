import { describe, expect, it } from 'vitest';
import { __setSupabaseClientForTest, type DsbSupabaseClient } from './client';
import { readCustomerLedgerForStatement } from './sales';

const mk = (i: number) => ({
  customer_id: 'c',
  business_date: '2026-10-01',
  created_at: `2026-10-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
  entry_type: 'SALE',
  ref_id: `r${i}`,
  reference: null,
  debit_paise: 100,
  credit_paise: 0,
});
function client(all: unknown[], opts: { count?: number | null; balance?: number | null } = {}) {
  const calls: Array<[number, number]> = [];
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    range: (a: number, b: number) => {
      calls.push([a, b]);
      return Promise.resolve({
        data: all.slice(a, b + 1),
        error: null,
        count: opts.count === undefined ? all.length : opts.count,
      });
    },
    maybeSingle: () =>
      Promise.resolve({
        data: opts.balance === null ? null : { balance_paise: opts.balance ?? all.length * 100 },
        error: null,
      }),
  };
  __setSupabaseClientForTest({ from: () => chain } as unknown as DsbSupabaseClient);
  return calls;
}

describe('readCustomerLedgerForStatement', () => {
  it('pages past 1000 rows and returns the stored balance', async () => {
    const all = Array.from({ length: 2300 }, (_, i) => mk(i));
    const calls = client(all);
    const r = await readCustomerLedgerForStatement('c');
    expect(r.rows).toHaveLength(2300);
    expect(r.balancePaise).toBe(230000);
    expect(calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });
  it('an empty ledger is valid with a zero balance', async () => {
    client([], { balance: null });
    expect(await readCustomerLedgerForStatement('c')).toEqual({ rows: [], balancePaise: 0 });
  });
  it('refuses when the size is not confirmed or the read stops short', async () => {
    client([mk(1)], { count: null });
    await expect(readCustomerLedgerForStatement('c')).rejects.toThrow(/size/);
    client([mk(1)], { count: 5 });
    await expect(readCustomerLedgerForStatement('c')).rejects.toThrow(/completely/);
  });
});
