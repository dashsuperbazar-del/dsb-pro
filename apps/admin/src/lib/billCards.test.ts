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
  switchCostMode,
  unitChoices,
  type BillCard,
} from './billCards';

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
    line: { item: A, unitLevel: 1, qty: '2.5', unitPricePaise: 1050 },
    amountPaise: 2625,
  });
});

test('total: derived unit cost only when exact; never silently rounded', () => {
  expect(
    evaluateCard(card({ item: C, unitLevel: 2, qty: '1.5', price: '30', costMode: 'total' })),
  ).toEqual({
    kind: 'ok',
    line: { item: C, unitLevel: 2, qty: '1.5', unitPricePaise: 2000 },
    amountPaise: 3000,
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
