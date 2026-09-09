import Dexie,{type Table} from 'dexie';
import type {
  LocalMeta,LocalReservation,LocalSyncConflict,OfflineSaleRecord,OutboxEntry,
  SyncedBarcode,SyncedCustomer,SyncedItem,SyncedPrice,SyncedStock,SyncIdentity,
} from './types';

function safePart(value:string){return value.replace(/[^A-Za-z0-9_-]/g,'_');}
export function syncDatabaseName(identity:SyncIdentity):string{
  return `dsb-pro-sync-${safePart(identity.tenantId)}-${safePart(identity.userId)}-${safePart(identity.deviceId)}`;
}
export function stockKey(shopId:string,itemId:string):string{return `${shopId}:${itemId}`;}

export class DsbSyncDb extends Dexie{
  items!:Table<SyncedItem,string>;
  barcodes!:Table<SyncedBarcode,string>;
  prices!:Table<SyncedPrice,string>;
  customers!:Table<SyncedCustomer,string>;
  stock!:Table<SyncedStock,string>;
  outbox!:Table<OutboxEntry,number>;
  meta!:Table<LocalMeta,string>;
  conflicts!:Table<LocalSyncConflict,number>;
  reservations!:Table<LocalReservation,string>;
  offlineSales!:Table<OfflineSaleRecord,string>;

  constructor(name:string){
    super(name);
    this.version(1).stores({
      items:'&id,tenant_id,name,updated_at,deleted_at,is_active',
      barcodes:'&id,tenant_id,item_id,&barcode,updated_at,deleted_at',
      prices:'&id,tenant_id,item_id,[item_id+kind+unit_level],shop_id,updated_at,deleted_at',
      customers:'&id,tenant_id,name,updated_at,deleted_at',
      stock:'&key,tenant_id,shop_id,item_id,updated_at',
      outbox:'&sequence,&clientId,state,nextAttemptAt,kind,target,createdAt',
      meta:'&key',
      conflicts:'++id,status,createdAt,kind,clientId,target',
      reservations:'&key,shop_id,item_id',
      offlineSales:'&clientId,status,businessDate,createdAt,provisionalDocNo',
    });
  }
}

const openDbs=new Map<string,DsbSyncDb>();
export async function openSyncDb(identity:SyncIdentity):Promise<DsbSyncDb>{
  const name=syncDatabaseName(identity);
  let db=openDbs.get(name);
  if(!db){db=new DsbSyncDb(name);openDbs.set(name,db);}
  if(!db.isOpen())await db.open();
  return db;
}
export async function closeAllSyncDbs():Promise<void>{
  for(const db of openDbs.values())db.close();
  openDbs.clear();
}

export async function getMeta<T>(db:DsbSyncDb,key:string):Promise<T|null>{
  const row=await db.meta.get(key);
  return row?row.value as T:null;
}
export async function setMeta<T>(db:DsbSyncDb,key:string,value:T):Promise<void>{
  await db.meta.put({key,value});
}

export async function recoverInterruptedOutbox(db:DsbSyncDb):Promise<number>{
  const rows=await db.outbox.where('state').equals('sending').toArray();
  if(!rows.length)return 0;
  await db.outbox.bulkPut(rows.map(row=>({...row,state:'retry' as const,nextAttemptAt:0,lastError:'Recovered after app restart before sync outcome was known.'})));
  return rows.length;
}
