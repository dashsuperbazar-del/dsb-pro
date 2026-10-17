import { expect, test } from 'vitest';
import type { Item, Party } from '@dsb-pro/adapters';
import { buildBatchDrafts, type BatchRow } from './batchPurchase';

const item = (id: string, name: string): Item =>
  ({
    id,
    name,
    sku: null,
    unit1: 'case',
    unit2: 'piece',
    unit3: null,
    conv1: 12,
    conv2: null,
    tax_rate_bp: 0,
    min_stock: 0,
    image_path: null,
  }) as Item;
const items = [item('i1', 'Oil'), item('i2', 'Rice')];
const parties = [{ id: 's1', name: 'Acme' }] as Party[];
let n = 0;
const newId = () => `req-${++n}`;
const row = (o: Partial<BatchRow> = {}): BatchRow => ({
  billNo: 'B-1',
  supplierId: 's1',
  date: '2026-10-10',
  itemId: 'i1',
  unitLevel: 1,
  qty: '4',
  costMode: 'unit',
  cost: '25',
  ...o,
});
const build = (rows: BatchRow[]) =>
  buildBatchDrafts(rows, items, parties, { now: 1000, newId, today: '2026-10-17' });

test('each valid row becomes its own unposted draft with its own posting identity', () => {
  const r = build([row(), row({ billNo: 'B-2', itemId: 'i2', qty: '2.5', cost: '10' })]);
  expect(r.errors).toEqual([]);
  expect(r.drafts).toHaveLength(2);
  const [a, b] = r.drafts;
  expect(a.clientId).not.toBe(b.clientId);
  expect(a).toMatchObject({
    supplier: 's1',
    billNo: 'B-1',
    businessDate: '2026-10-10',
    savedAt: 1000,
  });
  expect(a.cart).toEqual([{ item: items[0], unitLevel: 1, qty: '4', unitPricePaise: 2500 }]);
  expect(b.cart[0]).toMatchObject({ qty: '2.5', unitPricePaise: 1000 });
  expect(a.discount).toBe('');
  expect(a.editingLine).toBeNull();
});

test('line-total rows use the exact derivation and refuse totals that do not divide', () => {
  const ok = build([row({ costMode: 'total', cost: '100', qty: '4' })]);
  expect(ok.drafts[0].cart[0].unitPricePaise).toBe(2500);
  const bad = build([row({ costMode: 'total', cost: '100', qty: '3' })]);
  expect(bad.drafts).toEqual([]);
  expect(bad.errors[0]).toMatchObject({ row: 1 });
  expect(bad.errors[0].message).toMatch(/exactly/i);
});

test('one bad row saves nothing and names the row and the reason', () => {
  const r = build([
    row(),
    row({ billNo: 'B-2', supplierId: 'nope' }),
    row({ billNo: 'B-3', qty: '0' }),
    row({ billNo: 'B-4', itemId: 'gone' }),
    row({ billNo: 'B-5', unitLevel: 3 }),
    row({ billNo: 'B-6', date: '2026-02-31' }),
    row({ billNo: 'B-7', cost: '-1' }),
    row({ billNo: 'B-8', date: '2026-12-31' }),
  ]);
  expect(r.drafts).toEqual([]);
  expect(r.errors.map((e) => e.row)).toEqual([2, 3, 4, 5, 6, 7, 8]);
});

test('the same supplier and bill number twice in one batch is refused', () => {
  const r = build([row(), row({ itemId: 'i2' })]);
  expect(r.drafts).toEqual([]);
  expect(r.errors[0].message).toMatch(/twice|duplicate/i);
});

test('a blank bill number is allowed once per supplier-date but needs a supplier', () => {
  const r = build([row({ billNo: '' }), row({ billNo: '', supplierId: '' })]);
  expect(r.errors.map((e) => e.row)).toEqual([2]);
});

test('an empty batch is refused', () => {
  expect(build([]).errors[0].message).toMatch(/at least one/i);
});
