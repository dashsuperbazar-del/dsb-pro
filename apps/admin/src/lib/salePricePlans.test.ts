// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import {
  addSalePricePlans,
  flushSalePricePlans,
  readSalePricePlans,
  salePriceRequestId,
  type SalePricePlan,
} from './salePricePlans';

afterEach(() => localStorage.clear());
const plan = (saleClientId: string, pricePaise = 1250): SalePricePlan => ({
  saleClientId,
  itemId: 'item-1',
  itemName: 'Loose Tea',
  kind: 'retail',
  unitLevel: 1,
  pricePaise,
});

test('a typed price is written only after its sale is confirmed, once, with an idempotent id', async () => {
  addSalePricePlans('shop', [plan('sale-a'), plan('sale-b', 900), plan('sale-c', 700)]);
  const status = { 'sale-a': 'SYNCED', 'sale-b': 'QUEUED', 'sale-c': 'REJECTED' } as const;
  const write = vi.fn().mockResolvedValue('price-id');
  const result = await flushSalePricePlans(
    'shop',
    async (id) => status[id as keyof typeof status],
    write,
  );
  expect(result).toEqual({ saved: ['Loose Tea'], failed: [] });
  expect(write).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledWith({
    itemId: 'item-1',
    shopId: 'shop',
    kind: 'retail',
    unitLevel: 1,
    pricePaise: 1250,
    clientId: 'sale-price:sale-a:item-1:retail:1:1250',
  });
  // The queued sale's plan waits; the rejected sale's plan is dropped (its price is never saved).
  expect(readSalePricePlans('shop').map((p) => p.saleClientId)).toEqual(['sale-b']);
});

test('a failed write is kept for the next try and reported', async () => {
  addSalePricePlans('shop', [plan('sale-a')]);
  const write = vi.fn().mockRejectedValue(new Error('not permitted'));
  const result = await flushSalePricePlans('shop', async () => 'SYNCED', write);
  expect(result.failed[0]).toMatch(/Loose Tea: not permitted/);
  expect(readSalePricePlans('shop').map(salePriceRequestId)).toEqual([
    'sale-price:sale-a:item-1:retail:1:1250',
  ]);
});

test('unreadable storage means no plans, never a crash', () => {
  localStorage.setItem('dsb-sale-price-plans:shop', '{broken');
  expect(readSalePricePlans('shop')).toEqual([]);
  localStorage.setItem(
    'dsb-sale-price-plans:shop',
    JSON.stringify([{ saleClientId: 'x', pricePaise: -1 }]),
  );
  expect(readSalePricePlans('shop')).toEqual([]);
});
