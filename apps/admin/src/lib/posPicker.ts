// D4b: pure helpers for the POS tap-to-add item list. Nothing here prices, totals or posts anything: the
// price comes from `pickPrice` (the same function the add-to-cart path uses) and the cart arithmetic stays
// in PosScreen / the server.
import { canonicalQuantity } from '@dsb-pro/core';

type PriceRow = { kind: string; unit_level: number; shop_id: string | null; price_paise: number };
type ItemUnits = { unit2: string | null; unit3: string | null };

/** The price the POS uses for an item: this shop's active price first, else the all-shops price. */
export function pickPrice<T extends PriceRow>(
  prices: readonly T[],
  shopId: string,
  kind: 'retail' | 'wholesale',
  level: 1 | 2 | 3,
): T | undefined {
  const matching = prices.filter((p) => p.kind === kind && p.unit_level === level);
  return matching.find((p) => p.shop_id === shopId) ?? matching.find((p) => p.shop_id === null);
}

/** The selling unit a plain add uses: the largest unit the item has (unchanged from the old Item picker). */
export function defaultSellLevel(item: ItemUnits): 1 | 2 | 3 {
  return item.unit3 ? 3 : item.unit2 ? 2 : 1;
}

const MICRO = 1_000_000;
/** Adds two quantity texts exactly (6 decimals, integer micro-units); null if either is not a plain number. */
export function addQuantity(a: string, b: string): string | null {
  const x = Number(a);
  const y = Number(b);
  if (!a.trim() || !b.trim() || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const sum = (Math.round(x * MICRO) + Math.round(y * MICRO)) / MICRO;
  try {
    return canonicalQuantity(String(sum));
  } catch {
    return null;
  }
}

export type StockState = 'out' | 'low' | null;
/** Chip for a list row. Unknown stock (not loaded) shows no chip rather than a wrong one. */
export function stockState(qty: number | null, minStock: number): StockState {
  if (qty === null) return null;
  if (qty <= 0) return 'out';
  return minStock > 0 && qty <= minStock ? 'low' : null;
}

// Recently added items, per user + shop, on this device only (a convenience: never read by any money path).
const MAX_RECENT = 30;
const key = (userId: string, shopId: string) => `dsb-pos-recent:${userId}:${shopId}`;
export function readRecent(userId: string, shopId: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key(userId, shopId)) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
/** Most recent first, an item once; returns the new list. */
export function pushRecent(list: readonly string[], itemId: string): string[] {
  return [itemId, ...list.filter((x) => x !== itemId)].slice(0, MAX_RECENT);
}
export function writeRecent(userId: string, shopId: string, list: readonly string[]) {
  try {
    localStorage.setItem(key(userId, shopId), JSON.stringify(list));
  } catch {
    /* storage may be unavailable */
  }
}
