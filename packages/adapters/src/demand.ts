import { getSupabaseClient } from './client';
import { classifyError, errorMessage } from './errors';

// I08: an item's recent sale and return quantities (base units) for the demand chart. Read-only.
// Only FINALIZED invoices and POSTED returns count; drafts, voids and unconfirmed returns are left out.
export type SaleMovement = { businessDate: string; baseQty: number };
export type ItemSaleMovements = {
  sales: SaleMovement[];
  returns: SaleMovement[];
  // True when a row cap was hit: the newest rows are shown but older ones in the window may be missing.
  truncated: boolean;
};

const CAP = 2000;
const CHUNK = 150;
const fail = () => new Error('The server sent unexpected sales data. Nothing is shown.');
const qty = (v: unknown) => {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw fail();
  return n;
};
const raise = (e: Parameters<typeof classifyError>[0]) => {
  throw new Error(errorMessage(classifyError(e), e));
};

async function headers(table: 'sale_invoices' | 'sale_returns', ids: string[]) {
  const client = getSupabaseClient();
  const out = new Map<string, { status: unknown; business_date: unknown }>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const r = await client
      .from(table)
      .select('id,status,business_date')
      .in('id', ids.slice(i, i + CHUNK));
    if (r.error) raise(r.error);
    if (!Array.isArray(r.data)) throw fail();
    for (const h of r.data) out.set(h.id as string, h);
  }
  return out;
}

// `since` is a YYYY-MM-DD business date. Rows are pre-filtered by created_at one day earlier (time-zone
// margin); a document entered before `since` but dated on/after it (post-dated) would be missed.
export async function listItemSaleMovements(
  shopId: string,
  itemId: string,
  since: string,
): Promise<ItemSaleMovements> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error('Invalid date.');
  const from = new Date(Date.parse(`${since}T00:00:00Z`) - 86_400_000).toISOString();
  const client = getSupabaseClient();
  const [lines, rets] = await Promise.all([
    client
      .from('sale_invoice_items')
      .select('sale_invoice_id,base_qty')
      .eq('shop_id', shopId)
      .eq('item_id', itemId)
      .is('deleted_at', null)
      .gte('created_at', from)
      .order('created_at', { ascending: false })
      .limit(CAP),
    client
      .from('sale_return_items')
      .select('sale_return_id,base_qty')
      .eq('shop_id', shopId)
      .eq('item_id', itemId)
      .is('deleted_at', null)
      .gte('created_at', from)
      .order('created_at', { ascending: false })
      .limit(CAP),
  ]);
  if (lines.error) raise(lines.error);
  if (rets.error) raise(rets.error);
  if (!Array.isArray(lines.data) || !Array.isArray(rets.data)) throw fail();
  const inv = await headers('sale_invoices', [
    ...new Set(lines.data.map((l) => l.sale_invoice_id as string)),
  ]);
  const ret = await headers('sale_returns', [
    ...new Set(rets.data.map((l) => l.sale_return_id as string)),
  ]);
  const pick = (
    rows: { base_qty: unknown }[],
    key: (r: never) => string,
    map: typeof inv,
    ok: string,
  ) => {
    const out: SaleMovement[] = [];
    for (const r of rows) {
      const h = map.get(key(r as never));
      // A document we cannot see, or one not in its counted state, is not part of demand.
      if (!h || h.status !== ok) continue;
      if (typeof h.business_date !== 'string') throw fail();
      out.push({ businessDate: h.business_date, baseQty: qty(r.base_qty) });
    }
    return out;
  };
  return {
    sales: pick(
      lines.data,
      (r: { sale_invoice_id: string }) => r.sale_invoice_id,
      inv,
      'FINALIZED',
    ),
    returns: pick(rets.data, (r: { sale_return_id: string }) => r.sale_return_id, ret, 'POSTED'),
    truncated: lines.data.length >= CAP || rets.data.length >= CAP,
  };
}
