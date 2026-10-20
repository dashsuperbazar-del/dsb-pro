import type { Item, SupplierPurchaseLine } from '@dsb-pro/adapters';
import { cardFromLine, unitChoices, type BillCard } from './billCards';

// "Usual items from <supplier>": the distinct items bought from one supplier on its posted bills, most
// often bought first, then most recently bought. Each row carries the LAST line of that item from this
// supplier (unit, rate, discount, GST, date). Adding rows makes cards with that unit and the last rate
// as a suggestion and an EMPTY quantity, so nothing can post until the quantity is typed.

export type UsualItem = {
  itemId: string;
  name: string;
  unitLevel: 1 | 2 | 3;
  unitName: string;
  /** The item's conversions when that bill was posted. */
  conv1: number | null;
  conv2: number | null;
  unitPricePaise: number;
  discountBp: number;
  gstBp: number | null;
  lastDate: string;
  /** Number of bills (from those read) on which this item was bought from the supplier. */
  bills: number;
};

const numOrNull = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

/**
 * The item is still bought in the unit of its last line from this supplier: the same level exists,
 * with the same name, and the item's conversions are the ones that line was posted with. A unit
 * redefined since (renamed, or a different count per unit) makes the old rate and unit stale.
 */
export function sameUnitAsLast(item: Item, u: UsualItem): boolean {
  const unit = unitChoices(item).find((c) => c.level === u.unitLevel);
  return (
    !!unit &&
    unit.name === u.unitName &&
    numOrNull(item.conv1) === u.conv1 &&
    numOrNull(item.conv2) === u.conv2
  );
}

/** lines: newest bill first (listSupplierPurchaseLines order). */
export function usualItems(lines: SupplierPurchaseLine[]): UsualItem[] {
  const byItem = new Map<string, { row: UsualItem; billIds: Set<string>; first: number }>();
  lines.forEach((l, index) => {
    const seen = byItem.get(l.item_id);
    if (seen) {
      seen.billIds.add(l.purchase_bill_id);
      return;
    }
    const price = Number(l.unit_price_paise);
    if (!Number.isSafeInteger(price) || price < 0) return;
    byItem.set(l.item_id, {
      first: index,
      billIds: new Set([l.purchase_bill_id]),
      row: {
        itemId: l.item_id,
        name: l.item_name_snapshot,
        unitLevel: l.unit_level,
        unitName: l.unit_name_snapshot,
        conv1: numOrNull(l.conv1_snapshot),
        conv2: numOrNull(l.conv2_snapshot),
        unitPricePaise: price,
        discountBp: Number(l.discount_bp) || 0,
        gstBp: l.gst_bp === null || l.gst_bp === undefined ? null : Number(l.gst_bp),
        lastDate: l.business_date,
        bills: 0,
      },
    });
  });
  return [...byItem.values()]
    .map((v) => ({ ...v, row: { ...v.row, bills: v.billIds.size } }))
    .sort(
      (a, b) =>
        b.row.bills - a.row.bills || a.first - b.first || a.row.name.localeCompare(b.row.name),
    )
    .map((v) => v.row);
}

/** Item ids already on the bill (a usual item there is shown as added and never added twice). */
export function itemsOnBill(cards: BillCard[]): Set<string> {
  return new Set(cards.flatMap((c) => (c.item ? [c.item.id] : [])));
}

/**
 * Cards for the chosen usual items: the current item record, the last unit when it is unchanged
 * (otherwise the first unit, shown on the card, and no rate), the last rate (only when `withRate`:
 * the user may see purchase prices) and discount/GST, quantity empty. Items already on the bill, or
 * no longer in the item list, are skipped and reported.
 */
export function cardsFromUsual(
  chosen: UsualItem[],
  items: Item[],
  onBill: Set<string>,
  withRate = true,
): { cards: BillCard[]; skipped: string[] } {
  const cards: BillCard[] = [];
  const skipped: string[] = [];
  for (const u of chosen) {
    const item = items.find((i) => i.id === u.itemId);
    if (!item || onBill.has(u.itemId)) {
      if (!item) skipped.push(u.name);
      continue;
    }
    const sameUnit = sameUnitAsLast(item, u);
    const card = cardFromLine({
      item,
      unitLevel: sameUnit ? u.unitLevel : 1,
      qty: '',
      unitPricePaise: u.unitPricePaise,
      discountBp: u.discountBp,
      gstBp: u.gstBp,
    });
    // A rate for another (or a redefined) unit is not a rate for this one: dropped.
    const rate = sameUnit && withRate;
    cards.push({
      ...card,
      price: rate ? card.price : '',
      ...(rate ? { suggested: { date: u.lastDate, price: card.price } } : {}),
    });
  }
  return { cards, skipped };
}

/** Device storage of the last supplier this user posted a bill to in this shop (a convenience). */
export function lastSupplierStorageKey(userId: string, shopId: string): string {
  return `dsb-last-supplier:${userId}:${shopId}`;
}
