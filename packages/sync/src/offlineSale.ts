import {provisionalDocNo} from './outbox';
import {canonicalQuantity,parseQuantityMicros,quantityTimesPaise} from '@dsb-pro/core';
import {rebuildReservations} from './projections';
import {saleIntentFingerprint} from './saleIntent';
import {getMeta,setMeta,stockKey,type DsbSyncDb} from './db';
import type {
  LocalSyncConflict,OfflineRole,OfflineSaleLineSnapshot,OfflineSalePayload,
  OfflineSaleRecord,OutboxEntry,SyncedPrice,SyncedSaleResult,SyncPolicy,
} from './types';

function nonNegativeMoney(value:number,name:string){
  if(!Number.isSafeInteger(value)||value<0)throw new Error(`${name} must be non-negative whole paise`);
}
function addMoney(sum:number,value:number,name:string){
  const total=sum+value;
  if(!Number.isSafeInteger(total))throw new Error(`${name} exceeds the safe integer range`);
  return total;
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
function baseQty(item:{unit2:string|null;unit3:string|null;conv1:number|null;conv2:number|null},level:1|2|3,qty:string):number{
  const value=Number(qty);
  if(level===1)return value*(item.conv1??1)*(item.conv2??1);
  if(level===2){
    if(!item.unit2)throw new Error('Selected small unit is unavailable.');
    return value*(item.conv2??1);
  }
  if(!item.unit3)throw new Error('Selected piece unit is unavailable.');
  return value;
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

export async function queueOfflineSale(
  db:DsbSyncDb,
  input:OfflineSalePayload,
  context:{deviceId:string;role:OfflineRole;policy:SyncPolicy;onlineInitiated:boolean},
):Promise<OfflineSaleRecord>{
  if(context.role==='accountant')throw new Error('Your role cannot finalize sales.');
  if(context.role==='cashier'&&!context.policy.allowCashierOfflineFinalization&&!context.onlineInitiated){
    throw new Error('Offline finalization is disabled for cashiers. Keep this sale as a draft until online.');
  }
  if(!input.lines.length)throw new Error('Sale requires at least one line.');
  nonNegativeMoney(input.discountPaise,'discount');
  nonNegativeMoney(input.extraChargesPaise,'extra charges');
  for(const p of input.payments)nonNegativeMoney(p.amountPaise,'payment');

  return db.transaction('rw',[db.items,db.prices,db.customers,db.stock,db.outbox,db.meta,db.reservations,db.offlineSales,db.offlineReturns],async()=>{
    if(await getMeta(db,'pendingReturnVoid'))throw new Error('Return void confirmation pending. Reconnect before billing.');
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
      const qty=canonicalQuantity(line.qty); parseQuantityMicros(qty); nonNegativeMoney(line.discountPaise,'line discount');
      const item=await db.items.get(line.itemId);
      if(!item||item.deleted_at!==null||!item.is_active)throw new Error('Item is unavailable offline.');
      const prices=await db.prices.where('item_id').equals(item.id).toArray();
      const price=effectivePrice(prices,input.shopId,line.priceKind,line.unitLevel,now);
      if(!price)throw new Error(`No cached ${line.priceKind} price for ${item.name}.`);
      const gross=quantityTimesPaise(qty,price.price_paise);
      if(line.discountPaise>gross)throw new Error(`Line discount exceeds ${item.name} value.`);
      const base=baseQty(item,line.unitLevel,qty);
      const key=stockKey(input.shopId,item.id);
      required.set(key,(required.get(key)??0)+base);
      subtotal=addMoney(subtotal,gross,'subtotal'); lineDiscounts=addMoney(lineDiscounts,line.discountPaise,'line discounts');
      snapshots.push({...line,qty,itemName:item.name,unitName:unitName(item,line.unitLevel),unitPricePaise:price.price_paise,baseQty:base,lineTotalPaise:gross-line.discountPaise});
    }

    const totalDiscount=addMoney(lineDiscounts,input.discountPaise,'discount');
    if(totalDiscount>subtotal)throw new Error('Discount exceeds subtotal.');
    const total=addMoney(subtotal-totalDiscount,input.extraChargesPaise,'sale total');
    const paymentTotal=input.payments.reduce((sum,p)=>addMoney(sum,p.amountPaise,'payment total'),0);
    if(paymentTotal>total)throw new Error('Payments exceed sale total.');
    if(!input.customerId&&paymentTotal!==total)throw new Error('Walk-in sale must be fully paid.');

    if(!context.policy.allowNegativeStock){
      for(const [key,qty] of required){
        const stock=await db.stock.get(key);
        const local=await db.reservations.get(key);
        const available=(stock?.available??0)-(local?.qty??0);
        if(available<qty)throw new Error('Insufficient cached stock for this offline sale.');
      }
    }

    const provisionalSequence=await nextSequence(db,'provisionalSeq');
    const outboxSequence=await nextSequence(db,'outboxSeq');
    const provisional=provisionalDocNo(context.deviceId,provisionalSequence);
    const unsignedPayload:Omit<OfflineSalePayload,'intentFingerprint'>={...input,lines:snapshots.map(line=>({
      itemId:line.itemId,unitLevel:line.unitLevel,qty:line.qty,priceKind:line.priceKind,
      discountPaise:line.discountPaise,expectedUnitPricePaise:line.unitPricePaise,
    }))};
    const intentFingerprint=saleIntentFingerprint(unsignedPayload);
    const record:OfflineSaleRecord={
      clientId:input.clientId,provisionalDocNo:provisional,officialSaleId:null,officialDocNo:null,
      shopId:input.shopId,customerId:input.customerId??null,businessDate:input.businessDate,
      subtotalPaise:subtotal,discountPaise:totalDiscount,extraChargesPaise:input.extraChargesPaise,totalPaise:total,
      payments:input.payments,lines:snapshots,status:'QUEUED',createdAt:now,syncedAt:null,rejectionReason:null,
      intentFingerprint,reconciliationWarning:null,reconciliationReviewedAt:null,
    };
    const serverPayload:OfflineSalePayload={...unsignedPayload,intentFingerprint};
    const outbox:OutboxEntry<OfflineSalePayload>={sequence:outboxSequence,clientId:input.clientId,kind:'financial-rpc',target:'post_sale',payload:serverPayload,createdAt:now,attempts:0,state:'pending',nextAttemptAt:0,lastError:null};
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
  await db.transaction('rw',[db.offlineSales,db.offlineReturns,db.outbox,db.stock,db.reservations],async()=>{
    const sale=await db.offlineSales.get(clientId);
    if(!sale)throw new Error('Offline sale record is missing.');
    if(result.clientId!==clientId)throw new Error('Synced-sale acknowledgement client identity mismatch.');
    const outbox=await db.outbox.where('clientId').equals(clientId).first();
    const payload=outbox?.payload as OfflineSalePayload|undefined;
    const expectedFingerprint=sale.intentFingerprint??payload?.intentFingerprint??null;
    const legacyAcknowledgement=!expectedFingerprint&&result.intentFingerprint.startsWith('legacy:');
    if(!legacyAcknowledgement&&(!expectedFingerprint||result.intentFingerprint!==expectedFingerprint)){
      throw new Error('Synced-sale acknowledgement intent fingerprint mismatch.');
    }
    if(result.lines.length!==sale.lines.length)throw new Error('Synced-sale acknowledgement line count mismatch.');
    const authoritativeLines=sale.lines.map((line,index)=>{
      const server=result.lines[index];
      if(server.itemId!==line.itemId||server.unitLevel!==line.unitLevel||canonicalQuantity(server.qty)!==canonicalQuantity(line.qty)){
        throw new Error('Synced-sale acknowledgement line identity mismatch.');
      }
      return {...line,qty:canonicalQuantity(server.qty),priceKind:server.priceKind,unitPricePaise:server.unitPricePaise,
        discountPaise:server.discountPaise,lineTotalPaise:server.lineTotalPaise};
    });
    const provisionalTotals={subtotalPaise:sale.subtotalPaise,discountPaise:sale.discountPaise,extraChargesPaise:sale.extraChargesPaise,totalPaise:sale.totalPaise};
    const mismatch=provisionalTotals.subtotalPaise!==result.subtotalPaise||provisionalTotals.discountPaise!==result.discountPaise||
      provisionalTotals.extraChargesPaise!==result.extraChargesPaise||provisionalTotals.totalPaise!==result.totalPaise||
      sale.lines.some((line,index)=>line.lineTotalPaise!==result.lines[index].lineTotalPaise||line.unitPricePaise!==result.lines[index].unitPricePaise||
        line.discountPaise!==result.lines[index].discountPaise||line.priceKind!==result.lines[index].priceKind)||
      sale.payments.length!==result.payments.length||sale.payments.some((payment,index)=>{
        const server=result.payments[index];
        return !server||payment.amountPaise!==server.amountPaise||payment.mode!==server.mode||
          (payment.reference??null)!==(server.reference??null);
      });
    for(const raw of result.stock)await db.stock.put({...raw,key:stockKey(raw.shop_id,raw.item_id)});
    await db.offlineSales.put({...sale,status:'SYNCED',officialSaleId:result.saleId,officialDocNo:result.docNo,syncedAt:Date.now(),rejectionReason:null,
      subtotalPaise:result.subtotalPaise,discountPaise:result.discountPaise,extraChargesPaise:result.extraChargesPaise,totalPaise:result.totalPaise,
      payments:result.payments,lines:authoritativeLines,provisionalTotals:mismatch?provisionalTotals:undefined,
      reconciliationWarning:mismatch?'Server totals replaced this device’s provisional totals. Review before relying on the local receipt.':null,
      reconciliationReviewedAt:null,intentFingerprint:expectedFingerprint??result.intentFingerprint});
    await db.outbox.where('clientId').equals(clientId).delete();
    await rebuildReservations(db);
  });
}

export async function reviewOfflineSaleReconciliation(db:DsbSyncDb,clientId:string):Promise<void>{
  const sale=await db.offlineSales.get(clientId);
  if(!sale?.reconciliationWarning)return;
  await db.offlineSales.put({...sale,reconciliationReviewedAt:Date.now()});
}

export async function rejectOfflineSale(db:DsbSyncDb,clientId:string,reason:string,serverRef:unknown=null):Promise<void>{
  await db.transaction('rw',[db.offlineSales,db.offlineReturns,db.outbox,db.conflicts,db.reservations],async()=>{
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
