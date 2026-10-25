// A confirmed "Set price" tap must never be silently lost (navigating away used to abort it).
// 1. The write itself is sent with fetch keepalive (adapters client), so leaving or reloading the page does
//    not cancel it; leaving Inventory inside the app never cancelled it.
// 2. Before sending, the write is recorded on this device; it is removed only when the server answers OK.
//    A record still present when Inventory opens again is checked against the item's current prices:
//    the same price → "saved"; otherwise the user sees it with Retry (same client id, so set_item_price
//    can never apply it twice) / Dismiss. Nothing is re-sent without a tap: a late automatic write could
//    overwrite a newer price set from another device.
import type { ItemPrice } from '@dsb-pro/adapters';

export type PendingPrice = {
  clientId: string;
  tenantId: string;
  /** The signed-in user who tapped Set price: another user of a shared device never sees the record. */
  userId: string;
  itemId: string;
  itemName: string;
  shopId: string;
  kind: ItemPrice['kind'];
  unitLevel: 1 | 2 | 3;
  unitName: string;
  pricePaise: number;
  at: number;
  /** The current price for this kind/unit/shop when Set price was tapped (null = none; absent = unknown). */
  beforePaise?: number | null;
  /** Set when the server refused or the request failed while no screen was showing it. */
  failure?: string;
};

const KEY = 'dsb.pendingPrices.v1';
// Writes of this page that are still waiting for an answer (an entry in flight is not "unknown").
const inFlight = new Map<string, Promise<unknown>>();

function read(): PendingPrice[] {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? (v as PendingPrice[]) : [];
  } catch {
    return [];
  }
}
function write(list: PendingPrice[]) {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list));
    else localStorage.removeItem(KEY);
  } catch {
    // Storage unavailable: the keepalive request still runs; only the after-the-fact check is lost.
  }
}

export function listPendingPrices(tenantId: string, userId: string): PendingPrice[] {
  return read().filter((p) => p.tenantId === tenantId && p.userId === userId);
}
export function isPriceInFlight(clientId: string) {
  return inFlight.has(clientId);
}
export function waitForPrice(clientId: string): Promise<unknown> | undefined {
  return inFlight.get(clientId);
}
export function forgetPendingPrice(clientId: string) {
  write(read().filter((p) => p.clientId !== clientId));
}
function markFailed(clientId: string, failure: string) {
  write(read().map((p) => (p.clientId === clientId ? { ...p, failure } : p)));
}

/**
 * Records the write, sends it, and forgets it only after the server's OK. On failure the record stays
 * (marked failed) so a screen that was left before the answer still shows it; the error is re-thrown.
 */
export async function sendPendingPrice<T>(
  entry: PendingPrice,
  send: (p: PendingPrice) => Promise<T>,
): Promise<T> {
  write([...read().filter((p) => p.clientId !== entry.clientId), { ...entry, failure: undefined }]);
  const run = send(entry).then(
    (v) => {
      forgetPendingPrice(entry.clientId);
      return v;
    },
    (e: unknown) => {
      markFailed(entry.clientId, e instanceof Error ? e.message : String(e));
      throw e;
    },
  );
  inFlight.set(entry.clientId, run);
  try {
    return await run;
  } finally {
    inFlight.delete(entry.clientId);
  }
}

/** The item's current price for the record's kind/unit/shop (null = none). */
export function currentPriceFor(p: PendingPrice, current: ItemPrice[]): number | null {
  const c = current.find(
    (x) =>
      x.kind === p.kind &&
      x.unit_level === p.unitLevel &&
      (x.shop_id ?? null) === (p.shopId || null),
  );
  return c ? c.price_paise : null;
}
/** A recorded write is known to be applied when the item's current price for that kind/unit/shop equals it. */
export function priceIsApplied(p: PendingPrice, current: ItemPrice[]) {
  return currentPriceFor(p, current) === p.pricePaise;
}
/**
 * What the server holds now for an unsure write. applied: it already has the user's price (forget it).
 * changed: the price is no longer the one the user saw before the change (set elsewhere, or the record
 * has no "before"), so Retry must not overwrite it without an explicit confirm. unchanged: safe to Retry.
 */
export function unsureStatus(
  p: PendingPrice,
  current: ItemPrice[],
): { state: 'applied' | 'changed' | 'unchanged'; nowPaise: number | null } {
  const nowPaise = currentPriceFor(p, current);
  if (nowPaise === p.pricePaise) return { state: 'applied', nowPaise };
  if (p.beforePaise === undefined || nowPaise !== p.beforePaise)
    return { state: 'changed', nowPaise };
  return { state: 'unchanged', nowPaise };
}
