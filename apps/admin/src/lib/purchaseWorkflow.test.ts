import { expect, test } from 'vitest';
import { repeatPurchase, purchaseStatus, rankedPurchaseParties } from './purchaseWorkflow';
const item = {
  id: 'i',
  name: 'Rice',
  unit1: 'bag',
  unit2: 'kg',
  unit3: null,
  conv1: 25,
  conv2: null,
  sku: null,
  tax_rate_bp: 0,
  min_stock: 0,
  image_path: null,
};
const bill = {
  id: 'b',
  party_id: 'p',
  bill_no: 'old',
  business_date: '2026-01-01',
  created_at: '2026-01-01',
  status: 'POSTED' as const,
  total_paise: '12500',
  subtotal_paise: '12500',
  discount_paise: '0',
  extra_charges_paise: '0',
};
const line = {
  id: 'l',
  item_id: 'i',
  item_name_snapshot: 'Rice',
  unit_name_snapshot: 'kg',
  conv1_snapshot: 25,
  conv2_snapshot: null,
  unit_level: 2 as const,
  qty: '2.5',
  unit_price_paise: '5000',
  line_total_paise: '12500',
  line_no: 1,
};
test('repeat preserves historical cost/quantity but refuses missing items, changed units and void documents', () => {
  expect(repeatPurchase(bill, [line], [item])).toEqual([
    { item, unitLevel: 2, qty: '2.5', unitPricePaise: 5000 },
  ]);
  expect(() => repeatPurchase(bill, [line], [])).toThrow(/unavailable/);
  expect(() => repeatPurchase(bill, [line], [{ ...item, conv1: 50 }])).toThrow(/changed/);
  expect(() => repeatPurchase({ ...bill, status: 'VOID' }, [line], [item])).toThrow(/void/i);
});
test('outstanding status distinguishes returns/settlement from a payment-mode label', () => {
  expect(purchaseStatus(bill, undefined)).toBe('Unavailable');
  expect(
    purchaseStatus(bill, { outstanding_paise: '12500', allocated_paise: '0', returned_paise: '0' }),
  ).toBe('Unpaid');
  expect(
    purchaseStatus(bill, {
      outstanding_paise: '10000',
      allocated_paise: '0',
      returned_paise: '2500',
    }),
  ).toBe('Partial');
  expect(
    purchaseStatus(bill, { outstanding_paise: '0', allocated_paise: '12500', returned_paise: '0' }),
  ).toBe('Settled');
});
test('supplier chips rank frequent recent suppliers and keep a predictable alphabetical tail', () => {
  const parties = [
    { id: 'z', name: 'Zulu', phone: null, gstin: null },
    { id: 'p', name: 'Daily', phone: null, gstin: null },
    { id: 'a', name: 'Alpha', phone: null, gstin: null },
  ];
  expect(rankedPurchaseParties(parties, [bill], '2026-01-02').map((p) => p.id)).toEqual([
    'p',
    'a',
    'z',
  ]);
});
