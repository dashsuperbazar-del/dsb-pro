import { expect, test } from 'vitest';
import type { Item } from '@dsb-pro/adapters';
import {
  addLineAsCard,
  billFromCards,
  cardDrafts,
  cardFromLine,
  cardsFromDraft,
  emptyCard,
  evaluateCard,
  isBlankCard,
  summarizeBill,
  switchCostMode,
  unitChoices,
  withItem,
  type BillCard,
} from './billCards';
import { purchaseLineTotalPaise } from '@dsb-pro/core';

const A = { id: 'a', name: 'Item A', unit1: 'piece' } as Item;
const C = { id: 'c', name: 'Item C', unit1: 'box', unit2: 'pack', conv1: 12 } as unknown as Item;
const card = (over: Partial<BillCard>): BillCard => ({ ...emptyCard(), ...over });

test('a blank card is skipped; a started card must be complete', () => {
  expect(evaluateCard(emptyCard())).toEqual({ kind: 'blank' });
  expect(isBlankCard(card({ search: ' ' }))).toBe(true);
  expect(evaluateCard(card({ qty: '2' }))).toMatchObject({ kind: 'problem' });
  expect(evaluateCard(card({ item: A, qty: '2' }))).toEqual({
    kind: 'problem',
    message: 'Enter the cost per unit.',
  });
  expect(evaluateCard(card({ item: A, qty: '1.1234567', price: '1' }))).toMatchObject({
    kind: 'problem',
  });
  expect(evaluateCard(card({ item: A, qty: '2', price: 'abc' }))).toMatchObject({
    kind: 'problem',
  });
});

test('per unit: exact paise and exact amount', () => {
  expect(evaluateCard(card({ item: A, qty: '2.50', price: '10.50' }))).toEqual({
    kind: 'ok',
    line: { item: A, unitLevel: 1, qty: '2.5', unitPricePaise: 1050, discountBp: 0, gstBp: null },
    amountPaise: 2625,
    grossPaise: 2625,
  });
});

test('total: derived unit cost only when exact; never silently rounded', () => {
  expect(
    evaluateCard(card({ item: C, unitLevel: 2, qty: '1.5', price: '30', costMode: 'total' })),
  ).toEqual({
    kind: 'ok',
    line: { item: C, unitLevel: 2, qty: '1.5', unitPricePaise: 2000, discountBp: 0, gstBp: null },
    amountPaise: 3000,
    grossPaise: 3000,
  });
  expect(evaluateCard(card({ item: A, qty: '3', price: '100', costMode: 'total' }))).toMatchObject({
    kind: 'problem',
    message: expect.stringContaining('cannot be stored exactly'),
  });
});

test('a unit the item does not have is refused', () => {
  expect(evaluateCard(card({ item: A, unitLevel: 2, qty: '1', price: '1' }))).toMatchObject({
    kind: 'problem',
  });
  expect(unitChoices(C).map((u) => u.name)).toEqual(['box', 'pack']);
  expect(unitChoices(A).map((u) => u.name)).toEqual(['piece']);
});

test('switching per unit and total fills the other figure only when exact', () => {
  const unit = card({ item: A, qty: '3', price: '0.07' });
  const total = switchCostMode(unit, 'total');
  expect(total).toMatchObject({ costMode: 'total', price: '0.21' });
  expect(switchCostMode(total, 'unit')).toMatchObject({ costMode: 'unit', price: '0.07' });
  const inexact = card({ item: A, qty: '3', price: '100', costMode: 'total' });
  expect(switchCostMode(inexact, 'unit')).toMatchObject({ costMode: 'unit', price: '' });
});

test('bill totals add only complete cards and report started ones by position', () => {
  const bill = billFromCards([
    card({ item: A, qty: '2', price: '10.50' }),
    emptyCard(),
    card({ item: C, unitLevel: 2, qty: '1.5', price: '30', costMode: 'total' }),
    card({ item: A, qty: '1' }),
  ]);
  expect(bill.itemsTotalPaise).toBe(5100);
  expect(bill.lines.map((l) => l.item.id)).toEqual(['a', 'c']);
  expect(bill.problems).toEqual([{ index: 3, message: 'Enter the cost per unit.' }]);
});

test('cards round-trip a cart line exactly and tap-to-add fills a trailing empty card', () => {
  const line = { item: A, unitLevel: 1 as const, qty: '3', unitPricePaise: 7 };
  const c = cardFromLine(line);
  expect(evaluateCard(c)).toMatchObject({ kind: 'ok', line });
  const start = [emptyCard()];
  expect(addLineAsCard(start, line)).toHaveLength(1);
  expect(addLineAsCard([c], line)).toHaveLength(2);
});

test('old single-form drafts become cards: cart lines plus the half-typed form, edits applied in place', () => {
  const old = {
    cart: [
      { item: A, unitLevel: 1 as const, qty: '2', unitPricePaise: 100 },
      { item: C, unitLevel: 2 as const, qty: '1', unitPricePaise: 500 },
    ],
    lineItem: A,
    search: 'Item A',
    unitLevel: 1 as const,
    qty: '4',
    price: '1.25',
    costMode: 'unit' as const,
    editingLine: null,
  };
  expect(billFromCards(cardsFromDraft(old)).lines.map((l) => [l.item.id, l.qty])).toEqual([
    ['a', '2'],
    ['c', '1'],
    ['a', '4'],
  ]);
  const editing = cardsFromDraft({ ...old, editingLine: 0 });
  expect(editing).toHaveLength(2);
  expect(editing[0]).toMatchObject({ qty: '4', price: '1.25' });
  const fresh = cardsFromDraft({
    ...old,
    lineItem: null,
    search: '',
    qty: '',
    price: '',
    cart: [],
  });
  expect(fresh).toHaveLength(1);
  expect(isBlankCard(fresh[0]!)).toBe(true);
  const saved = cardDrafts(editing);
  expect(saved[0]).not.toHaveProperty('key');
  expect(cardsFromDraft({ ...old, cards: saved }).map((c) => c.qty)).toEqual(['4', '1']);
});

test('an old draft editing a cart line with a blank form keeps that cart line', () => {
  const cart = [
    { item: A, unitLevel: 1 as const, qty: '2', unitPricePaise: 100 },
    { item: C, unitLevel: 2 as const, qty: '1', unitPricePaise: 500 },
  ];
  const cards = cardsFromDraft({
    cart,
    lineItem: null,
    search: '',
    unitLevel: 1,
    qty: '',
    price: '',
    editingLine: 1,
  });
  expect(billFromCards(cards).lines).toEqual(
    cart.map((l) => ({ ...l, discountBp: 0, gstBp: null })),
  );
});

test('switching total and back keeps the unit cost typed, when it still makes the total exactly', () => {
  // 0.5 x 10.01 = 5.005 -> 5.01 stored; deriving from 5.01 alone would give 10.02.
  const unit = card({ item: A, qty: '0.5', price: '10.01' });
  const total = switchCostMode(unit, 'total');
  expect(total).toMatchObject({ costMode: 'total', price: '5.01' });
  expect(evaluateCard(total)).toMatchObject({ kind: 'ok', line: { unitPricePaise: 1001 } });
  expect(switchCostMode(total, 'unit')).toMatchObject({ costMode: 'unit', price: '10.01' });
  // A changed total no longer matches the kept cost, so the cost is derived from the new total.
  const edited = { ...total, price: '6' };
  expect(evaluateCard(edited)).toMatchObject({ kind: 'ok', line: { unitPricePaise: 1200 } });
  expect(switchCostMode(edited, 'unit')).toMatchObject({ price: '12.00' });
});

test('discount and GST: blank GST is null (price includes GST), 0 is "0% added", totals equal core', () => {
  const base = { item: A, qty: '20', price: '8.71' };
  const blank = evaluateCard(card(base));
  expect(blank).toMatchObject({
    kind: 'ok',
    line: { discountBp: 0, gstBp: null },
    amountPaise: 17420,
  });
  const zero = evaluateCard(card({ ...base, gst: '0' }));
  expect(zero).toMatchObject({ kind: 'ok', line: { gstBp: 0 }, amountPaise: 17420 });
  // Golden case shared with core and the server: 20 x 8.71 + 5% GST = 182.91.
  const five = evaluateCard(card({ ...base, gst: '5' }));
  expect(five).toMatchObject({
    kind: 'ok',
    line: { gstBp: 500 },
    amountPaise: 18291,
    grossPaise: 17420,
  });
  expect(five.kind === 'ok' && five.amountPaise).toBe(
    purchaseLineTotalPaise({ qty: '20', unitPricePaise: 871, gstBp: 500 }),
  );
  // 3 x 99.99, 10% off, 18% GST added = 318.57 (core golden 31857).
  expect(
    evaluateCard(card({ item: A, qty: '3', price: '99.99', discount: '10', gst: '18' })),
  ).toMatchObject({
    kind: 'ok',
    line: { discountBp: 1000, gstBp: 1800 },
    amountPaise: 31857,
  });
  expect(evaluateCard(card({ ...base, discount: '12.5' }))).toMatchObject({
    line: { discountBp: 1250 },
  });
  expect(evaluateCard(card({ ...base, discount: '101' }))).toMatchObject({
    kind: 'problem',
    message: expect.stringContaining('discount'),
  });
  expect(evaluateCard(card({ ...base, gst: '5.555' }))).toMatchObject({
    kind: 'problem',
    message: expect.stringContaining('GST'),
  });
  // A discount typed on an empty card makes it a started card.
  expect(evaluateCard(card({ discount: '5' }))).toMatchObject({ kind: 'problem' });
});

test('a different item drops discount and GST; a different unit keeps them; repeat copies them', () => {
  const c = { ...card({ item: C, qty: '1', price: '1', discount: '5', gst: '12' }) };
  expect(withItem(c, C, 2)).toMatchObject({ discount: '5', gst: '12', qty: '' });
  const other = withItem(c, A, 1);
  expect(other.discount).toBeUndefined();
  expect(other.gst).toBeUndefined();
  expect(
    cardFromLine({
      item: A,
      unitLevel: 1,
      qty: '1',
      unitPricePaise: 100,
      discountBp: 250,
      gstBp: 0,
    }),
  ).toMatchObject({ discount: '2.5', gst: '0' });
  expect(
    cardFromLine({
      item: A,
      unitLevel: 1,
      qty: '1',
      unitPricePaise: 100,
      discountBp: 0,
      gstBp: null,
    }),
  ).not.toHaveProperty('gst');
  // Total mode is the amount before discount and GST (old DSB "TOTAL COST").
  const t = switchCostMode(card({ item: A, qty: '2', price: '10', gst: '5' }), 'total');
  expect(t.price).toBe('20.00');
  expect(evaluateCard(t)).toMatchObject({ amountPaise: 2100 });
});

test('summarizeBill counts ready, not-ready (typed but not in the total) and empty rows', () => {
  const cards = [
    card({ item: A, qty: '2', price: '10' }), // ready
    card({ search: 'New thing', qty: '1', price: '5' }), // name typed, never saved: not ready
    emptyCard(), // empty
    card({ item: A, qty: '1', price: '' }), // no cost: not ready
    emptyCard(),
    card({ item: A, qty: '3', price: '1' }), // ready
  ];
  const bill = billFromCards(cards);
  expect(summarizeBill(bill, cards.length)).toEqual({
    ready: 2,
    notReady: 2,
    blank: 2,
    firstNotReady: 1,
  });
  // The total still holds exactly the ready rows.
  expect(bill.itemsTotalPaise).toBe(2000 + 300);
  expect(summarizeBill(billFromCards([emptyCard()]), 1)).toEqual({
    ready: 0,
    notReady: 0,
    blank: 1,
    firstNotReady: -1,
  });
});
