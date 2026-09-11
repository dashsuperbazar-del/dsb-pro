import { getSupabaseClient } from './client';
import { classifyError, errorMessage } from './errors';
import { deleteItemImage, putItemImage } from './itemImageStorage';

export type Item = { id:string; name:string; sku:string|null; unit1:string; unit2:string|null; unit3:string|null; conv1:number|null; conv2:number|null; tax_rate_bp:number; min_stock:number; image_path:string|null };
export type Party = { id:string; name:string; phone:string|null; gstin:string|null };
export type StockRow = { tenant_id:string; shop_id:string; item_id:string; qty_base:number };
export type PurchaseLine = { itemId:string; unitLevel:1|2|3; qty:number; unitPricePaise:number };
export type ItemBarcode = { id:string; item_id:string; barcode:string; unit_level:1|2|3 };

const friendly=(error:unknown)=>errorMessage(classifyError(error),error);
function must<T>(value:T|null, error:unknown):T { if (error) throw new Error(friendly(error)); if (value===null) throw new Error('Expected data was not returned.'); return value; }

const READ_PAGE_SIZE=1000;
export async function collectPaginatedRows<T>(readPage:(from:number,to:number)=>Promise<T[]>,pageSize=READ_PAGE_SIZE):Promise<T[]> {
 if(!Number.isInteger(pageSize)||pageSize<=0) throw new Error('Page size must be a positive integer.');
 const rows:T[]=[];
 for(let from=0;;from+=pageSize){
  const page=await readPage(from,from+pageSize-1);
  rows.push(...page);
  if(page.length<pageSize)return rows;
 }
}

export async function listItems():Promise<Item[]> {
 const client=getSupabaseClient();
 return collectPaginatedRows<Item>(async(from,to)=>{
  const {data,error}=await client.from('items').select('id,name,sku,unit1,unit2,unit3,conv1,conv2,tax_rate_bp,min_stock,image_path').order('name').order('id').range(from,to);
  if(error) throw new Error(friendly(error)); return (data??[]) as Item[];
 });
}
export async function listParties():Promise<Party[]> {
 const {data,error}=await getSupabaseClient().from('parties').select('id,name,phone,gstin').order('name');
 if(error) throw new Error(friendly(error)); return (data??[]) as Party[];
}
export async function createItem(input:{tenantId:string;name:string;sku?:string;unit1:string;unit2?:string;unit3?:string;conv1?:number;conv2?:number;taxRateBp?:number;clientId:string}):Promise<Item> {
 const {data,error}=await getSupabaseClient().from('items').insert({tenant_id:input.tenantId,name:input.name,sku:input.sku??null,unit1:input.unit1,unit2:input.unit2??null,unit3:input.unit3??null,conv1:input.conv1??null,conv2:input.conv2??null,tax_rate_bp:input.taxRateBp??0,client_id:input.clientId}).select().single();
 return must(data,error) as Item;
}
export async function addItemBarcode(input:{tenantId:string;itemId:string;barcode:string;unitLevel:1|2|3;clientId:string}):Promise<ItemBarcode>{
 const barcode=input.barcode.trim(); if(!barcode) throw new Error('Barcode is required.');
 const {data,error}=await getSupabaseClient().from('item_barcodes').insert({tenant_id:input.tenantId,item_id:input.itemId,barcode,unit_level:input.unitLevel,client_id:input.clientId}).select('id,item_id,barcode,unit_level').single();
 return must(data,error) as ItemBarcode;
}
export async function findItemByBarcode(barcode:string):Promise<ItemBarcode|null>{
 const {data,error}=await getSupabaseClient().from('item_barcodes').select('id,item_id,barcode,unit_level').eq('barcode',barcode.trim()).maybeSingle();
 if(error) throw new Error(friendly(error)); return data as ItemBarcode|null;
}
export async function createParty(input:{tenantId:string;name:string;phone?:string;gstin?:string;clientId:string}):Promise<Party> {
 const {data,error}=await getSupabaseClient().from('parties').insert({tenant_id:input.tenantId,name:input.name,phone:input.phone??null,gstin:input.gstin??null,client_id:input.clientId}).select().single();
 return must(data,error) as Party;
}
export async function listStock(shopId:string):Promise<StockRow[]> {
 const {data,error}=await getSupabaseClient().from('stock_current').select('tenant_id,shop_id,item_id,qty_base').eq('shop_id',shopId);
 if(error) throw new Error(friendly(error)); return (data??[]) as StockRow[];
}
export async function getShopBusinessDate(shopId:string):Promise<string> {
 const {data,error}=await getSupabaseClient().rpc('shop_business_date',{p_shop_id:shopId});
 return must(data,error) as string;
}
export async function postPurchase(input:{shopId:string;partyId?:string;billNo?:string;businessDate:string;discountPaise?:number;extraChargesPaise?:number;clientId:string;lines:PurchaseLine[];billImagePath?:string}):Promise<string> {
 const {data,error}=await getSupabaseClient().rpc('post_purchase',{p_shop_id:input.shopId,p_party_id:input.partyId??null,p_bill_no:input.billNo??null,p_business_date:input.businessDate,p_discount_paise:input.discountPaise??0,p_extra_charges_paise:input.extraChargesPaise??0,p_client_id:input.clientId,p_lines:input.lines.map(l=>({item_id:l.itemId,unit_level:l.unitLevel,qty:l.qty,unit_price_paise:l.unitPricePaise})),p_bill_image_path:input.billImagePath??null});
 return must(data,error) as string;
}
export async function voidPurchase(purchaseId:string,clientId:string):Promise<string> {
 const {data,error}=await getSupabaseClient().rpc('void_purchase',{p_purchase_id:purchaseId,p_client_id:clientId}); return must(data,error) as string;
}
export async function archiveMaster(table:'categories'|'parties'|'items',id:string):Promise<void> {
 const {error}=await getSupabaseClient().rpc('archive_master',{p_table:table,p_id:id}); if(error) throw new Error(friendly(error));
}

export async function uploadItemImage(tenantId:string,itemId:string,file:Blob):Promise<string> {
 if(file.size>150*1024) throw new Error('Compressed item image must be 150 KB or smaller.');
 const path=`${tenantId}/items/${itemId}/${Date.now()}.webp`;
 await putItemImage(path,file); return path;
}
export async function purgeItemImage(path:string):Promise<void> {
 await deleteItemImage(path);
}
