import type {DsbSyncDb} from './db';
import type {HeldCartLine,HeldCartRecord} from './types';

export const HELD_CART_CLAIM_LEASE_MS=60_000;

export type HeldCartResolvableItem={id:string;name:string;unit1:string;unit2:string|null;unit3:string|null};
export type HeldCartResolvablePrice={shop_id:string|null;kind:string;unit_level:number;price_paise:number};
export type ResolvedHeldCartLine<T extends HeldCartResolvableItem>={
  item:T;unitLevel:1|2|3;qty:number;priceKind:'retail'|'wholesale';unitPricePaise:number;discountPaise:number;
};
export type ResolvedHeldCart<T extends HeldCartResolvableItem>={
  customerId:string;globalDiscount:string;extra:string;lines:ResolvedHeldCartLine<T>[];
};

// A held cart is not posted, reserved or synced. It is durable local work that
// must survive refreshes, failed validation and a crash during resume.
export async function holdCart(db:DsbSyncDb,input:{shopId:string;label:string;customerId:string;globalDiscount:string;extra:string;lines:HeldCartLine[]}):Promise<HeldCartRecord>{
  if(!input.lines.length)throw new Error('Cannot hold an empty cart.');
  const record:HeldCartRecord={id:crypto.randomUUID(),shopId:input.shopId,createdAt:Date.now(),label:input.label.trim()||'Held cart',customerId:input.customerId,globalDiscount:input.globalDiscount,extra:input.extra,lines:input.lines,resumeToken:null,resumingAt:null};
  await db.heldCarts.put(record);
  return record;
}
export async function listHeldCarts(db:DsbSyncDb,shopId:string):Promise<HeldCartRecord[]>{
  return (await db.heldCarts.where('shopId').equals(shopId).toArray()).sort((a,b)=>a.createdAt-b.createdAt);
}
export async function getHeldCart(db:DsbSyncDb,id:string):Promise<HeldCartRecord|undefined>{return db.heldCarts.get(id);}
export async function discardHeldCart(db:DsbSyncDb,id:string):Promise<void>{await db.heldCarts.delete(id);}

// Claiming never removes cart contents. A second tab cannot claim an active
// lease; after 60 seconds a crashed claimant can be replaced. Completion is
// token-checked, so an expired claimant cannot delete a newer claimant's cart.
export async function claimHeldCart(db:DsbSyncDb,id:string,token:string,now=Date.now(),leaseMs=HELD_CART_CLAIM_LEASE_MS):Promise<HeldCartRecord|undefined>{
  if(!token)throw new Error('Held-cart resume token is required.');
  return db.transaction('rw',db.heldCarts,async()=>{
    const record=await db.heldCarts.get(id);
    if(!record)return undefined;
    const claimedAt=record.resumingAt??0;
    const active=Boolean(record.resumeToken)&&claimedAt>now-leaseMs;
    if(active&&record.resumeToken!==token)throw new Error('This held cart is already being resumed. Retry shortly if the other window was closed.');
    const claimed={...record,resumeToken:token,resumingAt:now};
    await db.heldCarts.put(claimed);
    return claimed;
  });
}
export async function releaseHeldCartClaim(db:DsbSyncDb,id:string,token:string):Promise<boolean>{
  return db.transaction('rw',db.heldCarts,async()=>{
    const record=await db.heldCarts.get(id);
    if(!record||record.resumeToken!==token)return false;
    await db.heldCarts.put({...record,resumeToken:null,resumingAt:null});
    return true;
  });
}
export async function completeHeldCartResume(db:DsbSyncDb,id:string,token:string):Promise<boolean>{
  return db.transaction('rw',db.heldCarts,async()=>{
    const record=await db.heldCarts.get(id);
    if(!record)return false;
    if(record.resumeToken!==token)throw new Error('Held-cart resume claim changed before cleanup. The held copy was kept.');
    await db.heldCarts.delete(id);
    return true;
  });
}

function validAdjustment(value:string,label:string){
  if(value.trim()===''||!Number.isFinite(Number(value))||Number(value)<0)throw new Error(`${label} is invalid in this held cart.`);
}
function unitAvailable(item:HeldCartResolvableItem,level:number){
  return level===1?Boolean(item.unit1):level===2?Boolean(item.unit2):level===3?Boolean(item.unit3):false;
}

// Resolve everything before the caller mutates active-cart state. This makes a
// late invalid line indistinguishable from an early one: both leave the active
// cart empty and the durable held record intact.
export async function resolveHeldCart<T extends HeldCartResolvableItem>(record:HeldCartRecord,input:{
  shopId:string;items:readonly T[];customerIds:ReadonlySet<string>;
  loadPrices:(itemId:string)=>Promise<readonly HeldCartResolvablePrice[]>;
}):Promise<ResolvedHeldCart<T>>{
  if(record.shopId!==input.shopId)throw new Error('This held cart belongs to a different shop.');
  if(!record.lines.length)throw new Error('This held cart has no lines.');
  if(record.customerId&&!input.customerIds.has(record.customerId))throw new Error('The customer in this held cart is no longer available.');
  validAdjustment(record.globalDiscount,'Invoice discount'); validAdjustment(record.extra,'Extra charges');
  const lines:ResolvedHeldCartLine<T>[]=[];
  for(const line of record.lines){
    const item=input.items.find(candidate=>candidate.id===line.itemId);
    if(!item)throw new Error('An item in this held cart is no longer available.');
    if(!Number.isFinite(line.qty)||line.qty<=0)throw new Error(`Quantity is invalid for ${item.name}.`);
    if(!unitAvailable(item,line.unitLevel))throw new Error(`The saved unit is no longer available for ${item.name}.`);
    if(line.priceKind!=='retail'&&line.priceKind!=='wholesale')throw new Error(`Price kind is invalid for ${item.name}.`);
    if(!Number.isSafeInteger(line.discountPaise)||line.discountPaise<0)throw new Error(`Line discount is invalid for ${item.name}.`);
    const prices=await input.loadPrices(item.id);
    const matching=prices.filter(price=>price.kind===line.priceKind&&price.unit_level===line.unitLevel);
    const chosen=matching.find(price=>price.shop_id===input.shopId)??matching.find(price=>price.shop_id===null);
    if(!chosen||!Number.isSafeInteger(chosen.price_paise)||chosen.price_paise<0)throw new Error(`No active ${line.priceKind} price for ${item.name}.`);
    lines.push({item,unitLevel:line.unitLevel,qty:line.qty,priceKind:line.priceKind,unitPricePaise:chosen.price_paise,discountPaise:line.discountPaise});
  }
  return {customerId:record.customerId,globalDiscount:record.globalDiscount,extra:record.extra,lines};
}
