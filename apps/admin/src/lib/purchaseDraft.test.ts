// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import type { Item } from '@dsb-pro/adapters';
import {
  purchaseDraftPrefix,
  listPurchaseDrafts,
  savePurchaseDraft,
  clearPurchaseDrafts,
  restorePurchaseDraft,
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
  expect(() => listPurchaseDrafts(prefix)).toThrow();
  expect(localStorage.getItem(prefix + 'broken')).toBe('{');
});
