import { expect, test } from 'vitest';
import type { Item, SupplierPurchaseLine } from '@dsb-pro/adapters';
import { cardsFromUsual, itemsOnBill, sameUnitAsLast, usualItems } from './usualItems';
import { billFromCards, emptyCard } from './billCards';

const l = (
  bill: string,
  date: string,
  item: string,
  price: string,
  more: Partial<SupplierPurchaseLine> = {},
): SupplierPurchaseLine => ({
  purchase_bill_id: bill,
  business_date: date,
  created_at: `${date}T00:00:00Z`,
  line_no: 1,
  item_id: item,
  item_name_snapshot: item.toUpperCase(),
  unit_level: 1,
  unit_name_snapshot: 'pc',
  unit_price_paise: price,
  discount_bp: 0,
  gst_bp: null,
  conv1_snapshot: null,
  conv2_snapshot: null,
  ...more,
});

test('distinct items, most bills first, then most recent; the newest line is the one kept', () => {
  const rows = usualItems([
    l('b3', '2026-10-03', 'x', '300'),
    l('b3', '2026-10-03', 'y', '310', { discount_bp: 150, gst_bp: 0 }),
    l('b2', '2026-10-02', 'y', '200'),
    l('b2', '2026-10-02', 'z', '210'),
    l('b2', '2026-10-02', 'z', '211'), // same item twice on a bill counts one bill
    l('b1', '2026-10-01', 'z', '100'),
    l('b1', '2026-10-01', 'w', 'bad'), // unreadable price: never suggested
  ]);
  expect(rows.map((r) => [r.itemId, r.bills, r.unitPricePaise])).toEqual([
    ['y', 2, 310],
    ['z', 2, 210],
    ['x', 1, 300],
  ]);
  expect(rows[0]).toMatchObject({ discountBp: 150, gstBp: 0, lastDate: '2026-10-03' });
});

test('cards: empty quantity (cannot post), last rate as a suggestion; a missing unit drops the rate', () => {
  const items = [
    { id: 'y', name: 'Y', unit1: 'box', unit2: 'pack' },
    { id: 'z', name: 'Z', unit1: 'pc' },
  ] as unknown as Item[];
  const rows = usualItems([
    l('b1', '2026-10-01', 'y', '310', { unit_level: 2, unit_name_snapshot: 'pack', gst_bp: 500 }),
    l('b1', '2026-10-01', 'z', '210', { unit_level: 2 }),
    l('b1', '2026-10-01', 'gone', '5'),
  ]);
  const onBill = itemsOnBill([emptyCard()]);
  const { cards, skipped } = cardsFromUsual(rows, items, onBill);
  expect(skipped).toEqual(['GONE']);
  expect(cards.map((c) => [c.item!.id, c.unitLevel, c.qty, c.price, c.gst])).toEqual([
    ['y', 2, '', '3.10', '5'],
    ['z', 1, '', '', undefined],
  ]);
  expect(cards[0]!.suggested).toEqual({ date: '2026-10-01', price: '3.10' });
  expect(cards[1]!.suggested).toBeUndefined();
  const bill = billFromCards(cards);
  expect(bill.lines).toEqual([]);
  expect(bill.problems).toHaveLength(2);
  // Already on the bill: not added again.
  expect(cardsFromUsual(rows, items, itemsOnBill(cards)).cards).toEqual([]);
});

test('a unit renamed or redefined since the last bill drops the remembered unit and rate', () => {
  const lines = [
    l('b1', '2026-10-01', 'y', '1200', {
      unit_level: 2,
      unit_name_snapshot: 'pack',
      conv1_snapshot: 12,
      discount_bp: 300,
    }),
  ];
  const [row] = usualItems(lines);
  const same = { id: 'y', name: 'Y', unit1: 'box', unit2: 'pack', conv1: 12 } as unknown as Item;
  const renamed = { ...same, unit2: 'pkt' } as Item;
  const recounted = { ...same, conv1: 10 } as Item;
  expect(sameUnitAsLast(same, row!)).toBe(true);
  expect(sameUnitAsLast(renamed, row!)).toBe(false);
  expect(sameUnitAsLast(recounted, row!)).toBe(false);
  const ok = cardsFromUsual([row!], [same], new Set()).cards[0]!;
  expect([ok.unitLevel, ok.price, ok.discount]).toEqual([2, '12.00', '3']);
  for (const item of [renamed, recounted]) {
    const card = cardsFromUsual([row!], [item], new Set()).cards[0]!;
    // First unit, no rate, no suggestion; the item's discount still applies.
    expect([card.unitLevel, card.price, card.suggested, card.discount]).toEqual([
      1,
      '',
      undefined,
      '3',
    ]);
  }
  // A user who may not see purchase prices gets no rate either.
  const hidden = cardsFromUsual([row!], [same], new Set(), false).cards[0]!;
  expect([hidden.unitLevel, hidden.price, hidden.suggested]).toEqual([2, '', undefined]);
});
