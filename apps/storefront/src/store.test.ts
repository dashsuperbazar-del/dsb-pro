import { expect, test } from 'vitest';
import { addToCart, lineEstimate, newToken, upiPayLink, type CartLine } from './store';

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

test('the UPI link carries the exact amount, payee and order reference', () => {
  const link = upiPayLink('dsb.store@okaxis', 'Dash Super Bazar', '21050', 'Z9TL7KL4XV');
  expect(link.startsWith('upi://pay?')).toBe(true);
  const q = new URLSearchParams(link.slice('upi://pay?'.length));
  expect(q.get('pa')).toBe('dsb.store@okaxis');
  expect(q.get('am')).toBe('210.50');
  expect(q.get('cu')).toBe('INR');
  expect(q.get('pn')).toBe('Dash Super Bazar');
  expect(q.get('tn')).toBe('Order Z9TL7KL4XV');
  expect(link).not.toContain('+');
});
