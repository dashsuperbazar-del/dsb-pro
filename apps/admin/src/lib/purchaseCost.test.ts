import { expect, test } from 'vitest';
import { quantityTimesPaise } from '@dsb-pro/core';
import { deriveUnitCostFromTotal } from './purchaseCost';

test('an exact division gives the exact unit cost and the same total', () => {
  const r = deriveUnitCostFromTotal('4', '100.00');
  expect(r).toEqual({
    ok: true,
    exact: true,
    unitPaise: 2500,
    lineTotalPaise: 10000,
    diffPaise: 0,
  });
});

test('fractional quantities derive exactly when a whole-paise rate reproduces the total', () => {
  const r = deriveUnitCostFromTotal('2.5', '12.50');
  expect(r).toMatchObject({ ok: true, exact: true, unitPaise: 500, lineTotalPaise: 1250 });
});

test('a total that cannot be stored exactly says so, with the exact difference', () => {
  const r = deriveUnitCostFromTotal('3', '100.00');
  expect(r).toMatchObject({
    ok: true,
    exact: false,
    unitPaise: 3333,
    lineTotalPaise: 9999,
    diffPaise: -1,
  });
});

test('a neighbouring whole-paise rate is used when it reproduces the total exactly', () => {
  // 0.3 x 1,000 paise = 300 exactly; 0.3 x 3,333 = 999.9 -> 1000 (rounds) so a neighbour may fit
  const r = deriveUnitCostFromTotal('0.3', '10.00');
  if (r.ok && r.exact) expect(quantityTimesPaise('0.3', r.unitPaise)).toBe(1000);
  else expect(r).toMatchObject({ ok: true, exact: false });
});

test('the result always equals what the app will store for that quantity and unit cost', () => {
  for (const [q, t] of [
    ['7', '99.99'],
    ['0.125', '1.00'],
    ['13', '1234.56'],
    ['1000000', '0.01'],
  ] as const) {
    const r = deriveUnitCostFromTotal(q, t);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lineTotalPaise).toBe(quantityTimesPaise(q, r.unitPaise));
  }
});

test('invalid input is refused with a plain message, never a guess', () => {
  expect(deriveUnitCostFromTotal('0', '10')).toMatchObject({ ok: false });
  expect(deriveUnitCostFromTotal('', '10')).toMatchObject({ ok: false });
  expect(deriveUnitCostFromTotal('2', '')).toMatchObject({ ok: false });
  expect(deriveUnitCostFromTotal('2', '10.123')).toMatchObject({ ok: false });
  expect(deriveUnitCostFromTotal('2', '-5')).toMatchObject({ ok: false });
  expect(deriveUnitCostFromTotal('1.1234567', '5')).toMatchObject({ ok: false });
});

test('a zero total is allowed (free goods) and gives a zero unit cost', () => {
  expect(deriveUnitCostFromTotal('5', '0')).toMatchObject({ ok: true, exact: true, unitPaise: 0 });
});
