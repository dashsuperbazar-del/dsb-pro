import type {DsbSyncDb} from './db';
import type {HeldCartLine,HeldCartRecord} from './types';

// A held cart is nothing that has been posted anywhere: no stock reservation,
// no financial document, no server round-trip. It only exists so a cashier
// can park an in-progress cart to serve another customer, and get it back
// exactly as left. Client-only by design; there is nothing here for a
// server to validate.
export async function holdCart(db:DsbSyncDb,input:{shopId:string;label:string;customerId:string;globalDiscount:string;extra:string;lines:HeldCartLine[]}):Promise<HeldCartRecord>{
  if(!input.lines.length)throw new Error('Cannot hold an empty cart.');
  const record:HeldCartRecord={id:crypto.randomUUID(),shopId:input.shopId,createdAt:Date.now(),label:input.label.trim()||'Held cart',customerId:input.customerId,globalDiscount:input.globalDiscount,extra:input.extra,lines:input.lines};
  await db.heldCarts.put(record);
  return record;
}
export async function listHeldCarts(db:DsbSyncDb,shopId:string):Promise<HeldCartRecord[]>{
  return (await db.heldCarts.where('shopId').equals(shopId).toArray()).sort((a,b)=>a.createdAt-b.createdAt);
}
export async function discardHeldCart(db:DsbSyncDb,id:string):Promise<void>{
  await db.heldCarts.delete(id);
}
export async function takeHeldCart(db:DsbSyncDb,id:string):Promise<HeldCartRecord|undefined>{
  return db.transaction('rw',db.heldCarts,async()=>{
    const record=await db.heldCarts.get(id);
    if(record)await db.heldCarts.delete(id);
    return record;
  });
}
