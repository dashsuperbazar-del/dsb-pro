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

/** What the box shows: typed values, else the current retail for the chosen unit. The current wholesale
 * is only returned as a hint (wsNowPaise): it is never a field value, so a typed wholesale qty can never
 * divide it. */
export function saleFields(card: BillCardDraft, load: PriceLoad | undefined, shopId: string) {
  const item = card.item;
  const level = card.sale?.level ?? (item ? defaultSaleLevel(item, load, shopId) : 1);
  const r = current(load, shopId, 'retail', level);
  return {
    level,
    retail: card.sale?.retail ?? (r === null ? '' : paiseToDecimal(r)),
    wsQty: card.sale?.wsQty ?? '',
    wsPrice: card.sale?.wsPrice ?? '',
    wsNowPaise: current(load, shopId, 'wholesale', level),
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
  /** Typed wholesale for more than 1 unit, per unit. */
  wsPerUnitPaise?: number;
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
  const qtyText = f.wsQty.trim();
  const priceText = f.wsPrice.trim();
  if (qtyText && !/^[1-9]\d{0,5}$/.test(qtyText))
    return { writes: [], problem: `Wholesale qty must be a whole number of ${unit}, 1 or more.` };
  if (qtyText && !priceText)
    return {
      writes: [],
      problem: `Enter the wholesale price for ${qtyText} ${unit}, or clear the wholesale qty.`,
    };
  if (priceText) {
    const qty = Number(qtyText || '1');
    const p = rupeesToPaise(priceText);
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

/** Same bill + item + kind + unit + price → same id, so a retry never writes a price twice. The price is
 * part of the id because set_item_price returns the earlier row for a known id whatever its price: a
 * corrected price under the same bill id must be a new write, never deduped into the old value. */
export function priceClientId(
  billClientId: string,
  itemId: string,
  kind: SaleKind,
  level: 1 | 2 | 3,
  pricePaise: number,
) {
  return `bill-price:${billClientId}:${itemId}:${kind}:${level}:${pricePaise}`;
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
      writes.push({
        ...w,
        clientId: priceClientId(billClientId, w.itemId, w.kind, w.unitLevel, w.pricePaise),
      });
    }
  });
  return { writes, problems };
}

// Stored before the bill is sent, so prices still get written (or offered) after a reload. One key per
// user, shop, bill and window: a second window that is refused removes only its own plan. Never under the
// pending purchase prefix: that one is read as an unconfirmed bill.
const PREFIX = 'dsb-bill-sale-prices';
export const PLAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export type StoredPlan = {
  key: string;
  bill: string;
  savedAt: number;
  writes: PlannedPriceWrite[];
};
const userShopPrefix = (user: string, shop: string) => `${PREFIX}:${user}:${shop}:`;
export const planKey = (user: string, shop: string, bill: string, windowId: string) =>
  `${userShopPrefix(user, shop)}${bill}:${windowId}`;

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
function parse(key: string, raw: string | null): StoredPlan | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { bill?: unknown; savedAt?: unknown; writes?: unknown };
    if (
      typeof v.bill !== 'string' ||
      !Number.isSafeInteger(v.savedAt) ||
      !Array.isArray(v.writes) ||
      !v.writes.length ||
      !v.writes.every(validWrite)
    )
      return null;
    return { key, bill: v.bill, savedAt: v.savedAt as number, writes: v.writes };
  } catch {
    return null;
  }
}

/** Throws when the device cannot store it (the bill is then not sent). */
export function savePricePlan(key: string, plan: Omit<StoredPlan, 'key'>) {
  localStorage.setItem(
    key,
    JSON.stringify({ bill: plan.bill, savedAt: plan.savedAt, writes: plan.writes }),
  );
}
export function removePricePlan(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing more to do */
  }
}
/** Keeps what is still to write (same bill and age); removes the plan when nothing is left. */
export function updatePricePlan(key: string, writes: PlannedPriceWrite[]) {
  try {
    const plan = loadPricePlan(key);
    if (!plan || !writes.length) return removePricePlan(key);
    savePricePlan(key, { ...plan, writes });
  } catch {
    /* the in-page list still holds them */
  }
}
export function loadPricePlan(key: string): StoredPlan | null {
  try {
    return parse(key, localStorage.getItem(key));
  } catch {
    return null;
  }
}
/** This user's plans in this shop, oldest first. */
export function listPricePlans(user: string, shop: string): StoredPlan[] {
  const out: StoredPlan[] = [];
  try {
    const head = userShopPrefix(user, shop);
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(head)) continue;
      const plan = parse(key, localStorage.getItem(key));
      if (plan) out.push(plan);
    }
  } catch {
    /* storage unreadable: nothing to offer */
  }
  return out.sort((a, b) => a.savedAt - b.savedAt);
}

/** set_item_price refusals that the same request can never pass (item removed, role, bad price). */
export function isPermanentPriceError(message: string): boolean {
  return /item not in tenant|not permitted|invalid price/i.test(message);
}

export function ageText(savedAt: number, now: number): string {
  const min = Math.floor((now - savedAt) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
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
