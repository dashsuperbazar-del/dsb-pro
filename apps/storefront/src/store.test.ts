import { expect, test } from 'vitest';
import { addToCart, lineEstimate, newToken, type CartLine } from './store';

const rice: CartLine = {
  itemId: 'i1',
  name: 'Rice',
  level: 2,
  unit: 'kg',
  pricePaise: '9000',
  qty: 2,
};

test('the cart merges the same item and unit, keeps other units apart', () => {
  const c = addToCart(addToCart([], rice), { ...rice, qty: 0.5 });
  expect(c).toHaveLength(1);
  expect(c[0]!.qty).toBe(2.5);
  expect(
    addToCart(c, { ...rice, level: 1, unit: 'bag', pricePaise: '200000', qty: 1 }),
  ).toHaveLength(2);
});

test('the estimate is integer paise rounded like the server', () => {
  expect(lineEstimate(rice)).toBe(18000n);
  expect(lineEstimate({ ...rice, qty: 0.333, pricePaise: '1000' })).toBe(333n);
});

test('the order token is 64 hex characters and random', () => {
  const a = newToken();
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(newToken()).not.toBe(a);
});
