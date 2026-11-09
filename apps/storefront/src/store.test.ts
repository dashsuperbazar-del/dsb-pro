import { expect, test } from 'vitest';
import {
  addToCart,
  lineEstimate,
  mobile10,
  newToken,
  orderSteps,
  parseTrackHash,
  trackHash,
  upiPayLink,
  type CartLine,
} from './store';

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

test('Indian mobile numbers: 10 digits starting 6-9, +91 or 0 dropped', () => {
  expect(mobile10('+91 98765-43210')).toBe('9876543210');
  expect(mobile10('09876543210')).toBe('9876543210');
  expect(mobile10('5876543210')).toBeNull();
  expect(mobile10('98765')).toBeNull();
});

test('the tracking link round-trips and rejects anything else', () => {
  const t = 'a'.repeat(64);
  expect(parseTrackHash(trackHash('Z9TL7KL4XV', t))).toEqual({ ref: 'Z9TL7KL4XV', token: t });
  expect(parseTrackHash('#/t/Z9TL7KL4XV.short')).toBeNull();
  expect(parseTrackHash('#/cart')).toBeNull();
});

test('pickup orders never show out for delivery; steps before the current one are done', () => {
  expect(orderSteps('READY', false).map((s) => s.key)).not.toContain('OUT_FOR_DELIVERY');
  const d = orderSteps('OUT_FOR_DELIVERY', true);
  expect(d.find((s) => s.key === 'READY')!.state).toBe('done');
  expect(d.find((s) => s.key === 'OUT_FOR_DELIVERY')!.state).toBe('now');
  expect(d.find((s) => s.key === 'DELIVERED')!.state).toBe('');
});
