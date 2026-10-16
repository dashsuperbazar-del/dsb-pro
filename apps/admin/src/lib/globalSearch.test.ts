import { expect, test } from 'vitest';
import { searchEverything, GLOBAL_SEARCH_LIMIT } from './globalSearch';

const items = [
  { id: 'i1', name: 'Basmati Rice 5kg', sku: 'BAS-5' },
  { id: 'i2', name: 'Rice Bran Oil', sku: 'OIL-1' },
  { id: 'i3', name: 'Sugar', sku: null },
];
const customers = [
  { id: 'c1', name: 'Asha Rice Traders', phone: '98765 43210' },
  { id: 'c2', name: 'Ben', phone: null },
];
const suppliers = [{ id: 's1', name: 'Acme Foods', phone: '+91 22 5555 1234' }];
const data = { items, customers, suppliers };

test('needs two characters; fewer returns nothing', () => {
  expect(searchEverything('r', data)).toMatchObject({ items: [], customers: [], suppliers: [] });
  expect(searchEverything('  ', data).items).toEqual([]);
});

test('matches name, SKU and phone digits case-insensitively across the three groups', () => {
  const r = searchEverything('rice', data);
  expect(r.items.map((i) => i.id)).toEqual(['i2', 'i1']);
  expect(r.customers.map((c) => c.id)).toEqual(['c1']);
  expect(searchEverything('oil-1', data).items.map((i) => i.id)).toEqual(['i2']);
  expect(searchEverything('5555', data).suppliers.map((s) => s.id)).toEqual(['s1']);
  expect(searchEverything('98765', data).customers.map((c) => c.id)).toEqual(['c1']);
});

test('names that start with the query rank before names that merely contain it', () => {
  const r = searchEverything('rice', data);
  expect(r.items[0].name).toBe('Rice Bran Oil');
});

test('each group is capped and the caller can see it was capped', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `x${i}`, name: `Tea ${i}`, sku: null }));
  const r = searchEverything('tea', { items: many, customers: [], suppliers: [] });
  expect(r.items).toHaveLength(GLOBAL_SEARCH_LIMIT);
  expect(r.itemsTotal).toBe(40);
});
