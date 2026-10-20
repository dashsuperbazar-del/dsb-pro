import { expect, test } from 'vitest';
import { purchaseBillTotals } from '@dsb-pro/core';
import {
  billTotals,
  chargeRowsFromExtra,
  evaluateCharges,
  gstHint,
  isV2Pending,
  parsePercentBp,
  pendingImages,
  percentText,
  postButtonText,
  roundOffText,
} from './billExtras';

test('percentages become basis points exactly; blank is null; bad text is refused', () => {
  expect(parsePercentBp('')).toBeNull();
  expect(parsePercentBp('  ')).toBeNull();
  expect(parsePercentBp('0')).toBe(0);
  expect(parsePercentBp('5')).toBe(500);
  expect(parsePercentBp('12.5')).toBe(1250);
  expect(parsePercentBp('18.00')).toBe(1800);
  expect(parsePercentBp('0.01')).toBe(1);
  expect(parsePercentBp('100')).toBe(10_000);
  for (const bad of ['100.01', '101', '-1', '5.555', 'abc', '5%', '1e2'])
    expect(() => parsePercentBp(bad)).toThrow();
  expect([0, 1, 500, 1250, 1800, 10_000].map(percentText)).toEqual([
    '0',
    '0.01',
    '5',
    '12.5',
    '18',
    '100',
  ]);
});

test('the GST hint says what blank and 0 mean', () => {
  expect(gstHint('')).toBe('GST blank: the rate already includes GST. Nothing is added.');
  expect(gstHint('0')).toBe('0% added: no GST on this item.');
  expect(gstHint('5')).toBe('5% GST added on top of the rate.');
  expect(gstHint('x')).toContain('percentage');
});

test('named charges: blank rows skipped, started rows complete, sum exact', () => {
  const r = evaluateCharges([
    { label: 'Transport', amount: '25.50' },
    { label: '', amount: '' },
    { label: ' Loading ', amount: '4.49' },
  ]);
  expect(r).toEqual({
    charges: [
      { label: 'Transport', amountPaise: 2550 },
      { label: 'Loading', amountPaise: 449 },
    ],
    problems: [],
    totalPaise: 2999,
  });
  expect(evaluateCharges([{ label: '', amount: '5' }]).problems[0]!.message).toContain('Name');
  expect(evaluateCharges([{ label: 'X', amount: '' }]).problems[0]!.message).toContain('amount');
  expect(evaluateCharges([{ label: 'X', amount: '0' }]).problems[0]!.message).toContain('more');
  expect(evaluateCharges([{ label: 'X', amount: '1.005' }]).problems).toHaveLength(1);
  expect(evaluateCharges([{ label: 'X'.repeat(61), amount: '1' }]).problems).toHaveLength(1);
  expect(chargeRowsFromExtra('2.25')).toMatchObject([{ label: 'Extra charges', amount: '2.25' }]);
  expect(chargeRowsFromExtra('')).toEqual([]);
});

test('bill totals equal core purchaseBillTotals (the server figure) including round-off', () => {
  const cases = [
    {
      lines: [{ qty: '20', unitPricePaise: 871, discountBp: 0, gstBp: 500 }],
      discount: '',
      charges: [],
    },
    {
      lines: [
        { qty: '3', unitPricePaise: 9999, discountBp: 1000, gstBp: 1800 },
        { qty: '1.333', unitPricePaise: 7550, discountBp: 700, gstBp: 500 },
        { qty: '0.145', unitPricePaise: 100, discountBp: 0, gstBp: null },
      ],
      discount: '12.34',
      charges: [{ label: 'Transport', amountPaise: 2575 }],
    },
    {
      lines: [{ qty: '1', unitPricePaise: 10049, discountBp: 0, gstBp: null }],
      discount: '',
      charges: [],
    },
    {
      lines: [{ qty: '1', unitPricePaise: 10050, discountBp: 0, gstBp: 0 }],
      discount: '',
      charges: [],
    },
  ];
  for (const c of cases) {
    const ours = billTotals(c.lines, c.discount, c.charges);
    const core = purchaseBillTotals({
      lines: c.lines,
      discountPaise: c.discount ? Math.round(Number(c.discount) * 100) : 0,
      charges: c.charges,
    });
    expect(ours).toEqual({ ok: true, discountPaise: c.discount ? 1234 : 0, ...core });
  }
  expect(billTotals(cases[2]!.lines, '', [])).toMatchObject({
    roundOffPaise: -49,
    totalPaise: 10000,
  });
  expect(billTotals(cases[3]!.lines, '', [])).toMatchObject({
    roundOffPaise: 50,
    totalPaise: 10100,
  });
  expect(billTotals(cases[0]!.lines, '500', [])).toMatchObject({ ok: false });
  expect(billTotals(cases[0]!.lines, '1.234', [])).toMatchObject({ ok: false });
});

test('round-off and post button text', () => {
  expect(roundOffText(9)).toBe('Round off +₹0.09');
  expect(roundOffText(-49)).toBe('Round off −₹0.49');
  expect(roundOffText(0)).toBe('Round off ₹0.00');
  expect(postButtonText('credit', 4800)).toBe('Post purchase');
  expect(postButtonText('cash', 4800)).toBe('Post and pay ₹48.00 by Cash');
  expect(postButtonText('upi', 4800)).toBe('Post and pay ₹48.00 by UPI');
  expect(postButtonText('cash', 0)).toBe('Post purchase');
});

test('pending purchases: v1 entries stay v1; photos of either version', () => {
  const v1 = {
    shopId: 's',
    clientId: 'c',
    businessDate: '2026-10-20',
    lines: [],
    billImagePath: 'p1',
  };
  expect(isV2Pending(v1)).toBe(false);
  expect(pendingImages(v1)).toEqual(['p1']);
  const v2 = { api: 'v2' as const, shopId: 's', clientId: 'c', lines: [], images: ['a', 'b'] };
  expect(isV2Pending(v2)).toBe(true);
  expect(pendingImages(v2)).toEqual(['a', 'b']);
});
