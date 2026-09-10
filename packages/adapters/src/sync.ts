import { getSupabaseClient } from './client';
import { classifyError,errorMessage } from './errors';
import type { SaleLineInput,SalePaymentInput } from './sales';

export const SYNC_SCHEMA_VERSION=1;
export const SYNC_PULL_LIMITS={items:5000,barcodes:5000,prices:10000,customers:5000,stock:5000} as const;

export type SyncCursorWire={updatedAt:number;id:string};
export type SyncPullWire={
  schemaVersion:number;serverNowMs:number;cutoffMs:number;businessDate:string;
  policy:{allowCashierOfflineFinalization:boolean};
  items:Array<Record<string,unknown>>;barcodes:Array<Record<string,unknown>>;prices:Array<Record<string,unknown>>;
  customers:Array<Record<string,unknown>>;stock:Array<Record<string,unknown>>;
};
export type SyncSaleResultWire={saleId:string;docNo:string;stock:Array<Record<string,unknown>>};
export type ServerSyncConflict={
  id:string;op_client_id:string|null;kind:string;target:string;reason:string;status:'OPEN'|'RESOLVED';
  created_at:string;resolved_at:string|null;
};

const friendly=(error:unknown)=>errorMessage(classifyError(error),error);
function object(value:unknown):Record<string,unknown>|null{
  return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
}
function requirePull(value:unknown):SyncPullWire{
  const row=object(value);
  if(!row||row.schemaVersion!==SYNC_SCHEMA_VERSION||typeof row.serverNowMs!=='number'||typeof row.cutoffMs!=='number'||
    typeof row.businessDate!=='string'||!object(row.policy)||!Array.isArray(row.items)||!Array.isArray(row.barcodes)||
    !Array.isArray(row.prices)||!Array.isArray(row.customers)||!Array.isArray(row.stock)){
    throw new Error('Server returned an invalid sync payload.');
  }
  return value as SyncPullWire;
}
function requireSale(value:unknown):SyncSaleResultWire{
  const row=object(value);
  if(!row||typeof row.saleId!=='string'||typeof row.docNo!=='string'||!Array.isArray(row.stock)){
    throw new Error('Server returned an invalid synced-sale result.');
  }
  return value as SyncSaleResultWire;
}

export function syncPullMayHaveMore(pull:SyncPullWire):boolean{
  return pull.items.length>=SYNC_PULL_LIMITS.items||
    pull.barcodes.length>=SYNC_PULL_LIMITS.barcodes||
    pull.prices.length>=SYNC_PULL_LIMITS.prices||
    pull.customers.length>=SYNC_PULL_LIMITS.customers||
    pull.stock.length>=SYNC_PULL_LIMITS.stock;
}

export async function pullSync(input:{deviceId:string;shopId:string;cursors:Record<string,SyncCursorWire>}):Promise<SyncPullWire>{
  const {data,error}=await getSupabaseClient().rpc('phase5_sync_pull',{
    p_device_id:input.deviceId,p_shop_id:input.shopId,p_schema_version:SYNC_SCHEMA_VERSION,p_cursors:input.cursors,
  });
  if(error)throw new Error(friendly(error));
  return requirePull(data);
}
export async function ackSync(input:{deviceId:string;cursors:Record<string,SyncCursorWire>}):Promise<void>{
  const {error}=await getSupabaseClient().rpc('phase5_sync_ack',{
    p_device_id:input.deviceId,p_schema_version:SYNC_SCHEMA_VERSION,p_cursors:input.cursors,
  });
  if(error)throw new Error(friendly(error));
}
export async function pushSyncedSale(input:{
  deviceId:string;shopId:string;customerId?:string;businessDate:string;discountPaise:number;extraChargesPaise:number;
  clientId:string;lines:Array<SaleLineInput&{expectedUnitPricePaise?:number}>;payments:SalePaymentInput[];notes?:string;
}):Promise<SyncSaleResultWire>{
  const {data,error}=await getSupabaseClient().rpc('phase5_sync_post_sale',{
    p_device_id:input.deviceId,p_schema_version:SYNC_SCHEMA_VERSION,p_shop_id:input.shopId,p_customer_id:input.customerId??null,
    p_business_date:input.businessDate,p_discount_paise:input.discountPaise,p_extra_charges_paise:input.extraChargesPaise,
    p_client_id:input.clientId,
    p_lines:input.lines.map(l=>({item_id:l.itemId,unit_level:l.unitLevel,qty:l.qty,price_kind:l.priceKind,discount_paise:l.discountPaise??0,expected_unit_price_paise:l.expectedUnitPricePaise??null})),
    p_payments:input.payments.map(p=>({amount_paise:p.amountPaise,mode:p.mode,reference:p.reference??null})),p_notes:input.notes??null,
  });
  if(error)throw new Error(friendly(error));
  return requireSale(data);
}
export async function setOfflineCashierFinalization(allow:boolean):Promise<boolean>{
  const {data,error}=await getSupabaseClient().rpc('phase5_set_offline_finalization_policy',{p_allow_cashier:allow});
  if(error)throw new Error(friendly(error));
  return Boolean(data);
}
export async function recordServerSyncConflict(input:{
  deviceId:string;opClientId?:string;kind:string;target:string;reason:string;payload:unknown;serverRef:unknown;clientId:string;
}):Promise<string>{
  const {data,error}=await getSupabaseClient().rpc('phase5_record_sync_conflict',{
    p_device_id:input.deviceId,p_schema_version:SYNC_SCHEMA_VERSION,p_op_client_id:input.opClientId??null,
    p_kind:input.kind,p_target:input.target,p_reason:input.reason,p_payload:input.payload,p_server_ref:input.serverRef,p_client_id:input.clientId,
  });
  if(error)throw new Error(friendly(error));
  if(typeof data!=='string')throw new Error('Conflict record id was not returned.');
  return data;
}
export async function listServerSyncConflicts():Promise<ServerSyncConflict[]>{
  const {data,error}=await getSupabaseClient().from('sync_conflicts')
    .select('id,op_client_id,kind,target,reason,status,created_at,resolved_at').order('created_at',{ascending:false});
  if(error)throw new Error(friendly(error));
  return (data??[]) as ServerSyncConflict[];
}
export async function resolveServerSyncConflict(input:{deviceId:string;id:string}):Promise<void>{
  const {error}=await getSupabaseClient().rpc('phase5_resolve_sync_conflict',{
    p_device_id:input.deviceId,p_schema_version:SYNC_SCHEMA_VERSION,p_id:input.id,
  });
  if(error)throw new Error(friendly(error));
}

export function subscribeSyncWakeup(onWakeup:()=>void):()=>void{
  const client=getSupabaseClient();
  let channel=client.channel(`dsb-sync-${crypto.randomUUID()}`);
  for(const table of ['items','item_barcodes','item_prices','customers','stock_current']){
    channel=channel.on('postgres_changes',{event:'*',schema:'public',table},()=>onWakeup());
  }
  channel.subscribe();
  return ()=>{void client.removeChannel(channel);};
}
