import { getSupabaseClient } from './client';
import { classifyError, errorMessage } from './errors';

export type ReturnType='SALE'|'PURCHASE';
export type ReturnDisposition='RETURN_TO_SELLABLE'|'DAMAGED'|'EXPIRED'|'SUPPLIER_RETURN';
export type ReturnSource={id:string;doc_no:string;business_date:string;total_paise:number;party_name?:string|null;customer_name?:string|null};
export type ReturnableLine={
  id:string;item_id:string;item_name_snapshot:string;unit_name_snapshot:string;qty:number;base_qty:number;
  returned_qty:number;remaining_qty:number;
};
export type PostedReturn={
  id:string;doc_no:string;business_date:string;status:'DRAFT'|'POSTED'|'VOID';total_paise:number;
  cash_refund_paise?:number;balance_credit_paise?:number;created_at:string;return_type:ReturnType;
};
export type ReturnLineInput={sourceLineId:string;qty:number;disposition:ReturnDisposition};
type SaleSourceRow={id:string;doc_no:string;business_date:string;total_paise:number;customer:{name:string}|null};
type PurchaseSourceRow={id:string;bill_no:string|null;business_date:string;total_paise:number;party:{name:string}|null};
type SourceLineRow={id:string;item_id:string;item_name_snapshot:string;unit_name_snapshot:string;qty:number;base_qty:number};
type ReturnIdRow={id:string};
type ReturnedLineRow=Record<string,string|number> & {qty:number};
type SaleReturnRow=Omit<PostedReturn,'return_type'>;
type PurchaseReturnRow=Omit<PostedReturn,'return_type'|'cash_refund_paise'|'balance_credit_paise'>;

const friendly=(error:unknown)=>errorMessage(classifyError(error),error);
function fail(error:unknown):never{throw new Error(friendly(error));}

export async function listReturnSources(type:ReturnType,shopId:string):Promise<ReturnSource[]>{
  const client=getSupabaseClient();
  if(type==='SALE'){
    const {data,error}=await client.from('sale_invoices').select('id,doc_no,business_date,total_paise,customer:customers!sale_invoices_customer_id_fkey(name)').eq('shop_id',shopId).eq('status','FINALIZED').order('created_at',{ascending:false}).limit(100);
    if(error)fail(error);
    return ((data??[]) as unknown as SaleSourceRow[]).map(row=>({id:row.id,doc_no:row.doc_no,business_date:row.business_date,total_paise:row.total_paise,customer_name:row.customer?.name??null}));
  }
  const {data,error}=await client.from('purchase_bills').select('id,bill_no,business_date,total_paise,party:parties!purchase_bills_party_id_fkey(name)').eq('shop_id',shopId).eq('status','POSTED').order('created_at',{ascending:false}).limit(100);
  if(error)fail(error);
  return ((data??[]) as unknown as PurchaseSourceRow[]).map(row=>({id:row.id,doc_no:row.bill_no||row.id,business_date:row.business_date,total_paise:row.total_paise,party_name:row.party?.name??null}));
}

export async function listReturnableLines(type:ReturnType,sourceId:string):Promise<ReturnableLine[]>{
  const client=getSupabaseClient();
  const sourceTable=type==='SALE'?'sale_invoice_items':'purchase_bill_items';
  const sourceColumn=type==='SALE'?'sale_invoice_id':'purchase_bill_id';
  const returnTable=type==='SALE'?'sale_returns':'purchase_returns';
  const returnLineTable=type==='SALE'?'sale_return_items':'purchase_return_items';
  const returnIdColumn=type==='SALE'?'sale_return_id':'purchase_return_id';
  const sourceLineColumn=type==='SALE'?'sale_invoice_item_id':'purchase_bill_item_id';
  const returnSourceColumn=type==='SALE'?'sale_invoice_id':'purchase_bill_id';
  const {data:lines,error:lineError}=await client.from(sourceTable).select('id,item_id,item_name_snapshot,unit_name_snapshot,qty,base_qty').eq(sourceColumn,sourceId).order('line_no');
  if(lineError)fail(lineError);
  const {data:returns,error:returnError}=await client.from(returnTable).select('id').eq(returnSourceColumn,sourceId).eq('status','POSTED');
  if(returnError)fail(returnError);
  const returnIds=((returns??[]) as ReturnIdRow[]).map(row=>row.id);
  let returned:ReturnedLineRow[]=[];
  if(returnIds.length){
    const result=await client.from(returnLineTable).select(`${sourceLineColumn},qty`).in(returnIdColumn,returnIds);
    if(result.error)fail(result.error); returned=(result.data??[]) as ReturnedLineRow[];
  }
  const totals=new Map<string,number>();
  for(const row of returned){const key=String(row[sourceLineColumn]);totals.set(key,(totals.get(key)??0)+Number(row.qty));}
  return ((lines??[]) as SourceLineRow[]).map(row=>{
    const returnedQty=totals.get(row.id)??0;
    return {id:row.id,item_id:row.item_id,item_name_snapshot:row.item_name_snapshot,unit_name_snapshot:row.unit_name_snapshot,
      qty:Number(row.qty),base_qty:Number(row.base_qty),returned_qty:returnedQty,remaining_qty:Math.max(0,Number(row.qty)-returnedQty)};
  });
}

export async function postReturn(input:{type:ReturnType;sourceId:string;businessDate:string;clientId:string;lines:ReturnLineInput[];notes?:string}):Promise<string>{
  const {data,error}=await getSupabaseClient().rpc('post_return',{
    p_return_type:input.type,p_source_id:input.sourceId,p_business_date:input.businessDate,p_client_id:input.clientId,
    p_lines:input.lines.map(line=>({
      [input.type==='SALE'?'sale_invoice_item_id':'purchase_bill_item_id']:line.sourceLineId,
      qty:line.qty,disposition:line.disposition,
    })),p_notes:input.notes??null,
  });
  if(error)fail(error); return data as string;
}

export async function listRecentReturns(shopId:string):Promise<PostedReturn[]>{
  const client=getSupabaseClient();
  const [sales,purchases]=await Promise.all([
    client.from('sale_returns').select('id,doc_no,business_date,status,total_paise,cash_refund_paise,balance_credit_paise,created_at').eq('shop_id',shopId).order('created_at',{ascending:false}).limit(50),
    client.from('purchase_returns').select('id,doc_no,business_date,status,total_paise,created_at').eq('shop_id',shopId).order('created_at',{ascending:false}).limit(50),
  ]);
  if(sales.error)fail(sales.error); if(purchases.error)fail(purchases.error);
  return [
    ...((sales.data??[]) as SaleReturnRow[]).map(row=>({...row,return_type:'SALE' as const})),
    ...((purchases.data??[]) as PurchaseReturnRow[]).map(row=>({...row,return_type:'PURCHASE' as const})),
  ].sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at)).slice(0,100) as PostedReturn[];
}

export async function voidReturn(type:ReturnType,returnId:string,clientId:string):Promise<string>{
  const {data,error}=await getSupabaseClient().rpc('void_return',{p_return_type:type,p_return_id:returnId,p_client_id:clientId});
  if(error)fail(error); return data as string;
}

type CachedReturnSource={key:string;return_type:ReturnType;id:string;shop_id:string;doc_no:string;business_date:string;total_paise:number;party_name:string|null;customer_name:string|null;posted_return_client_ids:string[];lines:Omit<ReturnableLine,'remaining_qty'>[]};
type OfflineReturnPayload={type:ReturnType;sourceId:string;shopId:string;businessDate:string;clientId:string;lines:ReturnLineInput[];notes?:string};
type ReturnStockRow={id:string;key:string;updated_at:number;deleted_at:number|null;tenant_id:string;shop_id:string;item_id:string;on_hand:number;reserved:number;available:number;qty_base:number};
type SyncedReturnResult={returnId:string;docNo:string;status:'POSTED'|'VOID';totalPaise:number;cashRefundPaise:number;balanceCreditPaise:number;stock:ReturnStockRow[]};
export async function pullReturnSources(input:{deviceId:string;shopId:string}):Promise<CachedReturnSource[]>{
  const {data,error}=await getSupabaseClient().rpc('phase65_sync_return_sources',{p_device_id:input.deviceId,p_shop_id:input.shopId,p_schema_version:1});
  if(error)throw new Error(error.message);
  const result=data as {sources:CachedReturnSource[]};
  if(!result||!Array.isArray(result.sources))throw new Error('Invalid return source sync response.');
  if(result.sources.some(source=>source.shop_id!==input.shopId||!['SALE','PURCHASE'].includes(source.return_type)||typeof source.id!=='string'||!Array.isArray(source.posted_return_client_ids)||!Array.isArray(source.lines)||source.lines.some(line=>!line.id||!line.item_id||![line.qty,line.base_qty,line.returned_qty].every(Number.isFinite)||line.qty<=0||line.base_qty<=0||line.returned_qty<0)))throw new Error('Invalid return source rows; keeping previous cache.');
  // Whitelist the offline reference fields. An accidental future RPC expansion
  // must not replicate payment/allocation ledgers or refund decisions.
  return result.sources.map(source=>({key:`${source.return_type}:${source.id}`,return_type:source.return_type,id:source.id,shop_id:source.shop_id,doc_no:source.doc_no,business_date:source.business_date,total_paise:source.total_paise,party_name:source.party_name,customer_name:source.customer_name,posted_return_client_ids:source.posted_return_client_ids,
    lines:source.lines.map(line=>({id:line.id,item_id:line.item_id,item_name_snapshot:line.item_name_snapshot,unit_name_snapshot:line.unit_name_snapshot,qty:line.qty,base_qty:line.base_qty,returned_qty:line.returned_qty})),
  }));
}
export async function pushSyncedReturn(input:OfflineReturnPayload&{deviceId:string}):Promise<SyncedReturnResult>{
  const {data,error}=await getSupabaseClient().rpc('phase65_sync_post_return',{
    p_device_id:input.deviceId,p_schema_version:1,p_return_type:input.type,p_source_id:input.sourceId,
    p_business_date:input.businessDate,p_client_id:input.clientId,p_notes:input.notes??null,
    p_lines:input.lines.map(line=>({[input.type==='SALE'?'sale_invoice_item_id':'purchase_bill_item_id']:line.sourceLineId,qty:line.qty,disposition:line.disposition})),
  });
  if(error)throw new Error(error.message);
  const result=data as SyncedReturnResult;
  if(!result||typeof result.returnId!=='string'||!result.returnId||typeof result.docNo!=='string'||!result.docNo||!['POSTED','VOID'].includes(result.status)||!Array.isArray(result.stock)||
    ![result.totalPaise,result.cashRefundPaise,result.balanceCreditPaise].every(n=>Number.isSafeInteger(n)&&n>=0)||
    (input.type==='SALE'&&result.cashRefundPaise+result.balanceCreditPaise!==result.totalPaise)||
    result.stock.some(row=>row.shop_id!==input.shopId||!row.item_id||![row.updated_at,row.available,row.on_hand,row.reserved,row.qty_base].every(Number.isFinite)))throw new Error('Malformed return confirmation; retrying the same intent safely.');
  return result;
}
