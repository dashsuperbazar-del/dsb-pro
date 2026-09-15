import {stockKey,type DsbSyncDb} from './db';
import type {LocalReservation} from './types';

// Positive reservations consume stock; negative reservations provisionally restore it.
// Never overwrite the authoritative server snapshot with an optimistic movement.
export async function rebuildReservations(db:DsbSyncDb):Promise<void>{
  const byKey=new Map<string,LocalReservation>();
  const add=(shopId:string,itemId:string,qty:number)=>{
    const key=stockKey(shopId,itemId),prev=byKey.get(key);
    byKey.set(key,{key,shop_id:shopId,item_id:itemId,qty:(prev?.qty??0)+qty});
  };
  for(const sale of await db.offlineSales.where('status').equals('QUEUED').toArray())
    for(const line of sale.lines)add(sale.shopId,line.itemId,line.baseQty);
  for(const ret of await db.offlineReturns.where('status').equals('QUEUED').toArray())
    for(const line of ret.lines)add(ret.shopId,line.itemId,-line.stockDelta);
  await db.reservations.clear();
  if(byKey.size)await db.reservations.bulkPut([...byKey.values()]);
}
