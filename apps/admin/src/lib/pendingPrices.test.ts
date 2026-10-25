// @vitest-environment jsdom
import { beforeEach, expect, test } from 'vitest';
import {
  forgetPendingPrice,
  isPriceInFlight,
  listPendingPrices,
  priceIsApplied,
  sendPendingPrice,
  type PendingPrice,
} from './pendingPrices';

const entry = (over: Partial<PendingPrice> = {}): PendingPrice => ({
  clientId: 'c1',
  tenantId: 't1',
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
  expect(listPendingPrices('t1').map((p) => p.clientId)).toEqual(['c1']);
  expect(isPriceInFlight('c1')).toBe(true);
  release('id');
  await expect(run).resolves.toBe('id');
  expect(listPendingPrices('t1')).toEqual([]);
  expect(isPriceInFlight('c1')).toBe(false);
});

test('a failed write stays recorded with its reason, so a later visit shows it', async () => {
  await expect(
    sendPendingPrice(entry(), () => Promise.reject(new Error('network down'))),
  ).rejects.toThrow('network down');
  expect(listPendingPrices('t1')).toMatchObject([{ clientId: 'c1', failure: 'network down' }]);
  expect(listPendingPrices('other-tenant')).toEqual([]);
  forgetPendingPrice('c1');
  expect(listPendingPrices('t1')).toEqual([]);
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
  expect(listPendingPrices('t1')).toEqual([]);
});
