import { getSupabaseClient } from './client';
import { errorMessage, classifyError } from './errors';

export type StockTimelineRow = Readonly<{
  at: string;
  qtyBase: number;
  sourceType: string;
}>;

/** Latest stock movements of one item (read-only, newest first). Stock itself stays ledger-derived. */
export async function listItemStockTimeline(
  shopId: string,
  itemId: string,
  limit = 50,
): Promise<StockTimelineRow[]> {
  const { data, error } = await getSupabaseClient()
    .from('stock_movements')
    .select('created_at, qty_base, source_type')
    .eq('shop_id', shopId)
    .eq('item_id', itemId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  if (error) throw new Error(errorMessage(classifyError(error), error));
  return ((data ?? []) as { created_at: string; qty_base: number; source_type: string }[]).map(
    (r) => ({ at: r.created_at, qtyBase: Number(r.qty_base), sourceType: r.source_type }),
  );
}
