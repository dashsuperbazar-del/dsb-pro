// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest';
import type { Item, ItemPrice } from '@dsb-pro/adapters';
import {
  cardSaleResult,
  conversionLines,
  currentPricePaise,
  defaultSaleLevel,
  listPricePlans,
  loadPricePlan,
  priceClientId,
  salePricePlan,
  saleFields,
  savePricePlan,
  storePricePlan,
  writePriceList,
  type PriceLoad,
} from './billSalePrices';
import { emptyCard, withItem, type BillCard } from './billCards';

const ctn: Item = {
  id: 'i1',
  name: 'Biscuit',
  sku: null,
  unit1: 'ctn',
  unit2: 'pkt',
  unit3: 'pcs',
  conv1: 12,
  conv2: 10,
  tax_rate_bp: 0,
  min_stock: 0,
  image_path: null,
};
const two: Item = { ...ctn, id: 'i2', name: 'Soap', unit2: 'pcs', unit3: null, conv2: null };
const one: Item = {
  ...ctn,
  id: 'i3',
  name: 'Rice',
  unit2: null,
  unit3: null,
  conv1: null,
  conv2: null,
};
const price = (p: Partial<ItemPrice>): ItemPrice => ({
  id: Math.random().toString(36),
  item_id: 'i1',
  shop_id: 'shop',
  kind: 'retail',
  unit_level: 3,
  price_paise: 1000,
  effective_from: '2026-10-01',
  effective_to: null,
  ...p,
});
const ok = (prices: ItemPrice[]): PriceLoad => ({ state: 'ok', prices });
const card = (item: Item, sale?: BillCard['sale']): BillCard => ({
  ...withItem(emptyCard(), item),
  qty: '1',
  price: '100',
  ...(sale ? { sale } : {}),
});

afterEach(() => localStorage.clear());

describe('conversion text', () => {
  test('shows each tier from the item master', () => {
    expect(conversionLines(two)).toEqual(['1 ctn = 12 pcs']);
    expect(conversionLines(ctn)).toEqual(['1 ctn = 12 pkt', '1 pkt = 10 pcs']);
    expect(conversionLines(one)).toEqual([]);
    expect(conversionLines({ ...two, conv1: 0.5 })).toEqual(['1 ctn = 0.5 pcs']);
  });
});

describe('prefill', () => {
  test('a shop price wins over the all-shops price, as POS chooses', () => {
    const prices = [
      price({ shop_id: null, price_paise: 900 }),
      price({ shop_id: 'shop', price_paise: 1000 }),
      price({ shop_id: 'other', price_paise: 1100 }),
    ];
    expect(currentPricePaise(prices, 'shop', 'retail', 3)).toBe(1000);
    expect(currentPricePaise(prices, 'x', 'retail', 3)).toBe(900);
    expect(currentPricePaise(prices, 'shop', 'wholesale', 3)).toBeNull();
  });
  test('the box opens on the unit that already has a retail price, else the smallest unit', () => {
    expect(defaultSaleLevel(ctn, ok([price({ unit_level: 2 })]), 'shop')).toBe(2);
    expect(defaultSaleLevel(ctn, ok([]), 'shop')).toBe(3);
    expect(defaultSaleLevel(ctn, { state: 'loading' }, 'shop')).toBe(3);
    expect(defaultSaleLevel(one, ok([]), 'shop')).toBe(1);
  });
  test('fields show the current retail and wholesale for the chosen unit', () => {
    const load = ok([
      price({ unit_level: 3, price_paise: 1000 }),
      price({ kind: 'wholesale', unit_level: 3, price_paise: 900 }),
      price({ unit_level: 2, price_paise: 9500 }),
    ]);
    expect(saleFields(card(ctn), load, 'shop')).toMatchObject({
      level: 3,
      retail: '10.00',
      wsQty: '1',
      wsPrice: '9.00',
    });
    expect(saleFields(card(ctn, { level: 2 }), load, 'shop')).toMatchObject({
      level: 2,
      retail: '95.00',
      wsPrice: '',
    });
    expect(saleFields(card(ctn, { level: 3, retail: '12' }), load, 'shop').retail).toBe('12');
  });
});

describe('what a card writes', () => {
  const load = ok([price({ unit_level: 3, price_paise: 1000 })]);
  test('untouched, blank or unchanged fields write nothing', () => {
    expect(cardSaleResult(card(ctn), load, 'shop')).toEqual({ writes: [] });
    expect(cardSaleResult(card(ctn, { level: 3, retail: '' }), load, 'shop')).toEqual({
      writes: [],
    });
    expect(cardSaleResult(card(ctn, { level: 3, retail: '10.00' }), load, 'shop')).toEqual({
      writes: [],
    });
    expect(cardSaleResult(card(ctn, { level: 3, wsQty: '12', wsPrice: '' }), load, 'shop')).toEqual(
      { writes: [] },
    );
  });
  test('a changed retail price writes one retail price at that unit, in paise', () => {
    expect(cardSaleResult(card(ctn, { level: 3, retail: '12.5' }), load, 'shop')).toEqual({
      writes: [
        {
          itemId: 'i1',
          itemName: 'Biscuit',
          kind: 'retail',
          unitLevel: 3,
          unitName: 'pcs',
          pricePaise: 1250,
        },
      ],
    });
  });
  test('wholesale ₹X for N units is stored per unit when exact', () => {
    const r = cardSaleResult(card(ctn, { level: 3, wsQty: '12', wsPrice: '108' }), load, 'shop');
    expect(r.writes).toEqual([
      {
        itemId: 'i1',
        itemName: 'Biscuit',
        kind: 'wholesale',
        unitLevel: 3,
        unitName: 'pcs',
        pricePaise: 900,
      },
    ]);
  });
  test('a wholesale price that is not whole paise per unit is refused, never rounded', () => {
    const r = cardSaleResult(card(ctn, { level: 3, wsQty: '12', wsPrice: '100' }), load, 'shop');
    expect(r.writes).toEqual([]);
    expect(r.problem).toMatch(/₹100.00 for 12 pcs is not a whole number of paise per pcs/);
    expect(r.problem).toMatch(/price for 1 pcs/);
  });
  test('bad entries are refused in plain words', () => {
    const p = (sale: BillCard['sale']) => cardSaleResult(card(ctn, sale), load, 'shop').problem;
    expect(p({ level: 3, retail: '10.555' })).toMatch(/retail price in rupees/i);
    expect(p({ level: 3, retail: '0' })).toMatch(/more than ₹0/);
    expect(p({ level: 3, wsQty: '1.5', wsPrice: '10' })).toMatch(/whole number of pcs/);
    expect(p({ level: 3, wsQty: '0', wsPrice: '10' })).toMatch(/whole number of pcs/);
  });
  test('prices that could not be loaded: a typed value is written', () => {
    expect(
      cardSaleResult(card(ctn, { level: 3, retail: '10' }), { state: 'failed' }, 'shop').writes,
    ).toHaveLength(1);
  });
});

describe('bill plan', () => {
  const loads = { i1: ok([]), i2: ok([]) };
  test('one write per changed price with a client id from bill + item number + kind + unit', () => {
    const plan = salePricePlan(
      [
        card(ctn, { level: 3, retail: '10', wsPrice: '9' }),
        card(two),
        card(two, { level: 2, retail: '5' }),
      ],
      loads,
      'shop',
      'bill-1',
    );
    expect(plan.problems).toEqual([]);
    expect(plan.writes.map((w) => w.clientId)).toEqual([
      priceClientId('bill-1', 1, 'retail', 3),
      priceClientId('bill-1', 1, 'wholesale', 3),
      priceClientId('bill-1', 3, 'retail', 2),
    ]);
    expect(priceClientId('bill-1', 1, 'retail', 3)).toBe('bill-price:bill-1:1:retail:3');
  });
  test('the same price twice is written once; different prices for one unit are refused', () => {
    const same = salePricePlan(
      [card(ctn, { level: 3, retail: '10' }), card(ctn, { level: 3, retail: '10.00' })],
      loads,
      'shop',
      'b',
    );
    expect(same.writes).toHaveLength(1);
    const diff = salePricePlan(
      [card(ctn, { level: 3, retail: '10' }), card(ctn, { level: 3, retail: '11' })],
      loads,
      'shop',
      'b',
    );
    expect(diff.problems).toEqual([
      { index: 1, message: 'Item 1 sets a different retail price for Biscuit per pcs.' },
    ]);
  });
  test('card problems are reported by item number', () => {
    const plan = salePricePlan(
      [card(ctn), card(ctn, { level: 3, retail: 'x' })],
      loads,
      'shop',
      'b',
    );
    expect(plan.problems[0]!.index).toBe(1);
  });
});

describe('stored plan and writes', () => {
  const w = {
    clientId: 'bill-price:b:1:retail:3',
    itemId: 'i1',
    itemName: 'Biscuit',
    kind: 'retail' as const,
    unitLevel: 3 as const,
    unitName: 'pcs',
    pricePaise: 1000,
  };
  test('saved per bill, listed per shop, removed when empty', () => {
    savePricePlan('shop', 'b', [w]);
    savePricePlan('other', 'c', [w]);
    expect(loadPricePlan('shop', 'b')).toEqual([w]);
    expect(listPricePlans('shop')).toEqual([{ billClientId: 'b', writes: [w] }]);
    storePricePlan('shop', 'b', []);
    expect(loadPricePlan('shop', 'b')).toBeNull();
    // Never under the pending purchase prefix (it would be read as an unconfirmed bill).
    expect(Object.keys(localStorage).some((k) => k.startsWith('dsb-pending-purchase'))).toBe(false);
  });
  test('unreadable stored plans are ignored', () => {
    localStorage.setItem('dsb-bill-sale-prices:shop:z', '{bad');
    localStorage.setItem('dsb-bill-sale-prices:shop:y', JSON.stringify({ writes: [{ x: 1 }] }));
    expect(listPricePlans('shop')).toEqual([]);
  });
  test('writes run in order, one at a time; failures are returned with their reason', async () => {
    const order: string[] = [];
    const failed = await writePriceList([w, { ...w, clientId: 'two' }], async (x) => {
      order.push(x.clientId);
      if (x.clientId === 'two') throw new Error('network');
    });
    expect(order).toEqual([w.clientId, 'two']);
    expect(failed).toEqual([{ write: { ...w, clientId: 'two' }, message: 'network' }]);
  });
});
