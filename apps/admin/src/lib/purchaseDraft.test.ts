// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import type { Item } from '@dsb-pro/adapters';
import {
  purchaseDraftPrefix,
  listPurchaseDrafts,
  savePurchaseDraft,
  clearPurchaseDrafts,
  scanPurchaseDrafts,
  restorePurchaseDraft,
  staleDrafts,
  removePurchaseDrafts,
  hasTypedPurchaseInput,
  type PurchaseDraft,
} from './purchaseDraft';
const item = { id: 'a', name: 'Oil', unit1: 'case', unit2: 'jar', conv1: 6 } as Item;
const draft = (): PurchaseDraft => ({
  version: 1,
  clientId: 'request',
  savedAt: 1,
  supplier: '',
  billNo: 'B1',
  businessDate: '2026-10-13',
  discount: '5',
  extra: '2',
  cart: [{ item, qty: '0.5', unitLevel: 1, unitPricePaise: 1234 }],
  search: 'Oil',
  lineItem: item,
  unitLevel: 2,
  qty: '3.25',
  price: '7.45',
  editingLine: 0,
});
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
test('every unfinished field and editing row survives, scoped to user and shop', () => {
  const prefix = purchaseDraftPrefix('u', 's');
  savePurchaseDraft(prefix, 'window', draft());
  expect(listPurchaseDrafts(prefix)[0].draft).toEqual(draft());
  expect(listPurchaseDrafts(purchaseDraftPrefix('other', 's'))).toEqual([]);
  expect(listPurchaseDrafts(purchaseDraftPrefix('u', 'other'))).toEqual([]);
  expect(restorePurchaseDraft(draft(), [item], []).clientId).toBe('request');
});
test('two editors keep their own snapshots, and confirmation clears only the matching identity', () => {
  const prefix = purchaseDraftPrefix('u', 's');
  savePurchaseDraft(prefix, 'one', draft());
  savePurchaseDraft(prefix, 'two', { ...draft(), price: '9', savedAt: 2 });
  savePurchaseDraft(prefix, 'three', { ...draft(), clientId: 'other' });
  expect(listPurchaseDrafts(prefix)).toHaveLength(3);
  clearPurchaseDrafts(prefix, 'request');
  expect(listPurchaseDrafts(prefix).map((s) => s.draft.clientId)).toEqual(['other']);
});
test('unit changes and unavailable supplier refuse restore without removing the original snapshot', () => {
  const prefix = purchaseDraftPrefix('u', 's');
  savePurchaseDraft(prefix, 'one', draft());
  expect(() => restorePurchaseDraft(draft(), [{ ...item, conv1: 12 }], [])).toThrow(
    'units changed',
  );
  expect(() => restorePurchaseDraft({ ...draft(), supplier: 'missing' }, [item], [])).toThrow(
    'supplier is unavailable',
  );
  expect(listPurchaseDrafts(prefix)).toHaveLength(1);
});
test('storage denial, discarded writes and malformed data never claim durable success', () => {
  const prefix = purchaseDraftPrefix('u', 's');
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {});
  expect(() => savePurchaseDraft(prefix, 'one', draft())).toThrow('did not keep');
  write.mockImplementation(() => {
    throw new Error('quota');
  });
  expect(() => savePurchaseDraft(prefix, 'one', draft())).toThrow('quota');
  write.mockRestore();
  localStorage.setItem(prefix + 'broken', '{');
  expect(localStorage.getItem(prefix + 'broken')).toBe('{');
});

test('VF-016: an unreadable snapshot is reported apart and never hides readable drafts', () => {
  const prefix = purchaseDraftPrefix('u', 's');
  savePurchaseDraft(prefix, 'one', draft());
  localStorage.setItem(prefix + 'broken:w', '{');
  localStorage.setItem(prefix + 'old:w', JSON.stringify({ ...draft(), version: 9 }));
  const scan = scanPurchaseDrafts(prefix);
  expect(scan.drafts.map((d) => d.draft.clientId)).toEqual(['request']);
  expect(scan.unreadable).toEqual([prefix + 'broken:w', prefix + 'old:w']);
  expect(listPurchaseDrafts(prefix)).toHaveLength(1);
  // Nothing is deleted by scanning.
  expect(localStorage.getItem(prefix + 'broken:w')).toBe('{');
});
test('VF-016: a save succeeds and returns its key even beside an unreadable snapshot', () => {
  const prefix = purchaseDraftPrefix('u', 's');
  localStorage.setItem(prefix + 'broken:w', '{');
  expect(savePurchaseDraft(prefix, 'one', draft())).toBe(prefix + 'request:one');
});

test('VF-017: a saved line keeps only what restore compares, not the whole item record', () => {
  const prefix = purchaseDraftPrefix('u', 's');
  const big = {
    ...item,
    description: 'x'.repeat(5000),
    image: 'y'.repeat(5000),
  } as unknown as Item;
  const d = {
    ...draft(),
    cart: [{ item: big, qty: '1', unitLevel: 1 as const, unitPricePaise: 100 }],
    lineItem: big,
  };
  const key = savePurchaseDraft(prefix, 'w', d);
  const raw = localStorage.getItem(key) as string;
  expect(raw.length).toBeLessThan(1500);
  expect(raw).not.toContain('xxxx');
  const back = listPurchaseDrafts(prefix)[0].draft;
  expect(back.cart[0].item).toEqual(item);
  expect(restorePurchaseDraft(back, [item], []).cart[0].item).toBe(item);
});

test('VF-017: an oversized draft is refused with a plain message and nothing is half-written', () => {
  const prefix = purchaseDraftPrefix('u', 's');
  const lines = Array.from({ length: 4000 }, (_, i) => ({
    item: { ...item, id: `i${i}`, name: 'N'.repeat(60) } as Item,
    qty: '1',
    unitLevel: 1 as const,
    unitPricePaise: 100,
  }));
  expect(() =>
    savePurchaseDraft(prefix, 'w', { ...draft(), cart: lines, editingLine: null }),
  ).toThrow(/too large/i);
  expect(localStorage.length).toBe(0);
});

test('VF-017: staleDrafts lists only snapshots older than the cut-off; removing is explicit', () => {
  const prefix = purchaseDraftPrefix('u', 's');
  const day = 86_400_000;
  const now = 100 * day;
  savePurchaseDraft(prefix, 'w', { ...draft(), clientId: 'old', savedAt: now - 40 * day });
  savePurchaseDraft(prefix, 'w', { ...draft(), clientId: 'new', savedAt: now - 2 * day });
  const { drafts } = scanPurchaseDrafts(prefix);
  const stale = staleDrafts(drafts, now, 30);
  expect(stale.map((s) => s.draft.clientId)).toEqual(['old']);
  expect(scanPurchaseDrafts(prefix).drafts).toHaveLength(2);
  removePurchaseDrafts(stale.map((s) => s.key));
  expect(scanPurchaseDrafts(prefix).drafts.map((s) => s.draft.clientId)).toEqual(['new']);
});

test('P04: the cost entry mode is saved with the draft and an unknown mode is unreadable', () => {
  const prefix = purchaseDraftPrefix('u', 's');
  const key = savePurchaseDraft(prefix, 'w', { ...draft(), price: '100', costMode: 'total' });
  expect(listPurchaseDrafts(prefix)[0].draft.costMode).toBe('total');
  // older drafts have no mode and mean per-unit
  localStorage.removeItem(key);
  savePurchaseDraft(prefix, 'w', draft());
  expect(listPurchaseDrafts(prefix)[0].draft.costMode).toBeUndefined();
  expect(() => savePurchaseDraft(prefix, 'w', { ...draft(), costMode: 'weird' as never })).toThrow(
    /unreadable/,
  );
});

test('N08: typed purchase input is dirty; a preselected supplier alone is not', () => {
  const blank = {
    ...draft(),
    supplier: 's',
    billNo: '',
    discount: '',
    extra: '',
    cart: [],
    qty: '',
    price: '',
    lineItem: null,
    document: null,
  };
  expect(hasTypedPurchaseInput(blank)).toBe(false);
  expect(hasTypedPurchaseInput({ ...blank, billNo: 'A1' })).toBe(true);
  expect(hasTypedPurchaseInput({ ...blank, qty: '2' })).toBe(true);
  expect(hasTypedPurchaseInput({ ...blank, lineItem: item })).toBe(true);
  expect(hasTypedPurchaseInput({ ...blank, cart: [{} as never] })).toBe(true);
});

test('bill entry cards (complete or half-typed) survive a save and restore against the current catalog', () => {
  const prefix = purchaseDraftPrefix('u', 's');
  const cards = [
    { item, search: 'Oil', unitLevel: 2 as const, qty: '3', price: '', costMode: 'unit' as const },
    {
      item: null,
      search: 'ric',
      unitLevel: 1 as const,
      qty: '',
      price: '',
      costMode: 'total' as const,
    },
  ];
  const d = { ...draft(), editingLine: null, cards };
  savePurchaseDraft(prefix, 'window', d);
  expect(listPurchaseDrafts(prefix)[0].draft.cards).toEqual(cards);
  const fresh = { ...item, name: 'Oil (renamed)' };
  expect(restorePurchaseDraft(d, [fresh], []).cards?.[0]?.item?.name).toBe('Oil (renamed)');
  expect(() => restorePurchaseDraft(d, [{ ...item, unit2: 'tin' }], [])).toThrow(/units changed/);
  localStorage.setItem(
    `${prefix}x:y`,
    JSON.stringify({ ...d, cards: [{ ...cards[0], costMode: 'x' }] }),
  );
  expect(scanPurchaseDrafts(prefix).unreadable).toEqual([`${prefix}x:y`]);
  const blank = {
    ...d,
    billNo: '',
    discount: '',
    extra: '',
    cart: [],
    qty: '',
    price: '',
    lineItem: null,
  };
  expect(hasTypedPurchaseInput({ ...blank, cards: [{ ...cards[1]!, search: '' }] })).toBe(false);
  expect(hasTypedPurchaseInput({ ...blank, cards: [{ ...cards[1]!, qty: '1' }] })).toBe(true);
  expect(hasTypedPurchaseInput({ ...blank, cards: [cards[1]!] })).toBe(true);
  expect(hasTypedPurchaseInput({ ...blank, cards: [{ ...cards[1]!, search: ' ' }] })).toBe(false);
  // A unit cost kept across a per unit / total switch is stored with the card.
  savePurchaseDraft(prefix, 'hint', { ...d, cards: [{ ...cards[0]!, unitHint: 1001 }] });
  expect(() =>
    savePurchaseDraft(prefix, 'bad', { ...d, cards: [{ ...cards[0]!, unitHint: -1 }] }),
  ).toThrow(/unreadable/);
});

test('typed sale prices are kept with the draft and count as unsaved entry', () => {
  const prefix = purchaseDraftPrefix('u', 's');
  const sale = { level: 2 as const, retail: '12.50', wsQty: '12' };
  const card = {
    item,
    search: 'Oil',
    unitLevel: 1 as const,
    qty: '',
    price: '',
    costMode: 'unit' as const,
    sale,
  };
  const d = { ...draft(), editingLine: null, cards: [card] };
  savePurchaseDraft(prefix, 'w', d);
  expect(listPurchaseDrafts(prefix)[0].draft.cards?.[0]?.sale).toEqual(sale);
  expect(restorePurchaseDraft(d, [item], []).cards?.[0]?.sale).toEqual(sale);
  expect(() =>
    savePurchaseDraft(prefix, 'bad', { ...d, cards: [{ ...card, sale: { level: 4 } as never }] }),
  ).toThrow(/unreadable/);
  const blank = {
    ...d,
    billNo: '',
    discount: '',
    extra: '',
    cart: [],
    qty: '',
    price: '',
    lineItem: null,
    document: null,
  };
  const bare = { ...card, item: null, search: '' };
  expect(hasTypedPurchaseInput({ ...blank, cards: [{ ...bare, sale: { level: 1 } }] })).toBe(false);
  expect(
    hasTypedPurchaseInput({ ...blank, cards: [{ ...bare, sale: { level: 1, retail: '5' } }] }),
  ).toBe(true);
});
