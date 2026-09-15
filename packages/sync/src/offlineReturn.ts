import {getMeta,setMeta,stockKey,type DsbSyncDb} from './db';
import {provisionalDocNo} from './outbox';
import {rebuildReservations} from './projections';
import type {CachedReturnSource,OfflineReturnPayload,OfflineReturnRecord,OfflineRole,SyncedReturnResult} from './types';

export const returnSourceKey=(type:string,id:string)=>`${type}:${id}`;
export function returnStockDelta(type:OfflineReturnPayload['type'],disposition:OfflineReturnPayload['lines'][number]['disposition'],baseQty:number):number{
  return type==='SALE'?(disposition==='RETURN_TO_SELLABLE'?baseQty:0):(disposition==='RETURN_TO_SELLABLE'?0:-baseQty);
}
export async function cacheReturnSources(db:DsbSyncDb,shopId:string,sources:CachedReturnSource[]):Promise<void>{
  await db.transaction('rw',db.returnSources,async()=>{
    await db.returnSources.where('shop_id').equals(shopId).delete();
    if(sources.length)await db.returnSources.bulkPut(sources.map(source=>({...source,key:returnSourceKey(source.return_type,source.id)})));
  });
}
export async function returnableCachedLines(db:DsbSyncDb,type:OfflineReturnPayload['type'],sourceId:string){
  const source=await db.returnSources.get(returnSourceKey(type,sourceId));
  if(!source)throw new Error('Source document is not cached. Reconnect and sync it before returning.');
  const pending=(await db.offlineReturns.where('status').equals('QUEUED').toArray()).filter(row=>row.payload.type===type&&row.payload.sourceId===sourceId&&!source.posted_return_client_ids.includes(row.clientId));
  return source.lines.map(line=>{
    const qty=pending.reduce((sum,row)=>sum+row.lines.filter(x=>x.sourceLineId===line.id).reduce((n,x)=>n+x.qty,0),line.returned_qty);
    return {...line,returned_qty:qty,remaining_qty:Math.max(0,line.qty-qty)};
  });
}
export async function queueOfflineReturn(db:DsbSyncDb,input:OfflineReturnPayload,context:{role:OfflineRole;deviceId:string}):Promise<OfflineReturnRecord>{
  if(context.role==='accountant'||(input.type==='PURCHASE'&&context.role==='cashier'))throw new Error('Your role cannot post this return.');
  if(!['SALE','PURCHASE'].includes(input.type)||!input.clientId.trim()||!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)||!input.lines.length)throw new Error('Invalid return intent.');
  return db.transaction('rw',[db.returnSources,db.offlineReturns,db.offlineSales,db.outbox,db.meta,db.reservations,db.stock],async()=>{
    const fingerprint=JSON.stringify(input),existing=await db.offlineReturns.get(input.clientId);
    if(existing){if(existing.fingerprint!==fingerprint)throw new Error('Return client_id payload mismatch.');return existing;}
    if(await db.outbox.where('clientId').equals(input.clientId).count())throw new Error('clientId is already used by another operation.');
    const source=await db.returnSources.get(returnSourceKey(input.type,input.sourceId));
    if(!source||source.shop_id!==input.shopId)throw new Error('Source document is not cached for this shop. Reconnect and sync it first.');
    const available=await returnableCachedLines(db,input.type,input.sourceId),seen=new Set<string>();
    const lines=input.lines.map(line=>{
      const src=available.find(x=>x.id===line.sourceLineId);
      if(seen.has(line.sourceLineId)||!src||!Number.isFinite(line.qty)||line.qty<=0||Math.abs(line.qty*1e6-Math.round(line.qty*1e6))>1e-5||line.qty>src.remaining_qty+1e-9||!['RETURN_TO_SELLABLE','DAMAGED','EXPIRED','SUPPLIER_RETURN'].includes(line.disposition))throw new Error('Invalid return quantity or disposition.');
      seen.add(line.sourceLineId);
      const baseQty=Math.round(src.base_qty*line.qty/src.qty*1e6)/1e6;
      return {sourceLineId:line.sourceLineId,itemId:src.item_id,qty:line.qty,stockDelta:returnStockDelta(input.type,line.disposition,baseQty)};
    });
    const required=new Map<string,number>();
    for(const line of lines)if(line.stockDelta<0){const key=stockKey(input.shopId,line.itemId);required.set(key,(required.get(key)??0)-line.stockDelta);}
    for(const [key,qty] of required){const stock=await db.stock.get(key),local=await db.reservations.get(key);if((stock?.available??0)-(local?.qty??0)+1e-9<qty)throw new Error('Insufficient cached stock for this purchase return.');}
    const seq=((await getMeta<number>(db,'outboxSeq'))??0)+1,provisional=((await getMeta<number>(db,'provisionalSeq'))??0)+1;
    await setMeta(db,'outboxSeq',seq);await setMeta(db,'provisionalSeq',provisional);
    const record:OfflineReturnRecord={clientId:input.clientId,provisionalDocNo:provisionalDocNo(context.deviceId,provisional),payload:input,fingerprint,shopId:input.shopId,status:'QUEUED',createdAt:Date.now(),officialReturnId:null,officialDocNo:null,cashRefundPaise:null,balanceCreditPaise:null,totalPaise:null,rejectionReason:null,lines};
    await db.offlineReturns.put(record);
    await db.outbox.add({sequence:seq,clientId:input.clientId,kind:'financial-rpc',target:'post_return',payload:input,createdAt:record.createdAt,attempts:0,state:'pending',nextAttemptAt:0,lastError:null});
    await rebuildReservations(db);
    return record;
  });
}
export async function completeOfflineReturn(db:DsbSyncDb,clientId:string,result:SyncedReturnResult):Promise<void>{
  await db.transaction('rw',[db.offlineReturns,db.offlineSales,db.returnSources,db.outbox,db.stock,db.reservations],async()=>{
    const row=await db.offlineReturns.get(clientId);if(!row)throw new Error('Offline return record is missing.');
    if(row.status==='SYNCED')return;
    if(row.status!=='QUEUED')throw new Error('Cannot acknowledge a rejected return.');
    for(const raw of result.stock){const key=stockKey(raw.shop_id,raw.item_id),prev=await db.stock.get(key);if(!prev||raw.updated_at>=prev.updated_at)await db.stock.put({...raw,key});}
    const source=await db.returnSources.get(returnSourceKey(row.payload.type,row.payload.sourceId));
    if(source&&!source.posted_return_client_ids.includes(clientId))await db.returnSources.put({...source,posted_return_client_ids:[...source.posted_return_client_ids,clientId],lines:source.lines.map(line=>({...line,returned_qty:line.returned_qty+(row.lines.find(x=>x.sourceLineId===line.id)?.qty??0)}))});
    await db.offlineReturns.put({...row,status:'SYNCED',officialReturnId:result.returnId,officialDocNo:result.docNo,totalPaise:result.totalPaise,cashRefundPaise:result.cashRefundPaise,balanceCreditPaise:result.balanceCreditPaise});
    await db.outbox.where('clientId').equals(clientId).delete();await rebuildReservations(db);
  });
}
export async function rejectOfflineReturn(db:DsbSyncDb,clientId:string,reason:string):Promise<void>{
  await db.transaction('rw',[db.offlineReturns,db.offlineSales,db.outbox,db.conflicts,db.reservations],async()=>{
    const row=await db.offlineReturns.get(clientId);if(!row||row.status!=='QUEUED')return;
    await db.offlineReturns.put({...row,status:'REJECTED',rejectionReason:reason});
    await db.outbox.where('clientId').equals(clientId).delete();
    await db.conflicts.add({createdAt:Date.now(),status:'OPEN',kind:'financial-rejection',target:'post_return',clientId,reason,payload:row.payload,serverRef:null});
    await rebuildReservations(db);
  });
}
