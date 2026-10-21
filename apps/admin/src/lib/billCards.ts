import {
  canonicalQuantity,
  parseRupeesToPaise,
  purchaseLineTotalPaise,
  quantityTimesPaise,
} from '@dsb-pro/core';
import type { Item } from '@dsb-pro/adapters';
import type { PurchaseDraftLine } from './purchaseWorkflow';
import { deriveUnitCostFromTotal } from './purchaseCost';
import { paiseToDecimal } from './money';
import { parsePercentBp, percentText } from './billExtras';

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
  /** Paise per unit typed before switching to "Total"; reused while it still makes the total exactly,
   * so a per unit / total round trip never changes the stored unit cost. */
  unitHint?: number;
  /** Optional sale prices typed in the card's "Sale prices" box (lib/billSalePrices). Never posted with
   * the bill; written to the item after the bill posts. */
  sale?: CardSale;
  /** Discount % on this item as typed (old DSB "DISCOUNT %"); blank = none. */
  discount?: string;
  /** GST % as typed (old DSB "GST %"). Blank = the rate already includes GST (sent as null); a number,
   * 0 included, is ADDED on top of the discounted amount. */
  gst?: string;
  /** The rate was filled from the supplier's last bill (usual items): shown as a suggestion while the
   * rate is still that figure. Display only; never posted. */
  suggested?: { date: string; price: string };
};
/** Typed sale price box fields; a field left undefined shows the item's current price. */
export type CardSale = { level: 1 | 2 | 3; retail?: string; wsQty?: string; wsPrice?: string };
export type BillCard = BillCardDraft & { key: string };

export type CardResult =
  | { kind: 'blank' }
  | { kind: 'problem'; message: string }
  | {
      kind: 'ok';
      line: BillLine;
      /** Item total after discount and GST: exactly the server's line total. */
      amountPaise: number;
      /** Quantity × rate, before discount and GST. */
      grossPaise: number;
    };
/** A posted line: the old add-line fields plus discount (basis points) and GST (basis points or null). */
export type BillLine = PurchaseDraftLine & { discountBp: number; gstBp: number | null };

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
  return (
    !c.item &&
    !c.search.trim() &&
    !c.qty.trim() &&
    !c.price.trim() &&
    !c.discount?.trim() &&
    !c.gst?.trim()
  );
}

/** Nothing chosen or entered yet (a half-typed search may be replaced by a scan or voice result). */
export function isUntouchedCard(c: BillCardDraft): boolean {
  return !c.item && !c.qty.trim() && !c.price.trim();
}

/** Put an item (and unit) on a card. A different item or unit clears quantity and cost, because they were
 * entered for the old one ("2 x Rs 1800" per carton must never become 2 pieces at Rs 1800). */
export function withItem<T extends BillCardDraft>(c: T, item: Item, unitLevel: 1 | 2 | 3 = 1): T {
  // Choosing the first item keeps a quantity typed before it; only a change of item or unit clears.
  if (!c.item || (c.item.id === item.id && c.unitLevel === unitLevel))
    return { ...c, item, search: item.name, unitLevel };
  // Sale prices were typed for the old item; a change of purchase unit keeps them (they name their own unit).
  // Discount and GST belong to the item; a change of unit keeps them, a different item drops them.
  const { sale, discount, gst, ...rest } = c;
  const same = c.item.id === item.id;
  return {
    ...(rest as T),
    ...(same && sale ? { sale } : {}),
    ...(same && discount !== undefined ? { discount } : {}),
    ...(same && gst !== undefined ? { gst } : {}),
    item,
    search: item.name,
    unitLevel,
    qty: '',
    price: '',
    costMode: 'unit',
    unitHint: undefined,
    // A rate suggested for the old item or unit no longer applies.
    suggested: undefined,
  };
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
    const totalPaise = derived.lineTotalPaise - derived.diffPaise;
    const hint = c.unitHint;
    if (
      hint !== undefined &&
      Number.isSafeInteger(hint) &&
      hint >= 0 &&
      quantityTimesPaise(qty, hint) === totalPaise
    )
      return withAdjustments(
        c,
        { item, unitLevel: c.unitLevel, qty, unitPricePaise: hint },
        totalPaise,
      );
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
  let grossPaise: number;
  try {
    grossPaise = quantityTimesPaise(qty, unitPricePaise);
  } catch {
    return { kind: 'problem', message: 'This amount is too large. Check the quantity and cost.' };
  }
  return withAdjustments(c, { item, unitLevel: c.unitLevel, qty, unitPricePaise }, grossPaise);
}

/** Discount and GST on a complete line; the item total is core purchaseLineTotalPaise (the server's figure). */
function withAdjustments(
  c: BillCardDraft,
  base: PurchaseDraftLine,
  grossPaise: number,
): CardResult {
  let discountBp: number;
  let gstBp: number | null;
  try {
    discountBp = parsePercentBp(c.discount ?? '') ?? 0;
  } catch {
    return { kind: 'problem', message: 'Enter the discount as a % from 0 to 100.' };
  }
  try {
    gstBp = parsePercentBp(c.gst ?? '');
  } catch {
    return { kind: 'problem', message: 'Enter GST as a % from 0 to 100, or leave it blank.' };
  }
  let amountPaise: number;
  try {
    amountPaise = purchaseLineTotalPaise({
      qty: base.qty,
      unitPricePaise: base.unitPricePaise,
      discountBp,
      gstBp,
    });
  } catch {
    return { kind: 'problem', message: 'This amount is too large. Check the quantity and cost.' };
  }
  return { kind: 'ok', line: { ...base, discountBp, gstBp }, amountPaise, grossPaise };
}

export type BillFromCards = {
  /** Request lines in card order; blank cards are skipped. */
  lines: BillLine[];
  /** Cards that are started but cannot be posted yet ("Item 2: Enter the cost per unit."). */
  problems: { index: number; message: string }[];
  itemsTotalPaise: number;
};

export function billFromCards(cards: BillCardDraft[]): BillFromCards {
  const lines: BillLine[] = [];
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

export type BillSummary = {
  /** Rows that are in the total and will be posted. */
  ready: number;
  /** Started rows that are NOT in the total (no item chosen, no quantity, a bad figure …). */
  notReady: number;
  /** Empty rows, ignored. */
  blank: number;
  /** 0-based index of the first not-ready row, or -1. */
  firstNotReady: number;
};

/** How many rows count, need a look, or are empty; so the total never hides a row silently. */
export function summarizeBill(bill: BillFromCards, cardCount: number): BillSummary {
  const ready = bill.lines.length;
  const notReady = bill.problems.length;
  return {
    ready,
    notReady,
    blank: Math.max(0, cardCount - ready - notReady),
    firstNotReady: bill.problems.length ? Math.min(...bill.problems.map((p) => p.index)) : -1,
  };
}

export function cardFromLine(
  l: PurchaseDraftLine & { discountBp?: number; gstBp?: number | null },
): BillCard {
  return {
    key: newKey(),
    item: l.item,
    search: l.item.name,
    unitLevel: l.unitLevel,
    qty: l.qty,
    price: paiseToDecimal(l.unitPricePaise),
    costMode: 'unit',
    ...(l.discountBp ? { discount: percentText(l.discountBp) } : {}),
    ...(l.gstBp !== undefined && l.gstBp !== null ? { gst: percentText(l.gstBp) } : {}),
  };
}

/** Tap-to-add (recent supplier items): fills a trailing empty card, otherwise appends a new one. */
export function addLineAsCard(cards: BillCard[], line: PurchaseDraftLine): BillCard[] {
  return addCardAtEnd(cards, cardFromLine(line));
}
export function addCardAtEnd(cards: BillCard[], card: BillCard): BillCard[] {
  const last = cards[cards.length - 1];
  if (last && isBlankCard(last)) return [...cards.slice(0, -1), card];
  return [...cards, card];
}

/** Switch per unit ⇄ total. The other figure is filled only when it is exact; otherwise it is cleared. */
export function switchCostMode(c: BillCard, mode: CostMode): BillCard {
  if (c.costMode === mode) return c;
  // The cost figure alone decides the switch (a discount or GST typo never clears the cost).
  const r = evaluateCard({ ...c, discount: '', gst: '' });
  if (r.kind !== 'ok') return { ...c, costMode: mode, price: '', unitHint: undefined };
  return mode === 'total'
    ? {
        ...c,
        costMode: mode,
        price: paiseToDecimal(r.grossPaise),
        unitHint: r.line.unitPricePaise,
      }
    : { ...c, costMode: mode, price: paiseToDecimal(r.line.unitPricePaise), unitHint: undefined };
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
  if (d.editingLine !== null && d.editingLine < cards.length) {
    // The old form was editing that cart line; a blank form means the line itself is still the entry.
    if (!isBlankCard(pending)) cards[d.editingLine] = pending;
  } else if (!isBlankCard(pending)) cards.push(pending);
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
    ...(c.unitHint !== undefined ? { unitHint: c.unitHint } : {}),
    ...(c.sale ? { sale: c.sale } : {}),
    ...(c.discount ? { discount: c.discount } : {}),
    ...(c.gst ? { gst: c.gst } : {}),
    ...(c.suggested ? { suggested: c.suggested } : {}),
  }));
}

/** What the collapsed "More" part of a card holds that is not the default ("−2%", "+5% GST", "prices"),
 * so a value there is never hidden silently. Empty when everything there is at its default. */
export function moreBadges(c: BillCardDraft): string[] {
  const out: string[] = [];
  const d = c.discount?.trim();
  const g = c.gst?.trim();
  if (d) out.push(`−${d}%`);
  if (g) out.push(`+${g}% GST`);
  const s = c.sale;
  if (s && (['retail', 'wsQty', 'wsPrice'] as const).some((k) => s[k] !== undefined))
    out.push('prices');
  return out;
}
