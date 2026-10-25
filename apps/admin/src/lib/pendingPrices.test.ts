// @vitest-environment jsdom
import { beforeEach, expect, test } from 'vitest';
import {
  forgetPendingPrice,
  isPriceInFlight,
  listPendingPrices,
  priceIsApplied,
  unsureStatus,
  sendPendingPrice,
  type PendingPrice,
} from './pendingPrices';

const entry = (over: Partial<PendingPrice> = {}): PendingPrice => ({
  clientId: 'c1',
  tenantId: 't1',
  userId: 'u1',
  itemId: 'i1',
  itemName: 'Tea',
  shopId: 's1',
  kind: 'retail',
  unitLevel: 1,
  unitName: 'piece',
  pricePaise: 4200,
  at: 1,
  ...over,
});

beforeEach(() => localStorage.clear());

test('the write is recorded before it is sent and forgotten only after the OK', async () => {
  let release!: (v: string) => void;
  const run = sendPendingPrice(entry(), () => new Promise<string>((r) => (release = r)));
  expect(listPendingPrices('t1', 'u1').map((p) => p.clientId)).toEqual(['c1']);
  expect(isPriceInFlight('c1')).toBe(true);
  release('id');
  await expect(run).resolves.toBe('id');
  expect(listPendingPrices('t1', 'u1')).toEqual([]);
  expect(isPriceInFlight('c1')).toBe(false);
});

test('a failed write stays recorded with its reason, so a later visit shows it', async () => {
  await expect(
    sendPendingPrice(entry(), () => Promise.reject(new Error('network down'))),
  ).rejects.toThrow('network down');
  expect(listPendingPrices('t1', 'u1')).toMatchObject([
    { clientId: 'c1', failure: 'network down' },
  ]);
  expect(listPendingPrices('other-tenant', 'u1')).toEqual([]);
  forgetPendingPrice('c1');
  expect(listPendingPrices('t1', 'u1')).toEqual([]);
});

test('applied only when the current price for that kind, unit and shop is the recorded price', () => {
  const row = {
    id: 'p',
    item_id: 'i1',
    shop_id: 's1',
    kind: 'retail' as const,
    unit_level: 1 as const,
    price_paise: 4200,
    effective_from: '',
    effective_to: null,
  };
  expect(priceIsApplied(entry(), [row])).toBe(true);
  expect(priceIsApplied(entry(), [{ ...row, price_paise: 4100 }])).toBe(false);
  expect(priceIsApplied(entry(), [{ ...row, unit_level: 2 }])).toBe(false);
  expect(priceIsApplied(entry(), [{ ...row, kind: 'mrp' }])).toBe(false);
  expect(priceIsApplied(entry(), [{ ...row, shop_id: null }])).toBe(false);
});

test('unreadable storage reads as empty instead of throwing', () => {
  localStorage.setItem('dsb.pendingPrices.v1', '{not json');
  expect(listPendingPrices('t1', 'u1')).toEqual([]);
});

const priceRow = (price_paise: number) => ({
  id: 'p',
  item_id: 'i1',
  shop_id: 's1',
  kind: 'retail' as const,
  unit_level: 1 as const,
  price_paise,
  effective_from: '',
  effective_to: null,
});

test('another user of the same device never sees the record', () => {
  void sendPendingPrice(entry(), () => new Promise<string>(() => undefined));
  expect(listPendingPrices('t1', 'u1').map((p) => p.clientId)).toEqual(['c1']);
  expect(listPendingPrices('t1', 'u2')).toEqual([]);
});

test('Retry status: applied, unchanged, or changed elsewhere (needs an explicit Replace)', () => {
  const e = entry({ beforePaise: 4000 });
  expect(unsureStatus(e, [priceRow(4200)])).toEqual({ state: 'applied', nowPaise: 4200 });
  expect(unsureStatus(e, [priceRow(4000)])).toEqual({ state: 'unchanged', nowPaise: 4000 });
  expect(unsureStatus(e, [priceRow(12000)])).toEqual({ state: 'changed', nowPaise: 12000 });
  expect(unsureStatus(e, [])).toEqual({ state: 'changed', nowPaise: null });
  expect(unsureStatus(entry({ beforePaise: null }), [])).toEqual({
    state: 'unchanged',
    nowPaise: null,
  });
  // A record without a known "before" price never retries silently over a different price.
  expect(unsureStatus(entry(), [priceRow(4000)]).state).toBe('changed');
});
