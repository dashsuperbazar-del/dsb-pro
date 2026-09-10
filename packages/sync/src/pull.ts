import {advanceCursor} from './cursor';
import {getMeta,setMeta,stockKey,type DsbSyncDb} from './db';
import type {
  ServerSyncRow,SyncedBarcode,SyncedCustomer,SyncedItem,SyncedPrice,
  SyncCursor,SyncHealth,SyncPullPayload,SyncTableName,
} from './types';

const ZERO:SyncCursor={updatedAt:0,id:''};
const tables:SyncTableName[]=['items','barcodes','prices','customers','stock'];

export async function getSyncCursors(db:DsbSyncDb):Promise<Record<SyncTableName,SyncCursor>>{
  const result={} as Record<SyncTableName,SyncCursor>;
  for(const table of tables)result[table]=(await getMeta<SyncCursor>(db,`cursor:${table}`))??ZERO;
  return result;
}
function acceptRemote<T extends ServerSyncRow>(local:T|undefined,remote:T):boolean{
  if(!local)return true;
  if(local.deleted_at!==null&&remote.deleted_at===null)return false;
  if(remote.updated_at!==local.updated_at)return remote.updated_at>local.updated_at;
  if(remote.deleted_at!==null&&local.deleted_at===null)return true;
  return true;
}
type BulkTable<T>={
  bulkGet:(ids:string[])=>Promise<(T|undefined)[]>;
  bulkPut:(rows:T[])=>Promise<unknown>;
};
async function applyRows<T extends ServerSyncRow>(table:BulkTable<T>,rows:T[]){
  if(!rows.length)return;
  const localRows=await table.bulkGet(rows.map(row=>row.id));
  const accepted=rows.filter((row,index)=>acceptRemote(localRows[index],row));
  if(accepted.length)await table.bulkPut(accepted);
}
export async function applySyncPull(db:DsbSyncDb,payload:SyncPullPayload):Promise<void>{
  await db.transaction('rw',[db.items,db.barcodes,db.prices,db.customers,db.stock,db.meta],async()=>{
    await applyRows(db.items,payload.items);
    await applyRows(db.barcodes,payload.barcodes);
    await applyRows(db.prices,payload.prices);
    await applyRows(db.customers,payload.customers);
    if(payload.stock.length){
      const stockRows=payload.stock.map(raw=>({...raw,key:stockKey(raw.shop_id,raw.item_id)}));
      const locals=await db.stock.bulkGet(stockRows.map(row=>row.key));
      const accepted=stockRows.filter((row,index)=>!locals[index]||row.updated_at>=locals[index]!.updated_at);
      if(accepted.length)await db.stock.bulkPut(accepted);
    }
    const rowSets:Record<SyncTableName,ServerSyncRow[]>={
      items:payload.items,barcodes:payload.barcodes,prices:payload.prices,customers:payload.customers,stock:payload.stock,
    };
    for(const table of tables){
      const current=(await getMeta<SyncCursor>(db,`cursor:${table}`))??ZERO;
      await setMeta(db,`cursor:${table}`,advanceCursor(current,rowSets[table]));
    }
    await setMeta(db,'businessDate',payload.businessDate);
    await setMeta(db,'policy',payload.policy);
    await setMeta(db,'lastSyncAt',Date.now());
    await setMeta(db,'lastServerNowMs',payload.serverNowMs);
    await setMeta(db,'clockDriftMs',Math.abs(Date.now()-payload.serverNowMs));
    await setMeta(db,'schemaVersion',payload.schemaVersion);
  });
}

export async function getCachedItems(db:DsbSyncDb):Promise<SyncedItem[]>{
  return (await db.items.toArray()).filter(r=>r.deleted_at===null&&r.is_active).sort((a,b)=>a.name.localeCompare(b.name));
}
export async function getCachedCustomers(db:DsbSyncDb):Promise<SyncedCustomer[]>{
  return (await db.customers.toArray()).filter(r=>r.deleted_at===null).sort((a,b)=>a.name.localeCompare(b.name));
}
export async function findCachedBarcode(db:DsbSyncDb,barcode:string):Promise<SyncedBarcode|null>{
  const row=await db.barcodes.where('barcode').equals(barcode.trim()).first();
  return row&&row.deleted_at===null?row:null;
}
export async function getCachedPrices(db:DsbSyncDb,itemId:string):Promise<SyncedPrice[]>{
  return (await db.prices.where('item_id').equals(itemId).toArray()).filter(r=>r.deleted_at===null&&r.effective_to===null);
}
export async function getCachedBusinessDate(db:DsbSyncDb):Promise<string|null>{return getMeta<string>(db,'businessDate');}
export async function getCachedPolicy(db:DsbSyncDb){return getMeta<{allowCashierOfflineFinalization:boolean}>(db,'policy');}

export async function getSyncHealth(db:DsbSyncDb):Promise<SyncHealth>{
  const [outboxCount,conflictCount,queuedSales,lastSyncAt,lastServerNowMs,clockDriftMs,businessDate]=await Promise.all([
    db.outbox.count(),db.conflicts.where('status').equals('OPEN').count(),db.offlineSales.where('status').equals('QUEUED').count(),
    getMeta<number>(db,'lastSyncAt'),getMeta<number>(db,'lastServerNowMs'),getMeta<number>(db,'clockDriftMs'),getMeta<string>(db,'businessDate'),
  ]);
  return {outboxCount,conflictCount,queuedSales,lastSyncAt,lastServerNowMs,clockDriftMs,businessDate};
}
