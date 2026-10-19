import { canonicalQuantity, parseRupeesToPaise, quantityTimesPaise } from '@dsb-pro/core';
import type { Item } from '@dsb-pro/adapters';
import type { PurchaseDraftLine } from './purchaseWorkflow';
import { deriveUnitCostFromTotal } from './purchaseCost';
import { paiseToDecimal } from './money';

// Bill entry cards (old DSB "ITEM 1, ITEM 2 …" layout). Every item of the bill is an editable card; the
// posted lines are derived from the cards with exactly the rules the old single "add line" form used
// (canonical quantity, whole-paise unit cost, a line total accepted only when it is stored exactly).
// Nothing here changes what is posted: it only decides which cards become which request lines.

export type CostMode = 'unit' | 'total';
export type BillCardDraft = {
  item: Item | null;
  /** What was typed in the item name box (kept so an unfinished search survives a reload). */
  search: string;
  unitLevel: 1 | 2 | 3;
  qty: string;
  /** Rupees as typed: the cost per unit, or the whole amount for this item when costMode is 'total'. */
  price: string;
  costMode: CostMode;
};
export type BillCard = BillCardDraft & { key: string };

export type CardResult =
  | { kind: 'blank' }
  | { kind: 'problem'; message: string }
  | { kind: 'ok'; line: PurchaseDraftLine; amountPaise: number };

let seq = 0;
const newKey = () => `card-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function emptyCard(): BillCard {
  return {
    key: newKey(),
    item: null,
    search: '',
    unitLevel: 1,
    qty: '',
    price: '',
    costMode: 'unit',
  };
}

export function isBlankCard(c: BillCardDraft): boolean {
  return !c.item && !c.search.trim() && !c.qty.trim() && !c.price.trim();
}

/** The unit names an item can be bought in, base first (old DSB "PURCHASED IN" buttons). */
export function unitChoices(item: Item): { level: 1 | 2 | 3; name: string }[] {
  const out: { level: 1 | 2 | 3; name: string }[] = [{ level: 1, name: item.unit1 }];
  if (item.unit2) out.push({ level: 2, name: item.unit2 });
  if (item.unit3) out.push({ level: 3, name: item.unit3 });
  return out;
}

export function unitName(item: Item, level: 1 | 2 | 3): string {
  return unitChoices(item).find((u) => u.level === level)?.name ?? item.unit1;
}

export function evaluateCard(c: BillCardDraft): CardResult {
  if (isBlankCard(c)) return { kind: 'blank' };
  const item = c.item;
  if (!item) return { kind: 'problem', message: 'Choose the item.' };
  if (!unitChoices(item).some((u) => u.level === c.unitLevel))
    return { kind: 'problem', message: 'Choose the unit it was bought in.' };
  let qty: string;
  try {
    qty = canonicalQuantity(c.qty);
  } catch {
    return {
      kind: 'problem',
      message: 'Enter a purchase quantity with at most 6 decimal places.',
    };
  }
  let unitPricePaise: number;
  if (c.costMode === 'total') {
    const derived = deriveUnitCostFromTotal(c.qty, c.price);
    if (!derived.ok) return { kind: 'problem', message: derived.message };
    if (!derived.exact)
      return {
        kind: 'problem',
        message:
          'This total cannot be stored exactly as a unit cost. Use the suggested unit cost, or enter the cost per unit.',
      };
    unitPricePaise = derived.unitPaise;
  } else {
    if (!c.price.trim()) return { kind: 'problem', message: 'Enter the cost per unit.' };
    try {
      unitPricePaise = parseRupeesToPaise(c.price);
    } catch {
      return { kind: 'problem', message: 'Enter the cost per unit in rupees.' };
    }
    if (!(unitPricePaise >= 0) || !Number.isSafeInteger(unitPricePaise))
      return { kind: 'problem', message: 'Enter the cost per unit.' };
  }
  let amountPaise: number;
  try {
    amountPaise = quantityTimesPaise(qty, unitPricePaise);
  } catch {
    return { kind: 'problem', message: 'This amount is too large. Check the quantity and cost.' };
  }
  return { kind: 'ok', line: { item, unitLevel: c.unitLevel, qty, unitPricePaise }, amountPaise };
}

export type BillFromCards = {
  /** Request lines in card order; blank cards are skipped. */
  lines: PurchaseDraftLine[];
  /** Cards that are started but cannot be posted yet ("Item 2: Enter the cost per unit."). */
  problems: { index: number; message: string }[];
  itemsTotalPaise: number;
};

export function billFromCards(cards: BillCardDraft[]): BillFromCards {
  const lines: PurchaseDraftLine[] = [];
  const problems: { index: number; message: string }[] = [];
  let itemsTotalPaise = 0;
  cards.forEach((c, index) => {
    const r = evaluateCard(c);
    if (r.kind === 'ok') {
      lines.push(r.line);
      itemsTotalPaise += r.amountPaise;
    } else if (r.kind === 'problem') problems.push({ index, message: r.message });
  });
  return { lines, problems, itemsTotalPaise };
}

export function cardFromLine(l: PurchaseDraftLine): BillCard {
  return {
    key: newKey(),
    item: l.item,
    search: l.item.name,
    unitLevel: l.unitLevel,
    qty: l.qty,
    price: paiseToDecimal(l.unitPricePaise),
    costMode: 'unit',
  };
}

/** Tap-to-add (recent supplier items): fills a trailing empty card, otherwise appends a new one. */
export function addLineAsCard(cards: BillCard[], line: PurchaseDraftLine): BillCard[] {
  const last = cards[cards.length - 1];
  if (last && isBlankCard(last)) return [...cards.slice(0, -1), cardFromLine(line)];
  return [...cards, cardFromLine(line)];
}

/** Switch per unit ⇄ total. The other figure is filled only when it is exact; otherwise it is cleared. */
export function switchCostMode(c: BillCard, mode: CostMode): BillCard {
  if (c.costMode === mode) return c;
  const r = evaluateCard(c);
  let price = '';
  if (r.kind === 'ok')
    price =
      mode === 'total' ? paiseToDecimal(r.amountPaise) : paiseToDecimal(r.line.unitPricePaise);
  return { ...c, costMode: mode, price };
}

/** Old (single add-line form) drafts: committed cart lines, plus the half-typed form as one more card. */
export function cardsFromDraft(d: {
  cards?: BillCardDraft[];
  cart: PurchaseDraftLine[];
  lineItem: Item | null;
  search: string;
  unitLevel: 1 | 2 | 3;
  qty: string;
  price: string;
  costMode?: CostMode;
  editingLine: number | null;
}): BillCard[] {
  if (d.cards) return d.cards.map((c) => ({ ...c, key: newKey() }));
  const cards = d.cart.map(cardFromLine);
  const pending: BillCard = {
    key: newKey(),
    item: d.lineItem,
    search: d.search,
    unitLevel: d.unitLevel,
    qty: d.qty,
    price: d.price,
    costMode: d.costMode ?? 'unit',
  };
  if (d.editingLine !== null && d.editingLine < cards.length) cards[d.editingLine] = pending;
  else if (!isBlankCard(pending)) cards.push(pending);
  return cards.length ? cards : [emptyCard()];
}

export function cardDrafts(cards: BillCard[]): BillCardDraft[] {
  return cards.map((c) => ({
    item: c.item,
    search: c.search,
    unitLevel: c.unitLevel,
    qty: c.qty,
    price: c.price,
    costMode: c.costMode,
  }));
}
