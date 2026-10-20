// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest';
import type { Item, ItemPrice } from '@dsb-pro/adapters';
import {
  cardSaleResult,
  conversionLines,
  currentPricePaise,
  defaultSaleLevel,
  ageText,
  isPermanentPriceError,
  listPricePlans,
  loadPricePlan,
  planKey,
  PLAN_MAX_AGE_MS,
  priceChangedQuestion,
  priceClientId,
  removePricePlan,
  salePricePlan,
  saleFields,
  savePricePlan,
  updatePricePlan,
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
  test('fields show the current retail; the current wholesale is only a hint, never a value', () => {
    const load = ok([
      price({ unit_level: 3, price_paise: 1000 }),
      price({ kind: 'wholesale', unit_level: 3, price_paise: 900 }),
      price({ unit_level: 2, price_paise: 9500 }),
    ]);
    expect(saleFields(card(ctn), load, 'shop')).toMatchObject({
      level: 3,
      retail: '10.00',
      wsQty: '',
      wsPrice: '',
      wsNowPaise: 900,
    });
    expect(saleFields(card(ctn, { level: 2 }), load, 'shop')).toMatchObject({
      level: 2,
      retail: '95.00',
      wsPrice: '',
    });
    expect(saleFields(card(ctn, { level: 3, retail: '12' }), load, 'shop').retail).toBe('12');
  });
});

describe('Retry of a price found later', () => {
  const w = {
    clientId: 'x',
    itemId: 'i1',
    itemName: 'Biscuit',
    kind: 'retail' as const,
    unitLevel: 3 as const,
    unitName: 'pcs',
    pricePaise: 1250,
  };
  test('asks only when the price now is not what the bill saw (or the new price)', () => {
    expect(priceChangedQuestion({ ...w, oldPaise: 1000 }, 1000)).toBeNull();
    expect(priceChangedQuestion({ ...w, oldPaise: 1000 }, 1250)).toBeNull();
    expect(priceChangedQuestion({ ...w, oldPaise: null }, null)).toBeNull();
    expect(priceChangedQuestion({ ...w, oldPaise: 1000 }, 1100)).toBe(
      'Biscuit retail per pcs was changed after this bill. Now ₹11.00. Replace with ₹12.50?',
    );
    expect(priceChangedQuestion({ ...w, oldPaise: 1000 }, null)).toContain(
      'Now no price. Replace with ₹12.50?',
    );
    // A plan of the previous version (no old price): ask unless the price is already the new one.
    expect(priceChangedQuestion(w, 1000)).toContain('Now ₹10.00. Replace with ₹12.50?');
    expect(priceChangedQuestion(w, 1250)).toBeNull();
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
    expect(cardSaleResult(card(ctn, { level: 3, wsQty: '', wsPrice: '' }), load, 'shop')).toEqual({
      writes: [],
    });
  });
  test('a wholesale qty without a typed wholesale price is a problem, never the current price divided', () => {
    const withWs = ok([
      price({ unit_level: 3, price_paise: 1000 }),
      price({ kind: 'wholesale', unit_level: 3, price_paise: 900 }),
    ]);
    const r = cardSaleResult(card(ctn, { level: 3, wsQty: '12' }), withWs, 'shop');
    expect(r.writes).toEqual([]);
    expect(r.problem).toBe('Enter the wholesale price for 12 pcs, or clear the wholesale qty.');
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
          oldPaise: 1000,
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
        oldPaise: null,
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
  test('one write per changed price with a client id from bill + item + kind + unit', () => {
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
      priceClientId('bill-1', 'i1', 'retail', 3, 1000),
      priceClientId('bill-1', 'i1', 'wholesale', 3, 900),
      priceClientId('bill-1', 'i2', 'retail', 2, 500),
    ]);
    expect(priceClientId('bill-1', 'i1', 'retail', 3, 1000)).toBe(
      'bill-price:bill-1:i1:retail:3:1000',
    );
    // A corrected price under the same bill id is a different write, never deduped into the old one.
    expect(priceClientId('bill-1', 'i1', 'retail', 3, 1100)).not.toBe(
      priceClientId('bill-1', 'i1', 'retail', 3, 1000),
    );
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
  test('saved per user, shop, bill and window; listed for that user and shop only', () => {
    const mine = planKey('u1', 'shop', 'b', 'win1');
    savePricePlan(mine, { bill: 'b', savedAt: 5, writes: [w] });
    savePricePlan(planKey('u1', 'other', 'c', 'win1'), { bill: 'c', savedAt: 5, writes: [w] });
    savePricePlan(planKey('u2', 'shop', 'd', 'win1'), { bill: 'd', savedAt: 5, writes: [w] });
    expect(loadPricePlan(mine)).toEqual({ key: mine, bill: 'b', savedAt: 5, writes: [w] });
    expect(listPricePlans('u1', 'shop')).toEqual([
      { key: mine, bill: 'b', savedAt: 5, writes: [w] },
    ]);
    // A second window's plan for the same bill lives under its own key: removing it keeps the first.
    const other = planKey('u1', 'shop', 'b', 'win2');
    savePricePlan(other, { bill: 'b', savedAt: 6, writes: [w] });
    removePricePlan(other);
    expect(loadPricePlan(mine)?.writes).toEqual([w]);
    updatePricePlan(mine, []);
    expect(loadPricePlan(mine)).toBeNull();
    // Never under the pending purchase prefix (it would be read as an unconfirmed bill).
    expect(Object.keys(localStorage).some((k) => k.startsWith('dsb-pending-purchase'))).toBe(false);
  });
  test('unreadable stored plans are ignored', () => {
    localStorage.setItem(planKey('u', 'shop', 'z', 'w'), '{bad');
    localStorage.setItem(
      planKey('u', 'shop', 'y', 'w'),
      JSON.stringify({ bill: 'y', savedAt: 1, writes: [{ x: 1 }] }),
    );
    expect(listPricePlans('u', 'shop')).toEqual([]);
  });
  test('errors that a retry cannot fix, plan age and its wording', () => {
    expect(isPermanentPriceError('item not in tenant')).toBe(true);
    expect(isPermanentPriceError('not permitted')).toBe(true);
    expect(isPermanentPriceError('invalid price')).toBe(true);
    expect(isPermanentPriceError("Something didn't save. Please try again in a moment.")).toBe(
      false,
    );
    expect(PLAN_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
    expect(ageText(1_000, 1_000 + 30_000)).toBe('just now');
    expect(ageText(0, 5 * 60_000)).toBe('5 min ago');
    expect(ageText(0, 3 * 3_600_000)).toBe('3 h ago');
    expect(ageText(0, 2 * 86_400_000)).toBe('2 days ago');
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
