import { expect, test } from 'vitest';
import { boundedItemOptions, ITEM_OPTION_LIMIT } from './itemOptions';

type It = { id: string; name: string; sku?: string | null };
const many = (n: number): It[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `i${i}`,
    name: `Item ${String(i).padStart(5, '0')}`,
    sku: `SKU${i}`,
  }));

test('a 10,000-item catalog yields at most the limit, not 10,000 options', () => {
  const out = boundedItemOptions(many(10_000), '', '');
  expect(out.options).toHaveLength(ITEM_OPTION_LIMIT);
  expect(out.total).toBe(10_000);
  expect(out.matches).toBe(10_000);
  expect(out.truncated).toBe(true);
});

test('the search matches name or SKU, case-insensitively, and reports how many matched', () => {
  const items = many(500);
  const out = boundedItemOptions(items, 'item 00042', '');
  expect(out.options.map((i) => i.id)).toEqual(['i42']);
  expect(out.matches).toBe(1);
  expect(boundedItemOptions(items, 'sku7', '').matches).toBeGreaterThan(1);
  expect(boundedItemOptions(items, '  ', '').matches).toBe(500);
});

test('the chosen item is always present, first, even when it is not among the first matches', () => {
  const out = boundedItemOptions(many(10_000), '', 'i9000');
  expect(out.options[0]!.id).toBe('i9000');
  expect(out.options.filter((i) => i.id === 'i9000')).toHaveLength(1);
  expect(out.options).toHaveLength(ITEM_OPTION_LIMIT + 1);
});

test('a chosen item that is already among the matches is not duplicated and nothing grows', () => {
  const out = boundedItemOptions(many(10_000), '', 'i3');
  expect(out.options.filter((i) => i.id === 'i3')).toHaveLength(1);
  expect(out.options).toHaveLength(ITEM_OPTION_LIMIT);
});

test('a chosen item that the search no longer matches stays visible so the value is never lost', () => {
  const out = boundedItemOptions(many(100), 'zzz', 'i5');
  expect(out.options.map((i) => i.id)).toEqual(['i5']);
  expect(out.matches).toBe(0);
});

test('an unknown chosen id is ignored and a small catalog is not truncated', () => {
  const out = boundedItemOptions(many(10), '', 'missing');
  expect(out.options).toHaveLength(10);
  expect(out.truncated).toBe(false);
});
