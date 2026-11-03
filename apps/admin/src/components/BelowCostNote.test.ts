import { expect, test } from 'vitest';
import type { Item } from '@dsb-pro/adapters';
import { baseFactor } from './BelowCostNote';

test('base units per unit level for 1-, 2- and 3-unit items', () => {
  const three = { unit1: 'case', unit2: 'box', unit3: 'pc', conv1: 6, conv2: 10 } as Item;
  expect([baseFactor(three, 1), baseFactor(three, 2), baseFactor(three, 3)]).toEqual([60, 10, 1]);
  const two = { unit1: 'bag', unit2: 'kg', unit3: null, conv1: 25, conv2: null } as Item;
  expect([baseFactor(two, 1), baseFactor(two, 2)]).toEqual([25, 1]);
  const one = { unit1: 'pc', unit2: null, unit3: null, conv1: null, conv2: null } as Item;
  expect(baseFactor(one, 1)).toBe(1);
});
