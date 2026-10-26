import { getSupabaseClient } from './client';
import { classifyError, errorMessage } from './errors';

export type ItemPrice = {
  id: string;
  item_id: string;
  shop_id: string | null;
  kind: 'retail' | 'wholesale' | 'mrp' | 'cost_last';
  unit_level: 1 | 2 | 3;
  price_paise: number;
  effective_from: string;
  effective_to: string | null;
};
const friendly = (error: unknown) => errorMessage(classifyError(error), error);

export async function listCurrentPrices(itemId: string): Promise<ItemPrice[]> {
  const { data, error } = await getSupabaseClient()
    .from('item_prices')
    .select('id,item_id,shop_id,kind,unit_level,price_paise,effective_from,effective_to')
    .eq('item_id', itemId)
    .is('effective_to', null);
  if (error) throw new Error(friendly(error));
  return (data ?? []) as ItemPrice[];
}
/**
 * Current retail prices of the given items (read-only, chunked so the id list stays short). Used by the
 * search and item lists to show a price beside each match; never used to write or to decide anything.
 */
export async function listRetailPrices(itemIds: string[]): Promise<ItemPrice[]> {
  const out: ItemPrice[] = [];
  for (let i = 0; i < itemIds.length; i += 100) {
    const { data, error } = await getSupabaseClient()
      .from('item_prices')
      .select('id,item_id,shop_id,kind,unit_level,price_paise,effective_from,effective_to')
      .in('item_id', itemIds.slice(i, i + 100))
      .eq('kind', 'retail')
      .is('effective_to', null);
    if (error) throw new Error(friendly(error));
    out.push(...((data ?? []) as ItemPrice[]));
  }
  return out;
}
/** The server refused the price (not permitted, invalid price…): it was definitely not written. */
export class PriceRefusedError extends Error {}
export async function setItemPrice(input: {
  itemId: string;
  shopId?: string;
  kind: ItemPrice['kind'];
  unitLevel: 1 | 2 | 3;
  pricePaise: number;
  clientId: string;
}): Promise<string> {
  const { data, error } = await getSupabaseClient().rpc('set_item_price', {
    p_item_id: input.itemId,
    p_shop_id: input.shopId ?? null,
    p_kind: input.kind,
    p_unit_level: input.unitLevel,
    p_price_paise: input.pricePaise,
    p_client_id: input.clientId,
  });
  if (error) {
    const m = friendly(error);
    throw classifyError(error) === 'user' ? new PriceRefusedError(m) : new Error(m);
  }
  if (!data) throw new Error('Price update did not return an id.');
  return data as string;
}
