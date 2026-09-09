import {provisionalDocNo} from './outbox';
import {getMeta,setMeta,stockKey,type DsbSyncDb} from './db';
import type {
  LocalReservation,LocalSyncConflict,OfflineRole,OfflineSaleLineSnapshot,OfflineSalePayload,
  OfflineSaleRecord,OutboxEntry,SyncedPrice,SyncedSaleResult,SyncPolicy,
} from './types';

function positive(value:number,name:string){
  if(!Number.isFinite(value)||value<=0)throw new Error(`${name} must be greater than zero`);
}
function nonNegativeMoney(value:number,name:string){
  if(!Number.isSafeInteger(value)||value<0)throw new Error(`${name} must be non-negative whole paise`);
}
function effectivePrice(rows:SyncedPrice[],shopId:string,kind:'retail'|'wholesale',level:1|2|3,now:number):SyncedPrice|null{
  const candidates=rows.filter(p=>p.deleted_at===null&&p.kind===kind&&p.unit_level===level&&
    Date.parse(p.effective_from)<=now&&(p.effective_to===null||Date.parse(p.effective_to)>now)&&
    (p.shop_id===shopId||p.shop_id===null));
  candidates.sort((a,b)=>{
    const shopA=a.shop_id===shopId?1:0,shopB=b.shop_id===shopId?1:0;
    if(shopA!==shopB)return shopB-shopA;
    return Date.parse(b.effective_from)-Date.parse(a.effective_from);
  });
  return candidates[0]??null;
}
function baseQty(item:{unit2:string|null;unit3:string|null;conv1:number|null;conv2:number|null},level:1|2|3,qty:number):number{
  if(level===1)return qty*(item.conv1??1)*(item.conv2??1);
  if(level===2){
    if(!item.unit2)throw new Error('Selected small unit is unavailable.');
    return qty*(item.conv2??1);
  }
  if(!item.unit3)throw new Error('Selected piece unit is unavailable.');
  return qty;
}
function unitName(item:{unit1:string;unit2:string|null;unit3:string|null},level:1|2|3){
  return level===1?item.unit1:level===2?(item.unit2??item.unit1):(item.unit3??item.unit2??item.unit1);
}
async function nextSequence(db:DsbSyncDb,key:string):Promise<number>{
  const current=(await getMeta<number>(db,key))??0;
  const next=current+1;
  await setMeta(db,key,next);
  return next;
}
async function rebuildReservations(db:DsbSyncDb):Promise<void>{
  const queued=await db.offlineSales.where('status').equals('QUEUED').toArray();
  const byKey=new Map<string,LocalReservation>();
  for(const sale of queued){
    for(const line of sale.lines){
      const key=stockKey(sale.shopId,line.itemId);
      const prev=byKey.get(key);
      byKey.set(key,{key,shop_id:sale.shopId,item_id:line.itemId,qty:(prev?.qty??0)+line.baseQty});
    }
  }
  await db.reservations.clear();
  if(byKey.size)await db.reservations.bulkPut([...byKey.values()]);
}

export async function queueOfflineSale(
  db:DsbSyncDb,
  input:OfflineSalePayload,
  context:{deviceId:string;role:OfflineRole;policy:SyncPolicy},
):Promise<OfflineSaleRecord>{
  if(context.role==='accountant')throw new Error('Your role cannot finalize sales.');
  if(context.role==='cashier'&&!context.policy.allowCashierOfflineFinalization){
    throw new Error('Offline finalization is disabled for cashiers. Keep this sale as a draft until online.');
  }
  if(!input.lines.length)throw new Error('Sale requires at least one line.');
  nonNegativeMoney(input.discountPaise,'discount');
  nonNegativeMoney(input.extraChargesPaise,'extra charges');
  for(const p of input.payments)nonNegativeMoney(p.amountPaise,'payment');

  return db.transaction('rw',[db.items,db.prices,db.customers,db.stock,db.outbox,db.meta,db.reservations,db.offlineSales],async()=>{
    if(await db.outbox.where('clientId').equals(input.clientId).count()){
      const existing=await db.offlineSales.get(input.clientId);
      if(existing)return existing;
      throw new Error('clientId already exists in outbox without its offline sale.');
    }
    const snapshots:OfflineSaleLineSnapshot[]=[];
    const required=new Map<string,number>();
    let subtotal=0,lineDiscounts=0;
    const now=Date.now();

    if(input.customerId){
      const customer=await db.customers.get(input.customerId);
      if(!customer||customer.deleted_at!==null)throw new Error('Customer is unavailable offline.');
    }

    for(const line of input.lines){
      positive(line.qty,'quantity'); nonNegativeMoney(line.discountPaise,'line discount');
      const item=await db.items.get(line.itemId);
      if(!item||item.deleted_at!==null||!item.is_active)throw new Error('Item is unavailable offline.');
      const prices=await db.prices.where('item_id').equals(item.id).toArray();
      const price=effectivePrice(prices,input.shopId,line.priceKind,line.unitLevel,now);
      if(!price)throw new Error(`No cached ${line.priceKind} price for ${item.name}.`);
      const gross=Math.round(line.qty*price.price_paise);
      if(line.discountPaise>gross)throw new Error(`Line discount exceeds ${item.name} value.`);
      const base=baseQty(item,line.unitLevel,line.qty);
      const key=stockKey(input.shopId,item.id);
      required.set(key,(required.get(key)??0)+base);
      subtotal+=gross; lineDiscounts+=line.discountPaise;
      snapshots.push({...line,itemName:item.name,unitName:unitName(item,line.unitLevel),unitPricePaise:price.price_paise,baseQty:base,lineTotalPaise:gross-line.discountPaise});
    }

    const totalDiscount=lineDiscounts+input.discountPaise;
    if(totalDiscount>subtotal)throw new Error('Discount exceeds subtotal.');
    const total=subtotal-totalDiscount+input.extraChargesPaise;
    const paymentTotal=input.payments.reduce((sum,p)=>sum+p.amountPaise,0);
    if(paymentTotal>total)throw new Error('Payments exceed sale total.');
    if(!input.customerId&&paymentTotal!==total)throw new Error('Walk-in sale must be fully paid.');

    for(const [key,qty] of required){
      const stock=await db.stock.get(key);
      const local=await db.reservations.get(key);
      const available=(stock?.available??0)-(local?.qty??0);
      if(available<qty)throw new Error('Insufficient cached stock for this offline sale.');
    }

    const provisionalSequence=await nextSequence(db,'provisionalSeq');
    const outboxSequence=await nextSequence(db,'outboxSeq');
    const provisional=provisionalDocNo(context.deviceId,provisionalSequence);
    const record:OfflineSaleRecord={
      clientId:input.clientId,provisionalDocNo:provisional,officialSaleId:null,officialDocNo:null,
      shopId:input.shopId,customerId:input.customerId??null,businessDate:input.businessDate,
      subtotalPaise:subtotal,discountPaise:totalDiscount,extraChargesPaise:input.extraChargesPaise,totalPaise:total,
      payments:input.payments,lines:snapshots,status:'QUEUED',createdAt:now,syncedAt:null,rejectionReason:null,
    };
    const outbox:OutboxEntry<OfflineSalePayload>={sequence:outboxSequence,clientId:input.clientId,kind:'financial-rpc',target:'post_sale',payload:input,createdAt:now,attempts:0,state:'pending',nextAttemptAt:0,lastError:null};
    await db.offlineSales.put(record);
    await db.outbox.put(outbox);
    for(const [key,qty] of required){
      const prev=await db.reservations.get(key);
      await db.reservations.put({key,shop_id:input.shopId,item_id:key.slice(key.indexOf(':')+1),qty:(prev?.qty??0)+qty});
    }
    return record;
  });
}

export async function completeOfflineSale(db:DsbSyncDb,clientId:string,result:SyncedSaleResult):Promise<void>{
  await db.transaction('rw',[db.offlineSales,db.outbox,db.stock,db.reservations],async()=>{
    const sale=await db.offlineSales.get(clientId);
    if(!sale)throw new Error('Offline sale record is missing.');
    for(const raw of result.stock)await db.stock.put({...raw,key:stockKey(raw.shop_id,raw.item_id)});
    await db.offlineSales.put({...sale,status:'SYNCED',officialSaleId:result.saleId,officialDocNo:result.docNo,syncedAt:Date.now(),rejectionReason:null});
    await db.outbox.where('clientId').equals(clientId).delete();
    await rebuildReservations(db);
  });
}

export async function rejectOfflineSale(db:DsbSyncDb,clientId:string,reason:string,serverRef:unknown=null):Promise<void>{
  await db.transaction('rw',[db.offlineSales,db.outbox,db.conflicts,db.reservations],async()=>{
    const sale=await db.offlineSales.get(clientId);
    if(sale)await db.offlineSales.put({...sale,status:'REJECTED',rejectionReason:reason});
    const outbox=await db.outbox.where('clientId').equals(clientId).first();
    if(outbox)await db.outbox.delete(outbox.sequence);
    const conflict:LocalSyncConflict={createdAt:Date.now(),status:'OPEN',kind:'financial-rejection',target:'post_sale',clientId,reason,payload:sale??outbox?.payload??null,serverRef};
    await db.conflicts.add(conflict);
    await rebuildReservations(db);
  });
}

export async function resolveLocalConflict(db:DsbSyncDb,id:number):Promise<void>{
  const row=await db.conflicts.get(id); if(!row)return;
  await db.conflicts.put({...row,id,status:'RESOLVED'});
}
