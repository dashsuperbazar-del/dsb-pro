import type { Item, ItemPrice } from '@dsb-pro/adapters';
import { unitChoices, unitName, type BillCardDraft, type CardSale } from './billCards';
import { paiseToDecimal, rupees } from './money';

// Old DSB "Sale prices (optional — updates item)" box on each purchase bill card, and the item master's
// unit conversion shown read-only under the PURCHASED IN chips. Nothing here touches the purchase request:
// sale prices are a separate plan, written through set_item_price only after the bill has posted.
// Money is integer paise only; a wholesale price that does not divide into whole paise per unit is refused.

export type SaleKind = 'retail' | 'wholesale';
export type { CardSale };
export type PriceLoad =
  { state: 'loading' } | { state: 'failed' } | { state: 'ok'; prices: ItemPrice[] };
export type PriceWrite = {
  itemId: string;
  itemName: string;
  kind: SaleKind;
  unitLevel: 1 | 2 | 3;
  unitName: string;
  pricePaise: number;
};
export type PlannedPriceWrite = PriceWrite & { clientId: string };

const fmt = (n: number) => String(n);

/** "1 ctn = 12 pcs" (and "1 pkt = 10 pcs" for a third unit), from the item master. */
export function conversionLines(item: Item): string[] {
  const out: string[] = [];
  if (item.unit2 && item.conv1) out.push(`1 ${item.unit1} = ${fmt(item.conv1)} ${item.unit2}`);
  if (item.unit2 && item.unit3 && item.conv2)
    out.push(`1 ${item.unit2} = ${fmt(item.conv2)} ${item.unit3}`);
  return out;
}

/** The price POS would use: this shop's price, else the all-shops price. */
export function currentPricePaise(
  prices: ItemPrice[],
  shopId: string,
  kind: SaleKind,
  level: 1 | 2 | 3,
): number | null {
  const m = prices.filter((p) => p.kind === kind && p.unit_level === level);
  const chosen = m.find((p) => p.shop_id === shopId) ?? m.find((p) => p.shop_id === null);
  return chosen ? Number(chosen.price_paise) : null;
}

const levelsSmallFirst = (item: Item) =>
  unitChoices(item)
    .map((u) => u.level)
    .reverse();

/** Opens on the smallest unit that already has a retail price, else the smallest unit. */
export function defaultSaleLevel(
  item: Item,
  load: PriceLoad | undefined,
  shopId: string,
): 1 | 2 | 3 {
  const levels = levelsSmallFirst(item);
  if (load?.state === 'ok') {
    const hit = levels.find((l) => currentPricePaise(load.prices, shopId, 'retail', l) !== null);
    if (hit) return hit;
  }
  return levels[0]!;
}

function current(load: PriceLoad | undefined, shopId: string, kind: SaleKind, level: 1 | 2 | 3) {
  return load?.state === 'ok' ? currentPricePaise(load.prices, shopId, kind, level) : null;
}

/** What the box shows: typed values, else the current prices for the chosen unit. */
export function saleFields(card: BillCardDraft, load: PriceLoad | undefined, shopId: string) {
  const item = card.item;
  const level = card.sale?.level ?? (item ? defaultSaleLevel(item, load, shopId) : 1);
  const r = current(load, shopId, 'retail', level);
  const w = current(load, shopId, 'wholesale', level);
  return {
    level,
    retail: card.sale?.retail ?? (r === null ? '' : paiseToDecimal(r)),
    wsQty: card.sale?.wsQty ?? '1',
    wsPrice: card.sale?.wsPrice ?? (w === null ? '' : paiseToDecimal(w)),
  };
}

/** True when the box holds anything typed (counts as unsaved entry). */
export function hasTypedSale(card: BillCardDraft): boolean {
  const s = card.sale;
  return !!s && (s.retail !== undefined || s.wsQty !== undefined || s.wsPrice !== undefined);
}

const RUPEES = /^\d{1,11}(\.\d{0,2})?$/;
function rupeesToPaise(text: string): number | null {
  const t = text.trim();
  if (!RUPEES.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/** The prices one card would write (changed and non-blank only), or the first problem. */
export function cardSaleResult(
  card: BillCardDraft,
  load: PriceLoad | undefined,
  shopId: string,
): {
  writes: PriceWrite[];
  problem?: string;
  /** Typed wholesale for more than 1 unit, per unit. */ wsPerUnitPaise?: number;
} {
  const item = card.item;
  if (!item || !hasTypedSale(card)) return { writes: [] };
  const f = saleFields(card, load, shopId);
  const level = f.level;
  if (!unitChoices(item).some((u) => u.level === level))
    return { writes: [], problem: 'Choose the unit the sale prices are for.' };
  const unit = unitName(item, level);
  const base = { itemId: item.id, itemName: item.name, unitLevel: level, unitName: unit };
  const writes: PriceWrite[] = [];
  if (card.sale!.retail !== undefined && f.retail.trim()) {
    const p = rupeesToPaise(f.retail);
    if (p === null)
      return {
        writes: [],
        problem: 'Enter the retail price in rupees (at most 2 decimals), or leave it blank.',
      };
    if (p === 0)
      return { writes: [], problem: 'Enter a retail price more than ₹0, or leave it blank.' };
    if (p !== current(load, shopId, 'retail', level))
      writes.push({ ...base, kind: 'retail', pricePaise: p });
  }
  if ((card.sale!.wsQty !== undefined || card.sale!.wsPrice !== undefined) && f.wsPrice.trim()) {
    const qtyText = f.wsQty.trim() || '1';
    if (!/^[1-9]\d{0,5}$/.test(qtyText))
      return {
        writes: [],
        problem: `Wholesale qty must be a whole number of ${unit}, 1 or more.`,
      };
    const qty = Number(qtyText);
    const p = rupeesToPaise(f.wsPrice);
    if (p === null)
      return {
        writes: [],
        problem: 'Enter the wholesale price in rupees (at most 2 decimals), or leave it blank.',
      };
    if (p === 0)
      return { writes: [], problem: 'Enter a wholesale price more than ₹0, or leave it blank.' };
    if (p % qty !== 0)
      return {
        writes: [],
        problem: `${rupees(p)} for ${qty} ${unit} is not a whole number of paise per ${unit}. Enter the wholesale price for 1 ${unit} instead (wholesale qty 1).`,
      };
    const per = p / qty;
    if (per !== current(load, shopId, 'wholesale', level))
      writes.push({ ...base, kind: 'wholesale', pricePaise: per });
    return { writes, ...(qty > 1 ? { wsPerUnitPaise: per } : {}) };
  }
  return { writes };
}

/** Same bill + item number + kind + unit → same id, so a retry never writes a price twice. */
export function priceClientId(
  billClientId: string,
  itemNo: number,
  kind: SaleKind,
  level: 1 | 2 | 3,
) {
  return `bill-price:${billClientId}:${itemNo}:${kind}:${level}`;
}

/** Every sale price this bill would write, in card order, or the cards that need a look first. */
export function salePricePlan(
  cards: BillCardDraft[],
  loads: Record<string, PriceLoad>,
  shopId: string,
  billClientId: string,
): { writes: PlannedPriceWrite[]; problems: { index: number; message: string }[] } {
  const writes: PlannedPriceWrite[] = [];
  const problems: { index: number; message: string }[] = [];
  const seen = new Map<string, { index: number; pricePaise: number }>();
  cards.forEach((c, index) => {
    const r = cardSaleResult(c, c.item ? loads[c.item.id] : undefined, shopId);
    if (r.problem) return void problems.push({ index, message: r.problem });
    for (const w of r.writes) {
      const key = `${w.itemId}:${w.kind}:${w.unitLevel}`;
      const before = seen.get(key);
      if (before) {
        if (before.pricePaise !== w.pricePaise)
          problems.push({
            index,
            message: `Item ${before.index + 1} sets a different ${w.kind} price for ${w.itemName} per ${w.unitName}.`,
          });
        continue;
      }
      seen.set(key, { index, pricePaise: w.pricePaise });
      writes.push({ ...w, clientId: priceClientId(billClientId, index + 1, w.kind, w.unitLevel) });
    }
  });
  return { writes, problems };
}

// Stored before the bill is sent, so prices still get written (or offered for retry) after a reload.
// Never under the pending purchase prefix: that one is read as an unconfirmed bill.
const PREFIX = 'dsb-bill-sale-prices';
const planKey = (shop: string, bill: string) => `${PREFIX}:${shop}:${bill}`;

function validWrite(w: unknown): w is PlannedPriceWrite {
  const x = w as PlannedPriceWrite;
  return (
    !!x &&
    typeof x.clientId === 'string' &&
    typeof x.itemId === 'string' &&
    typeof x.itemName === 'string' &&
    (x.kind === 'retail' || x.kind === 'wholesale') &&
    [1, 2, 3].includes(x.unitLevel) &&
    typeof x.unitName === 'string' &&
    Number.isSafeInteger(x.pricePaise) &&
    x.pricePaise > 0
  );
}
function parse(raw: string | null): PlannedPriceWrite[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { writes?: unknown };
    return Array.isArray(v.writes) && v.writes.length && v.writes.every(validWrite)
      ? v.writes
      : null;
  } catch {
    return null;
  }
}

/** Throws when the device cannot store it (the bill is then not sent). */
export function savePricePlan(shop: string, bill: string, writes: PlannedPriceWrite[]) {
  localStorage.setItem(planKey(shop, bill), JSON.stringify({ writes, savedAt: Date.now() }));
}
/** Keeps what is still to write; removes the plan when nothing is left. Never throws. */
export function storePricePlan(shop: string, bill: string, writes: PlannedPriceWrite[]) {
  try {
    if (writes.length) savePricePlan(shop, bill, writes);
    else localStorage.removeItem(planKey(shop, bill));
  } catch {
    /* the in-page retry list still holds them */
  }
}
export function loadPricePlan(shop: string, bill: string): PlannedPriceWrite[] | null {
  try {
    return parse(localStorage.getItem(planKey(shop, bill)));
  } catch {
    return null;
  }
}
export function listPricePlans(
  shop: string,
): { billClientId: string; writes: PlannedPriceWrite[] }[] {
  const out: { billClientId: string; writes: PlannedPriceWrite[] }[] = [];
  try {
    const head = `${PREFIX}:${shop}:`;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(head)) continue;
      const writes = parse(localStorage.getItem(key));
      if (writes) out.push({ billClientId: key.slice(head.length), writes });
    }
  } catch {
    /* storage unreadable: nothing to offer */
  }
  return out;
}

/** One write at a time, in order; returns the ones that failed with their reason. */
export async function writePriceList(
  writes: PlannedPriceWrite[],
  write: (w: PlannedPriceWrite) => Promise<unknown>,
): Promise<{ write: PlannedPriceWrite; message: string }[]> {
  const failed: { write: PlannedPriceWrite; message: string }[] = [];
  for (const w of writes) {
    try {
      await write(w);
    } catch (e) {
      failed.push({ write: w, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return failed;
}
