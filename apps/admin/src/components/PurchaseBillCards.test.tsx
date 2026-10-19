// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { act } from 'preact/test-utils';
import type { Item } from '@dsb-pro/adapters';
import { PurchaseBillCards } from './PurchaseBillCards';
import { billFromCards, emptyCard, type BillCard } from '../lib/billCards';

vi.mock('@dsb-pro/adapters', () => ({ listItemPurchasePrices: vi.fn().mockResolvedValue([]) }));

const items = [
  { id: 'a', name: 'Item A', unit1: 'piece' },
  { id: 'c', name: 'Item C', unit1: 'box', unit2: 'pack', conv1: 12 },
] as unknown as Item[];
const host = document.createElement('div');
let current: BillCard[] = [];

function Harness(props: { start: BillCard[]; onMessage?: (m: string) => void }) {
  const [cards, setCards] = useState(props.start);
  current = cards;
  return (
    <PurchaseBillCards
      cards={cards}
      items={items}
      onChange={setCards}
      shopId="shop"
      parties={[]}
      canSeePrices
      onMessage={props.onMessage ?? (() => {})}
    />
  );
}
const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel)!;
const byLabel = <T extends Element = HTMLInputElement>(label: string) =>
  q<T>(`[aria-label="${label}"]`);
const button = (text: string, root: ParentNode = host) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === text)!;
async function type(label: string, value: string) {
  await act(async () => {
    const el = byLabel(label);
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const click = (b: HTMLElement) => act(async () => b.click());
async function mount(start: BillCard[] = [emptyCard()]) {
  await act(async () => render(<Harness start={start} />, host));
}

beforeEach(() => {
  document.body.append(host);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(async () => {
  await act(async () => render(null, host));
  host.remove();
  vi.restoreAllMocks();
});

test('items are cards: + Add item appends an empty card and focuses its item name', async () => {
  await mount();
  expect(host.textContent).toContain('ITEM 1');
  expect(host.textContent).not.toMatch(/\bline\b/i);
  await click(button('+ Add item'));
  expect(host.textContent).toContain('ITEM 2');
  expect(document.activeElement).toBe(byLabel('Item 2 name'));
  await click(button('+ Add another item'));
  expect(current).toHaveLength(3);
});

test('typing shows matching items to tap; unit buttons carry the real unit names', async () => {
  await mount();
  await type('Item 1 name', 'item');
  const matches = byLabel<HTMLElement>('Matches for item 1');
  expect([...matches.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
    'Item A',
    'Item C',
  ]);
  await click(button('Item C', matches));
  expect(host.querySelector('[aria-label="Matches for item 1"]')).toBeNull();
  const units = byLabel<HTMLElement>('Item 1 purchased in');
  expect([...units.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['box', 'pack']);
  expect(button('box', units).getAttribute('aria-pressed')).toBe('true');
  await click(button('pack', units));
  expect(button('pack', units).getAttribute('aria-pressed')).toBe('true');
  expect(current[0]).toMatchObject({ unitLevel: 2, item: { id: 'c' } });
  expect(host.textContent).toContain('Qty (pack)');
  // Changing the name drops the chosen item, so a card can never post an item it no longer shows.
  await type('Item 1 name', 'Item');
  expect(current[0]).toMatchObject({ item: null, unitLevel: 1 });
});

test('per unit and total: the amount updates live; an inexact total is shown, never rounded', async () => {
  await mount();
  await type('Item 1 name', 'Item A');
  await click(button('Item A', byLabel<HTMLElement>('Matches for item 1')));
  await type('Item 1 quantity', '3');
  expect(q('[data-testid="item-1-amount"]').textContent).toBe('Enter the cost per unit.');
  await type('Item 1 rate ₹', '0.07');
  expect(q('[data-testid="item-1-amount"]').textContent).toBe('Amount ₹0.21');
  await click(button('Total'));
  expect(byLabel('Item 1 total ₹').value).toBe('0.21');
  await type('Item 1 total ₹', '100');
  expect(q('[data-testid="cost-derivation"]').textContent).toContain('cannot be stored exactly');
  expect(q('[data-testid="item-1-amount"]').textContent).toBe('');
  expect(billFromCards(current).lines).toEqual([]);
  await click(button('Use ₹33.33 per unit'));
  expect(byLabel('Item 1 rate ₹').value).toBe('33.33');
  expect(q('[data-testid="item-1-amount"]').textContent).toBe('Amount ₹99.99');
  expect(billFromCards(current)).toMatchObject({
    itemsTotalPaise: 9999,
    lines: [{ qty: '3', unitPricePaise: 3333, unitLevel: 1 }],
  });
});

test('× removes that card only; a filled card asks first', async () => {
  const filled: BillCard = {
    ...emptyCard(),
    item: items[0]!,
    search: 'Item A',
    qty: '1',
    price: '5',
  };
  await mount([emptyCard(), filled, { ...filled, key: 'other', qty: '2' }]);
  await click(byLabel<HTMLElement>('Remove item 1'));
  expect(window.confirm).not.toHaveBeenCalled();
  expect(current.map((c) => c.qty)).toEqual(['1', '2']);
  vi.mocked(window.confirm).mockReturnValueOnce(false);
  await click(byLabel<HTMLElement>('Remove item 1'));
  expect(current).toHaveLength(2);
  await click(byLabel<HTMLElement>('Remove item 1'));
  expect(current.map((c) => c.qty)).toEqual(['2']);
  expect(host.textContent).toContain('ITEM 1');
  expect(host.textContent).not.toContain('ITEM 2');
});

test('Speak fills only its own card, and only when exactly one item matches', async () => {
  let rec!: { onresult: (e: unknown) => void; onend: () => void };
  vi.stubGlobal(
    'webkitSpeechRecognition',
    class {
      start = vi.fn();
      stop = vi.fn();
      constructor() {
        rec = this as never;
      }
    },
  );
  const messages: string[] = [];
  const done: BillCard = {
    ...emptyCard(),
    item: items[0]!,
    search: 'Item A',
    qty: '1',
    price: '5',
  };
  await act(async () =>
    render(<Harness start={[done, emptyCard()]} onMessage={(m) => messages.push(m)} />, host),
  );
  async function say(text: string) {
    await click(byLabel<HTMLElement>('Speak item 2'));
    await act(async () => {
      rec.onresult({ results: [[{ transcript: text }]] });
      rec.onend();
    });
  }
  await say('item 3');
  expect(current[1]).toMatchObject({ item: null, search: 'item', qty: '' });
  expect(messages.at(-1)).toContain('2 items match');
  await say('item c 6 pack 20');
  expect(current[1]).toMatchObject({
    item: { id: 'c' },
    unitLevel: 2,
    qty: '6',
    price: '20',
    costMode: 'unit',
  });
  expect(current[0]).toEqual(done);
  expect(billFromCards(current).itemsTotalPaise).toBe(500 + 12000);
  vi.unstubAllGlobals();
});

test('price history opens per card on request only', async () => {
  const filled: BillCard = { ...emptyCard(), item: items[0]!, search: 'Item A' };
  await mount([filled]);
  const peek = button('Past prices for Item A');
  expect(peek.getAttribute('aria-expanded')).toBe('false');
  await click(peek);
  expect(peek.getAttribute('aria-expanded')).toBe('true');
});
