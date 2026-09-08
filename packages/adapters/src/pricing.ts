import { getSupabaseClient } from './client';
import { errorMessage } from './errors';

export type ItemPrice = { id:string; item_id:string; shop_id:string|null; kind:'retail'|'wholesale'|'mrp'|'cost_last'; unit_level:1|2|3; price_paise:number; effective_from:string; effective_to:string|null };

export async function listCurrentPrices(itemId:string):Promise<ItemPrice[]> {
 const {data,error}=await getSupabaseClient().from('item_prices').select('id,item_id,shop_id,kind,unit_level,price_paise,effective_from,effective_to').eq('item_id',itemId).is('effective_to',null);
 if(error) throw new Error(errorMessage(error)); return (data??[]) as ItemPrice[];
}
export async function setItemPrice(input:{itemId:string;shopId?:string;kind:ItemPrice['kind'];unitLevel:1|2|3;pricePaise:number;clientId:string}):Promise<string> {
 const {data,error}=await getSupabaseClient().rpc('set_item_price',{p_item_id:input.itemId,p_shop_id:input.shopId??null,p_kind:input.kind,p_unit_level:input.unitLevel,p_price_paise:input.pricePaise,p_client_id:input.clientId});
 if(error) throw new Error(errorMessage(error)); if(!data) throw new Error('Price update did not return an id.'); return data as string;
}
