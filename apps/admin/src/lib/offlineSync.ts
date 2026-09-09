import {
  ackSync,classifyError,errorMessage,getDefaultShopId,getOrCreateDeviceId,pullSync,pushSyncedSale,
  recordServerSyncConflict,setOfflineCashierFinalization,subscribeSyncWakeup,
  type Membership,type SaleLineInput,type SalePaymentInput,
} from '@dsb-pro/adapters';
import {
  applySyncPull,completeOfflineSale,getCachedBusinessDate,getCachedCustomers,getCachedItems,getCachedPolicy,getCachedPrices,
  getSyncCursors,getSyncHealth,isDefinitiveFinancialRejectionMessage,markOutboxRetry,markOutboxSending,nextOutboxEntry,openSyncDb,queueOfflineSale,
  recoverInterruptedOutbox,rejectOfflineSale,retryDelayMs,resolveLocalConflict,
  type DsbSyncDb,type LocalSyncConflict,type OfflineSalePayload,type OfflineSaleRecord,type OutboxEntry,
  type SyncedBarcode,type SyncedCustomer,type SyncedItem,type SyncedPrice,type SyncIdentity,type SyncPullPayload,type SyncedSaleResult,
} from '@dsb-pro/sync';

type Runtime={identity:SyncIdentity;db:DsbSyncDb;timer:number;unsubscribeRealtime:(()=>void)|null;running:Promise<void>|null};
type PublicState={online:boolean;running:boolean;lastError:string|null;lastCycleAt:number|null};
let runtime:Runtime|null=null;
let state:PublicState={online:typeof navigator==='undefined'?true:navigator.onLine,running:false,lastError:null,lastCycleAt:null};
const waiters:Array<{resolve:()=>void;reject:(e:Error)=>void;timer:number}>=[];

function emit(){
  state={...state,online:typeof navigator==='undefined'?true:navigator.onLine};
  if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent('dsb-sync-state'));
}
function asPull(value:Awaited<ReturnType<typeof pullSync>>):SyncPullPayload{
  return value as unknown as SyncPullPayload;
}
function asSale(value:Awaited<ReturnType<typeof pushSyncedSale>>):SyncedSaleResult{
  return value as unknown as SyncedSaleResult;
}
function reason(error:unknown){return errorMessage(classifyError(error),error)||String(error);}
function requireRuntime():Runtime{
  if(!runtime)throw new Error('Offline cache is still starting. Wait a moment and try again.');
  return runtime;
}
function resolveWaiters(){
  while(waiters.length){
    const w=waiters.shift()!; window.clearTimeout(w.timer); w.resolve();
  }
}

export async function waitForOfflineRuntime(timeoutMs=5000):Promise<void>{
  if(runtime)return;
  await new Promise<void>((resolve,reject)=>{
    const timer=window.setTimeout(()=>{
      const i=waiters.findIndex(w=>w.timer===timer); if(i>=0)waiters.splice(i,1);
      reject(new Error('Offline cache did not start in time.'));
    },timeoutMs);
    waiters.push({resolve,reject,timer});
  });
}

export async function startOfflineSync(input:{userId:string;membership:Membership}):Promise<void>{
  const deviceId=getOrCreateDeviceId();
  const shopId=input.membership.shopIds[0]??await getDefaultShopId();
  const identity:SyncIdentity={userId:input.userId,tenantId:input.membership.tenantId,shopId,deviceId,role:input.membership.role};
  if(runtime&&runtime.identity.userId===identity.userId&&runtime.identity.tenantId===identity.tenantId&&runtime.identity.deviceId===identity.deviceId)return;
  stopOfflineSync();
  const db=await openSyncDb(identity);
  await recoverInterruptedOutbox(db);
  runtime={identity,db,timer:0,unsubscribeRealtime:null,running:null};
  runtime.timer=window.setInterval(()=>{void runSyncNow();},30000);
  runtime.unsubscribeRealtime=subscribeSyncWakeup(()=>{void runSyncNow();});
  window.addEventListener('online',onlineHandler);
  window.addEventListener('offline',offlineHandler);
  resolveWaiters();
  emit();
  await runSyncNow();
}
function onlineHandler(){emit();void runSyncNow();}
function offlineHandler(){emit();}
export function stopOfflineSync(){
  if(!runtime)return;
  window.clearInterval(runtime.timer);
  runtime.unsubscribeRealtime?.();
  window.removeEventListener('online',onlineHandler);
  window.removeEventListener('offline',offlineHandler);
  runtime=null; emit();
}

async function processOutbox(rt:Runtime){
  for(let guard=0;guard<100;guard++){
    const rows=await rt.db.outbox.orderBy('sequence').toArray();
    const next=nextOutboxEntry(rows,Date.now());
    if(!next)return;
    const sending=markOutboxSending(next);
    await rt.db.outbox.put(sending);
    if(sending.kind!=='financial-rpc'||sending.target!=='post_sale'){
      const message=`Unsupported outbox target ${sending.target}`;
      await rejectOfflineSale(rt.db,sending.clientId,message);
      continue;
    }
    const payload=sending.payload as OfflineSalePayload;
    let result:Awaited<ReturnType<typeof pushSyncedSale>>;
    try{
      result=await pushSyncedSale({
        deviceId:rt.identity.deviceId,shopId:payload.shopId,customerId:payload.customerId,businessDate:payload.businessDate,
        discountPaise:payload.discountPaise,extraChargesPaise:payload.extraChargesPaise,clientId:payload.clientId,
        lines:payload.lines as Array<SaleLineInput&{expectedUnitPricePaise?:number}>,payments:payload.payments as SalePaymentInput[],notes:payload.notes,
      });
    }catch(error){
      const message=reason(error);
      if(!isDefinitiveFinancialRejectionMessage(error instanceof Error?error.message:String(error))){
        // Any unknown transport/server/response-shape outcome stays retryable.
        // Financial work is removed from the outbox only for an explicit,
        // recognized business rejection from the authoritative server.
        const retry=markOutboxRetry(sending,message,Date.now()+retryDelayMs(sending.attempts+1));
        await rt.db.outbox.put(retry);
        return;
      }
      await rejectOfflineSale(rt.db,sending.clientId,message);
      void recordServerSyncConflict({
        deviceId:rt.identity.deviceId,opClientId:sending.clientId,kind:'financial-rejection',target:sending.target,
        reason:message,payload:sending.payload,serverRef:null,clientId:crypto.randomUUID(),
      }).catch(()=>undefined);
      continue;
    }

    try{
      await completeOfflineSale(rt.db,sending.clientId,asSale(result));
    }catch(error){
      // The server has already confirmed the financial event. A local
      // IndexedDB failure is therefore an UNKNOWN acknowledgement outcome,
      // never a business rejection. Keep the exact outbox operation so the
      // idempotent server RPC can be retried after local storage recovers.
      const retry=markOutboxRetry(
        sending,
        `Server confirmed sale but local acknowledgement failed: ${reason(error)}`,
        Date.now()+retryDelayMs(sending.attempts+1),
      );
      await rt.db.outbox.put(retry);
      return;
    }
  }
  throw new Error('Sync outbox safety limit reached.');
}

export async function runSyncNow():Promise<void>{
  const rt=requireRuntime();
  if(rt.running)return rt.running;
  rt.running=(async()=>{
    state={...state,running:true,lastError:null};emit();
    try{
      await processOutbox(rt);
      const cursors=await getSyncCursors(rt.db);
      const pulled=await pullSync({deviceId:rt.identity.deviceId,shopId:rt.identity.shopId,cursors});
      await applySyncPull(rt.db,asPull(pulled));
      const nextCursors=await getSyncCursors(rt.db);
      await ackSync({deviceId:rt.identity.deviceId,cursors:nextCursors});
      state={...state,lastCycleAt:Date.now(),lastError:null};
    }catch(error){
      state={...state,lastError:reason(error)};
    }finally{
      state={...state,running:false};emit(); rt.running=null;
    }
  })();
  return rt.running;
}

export type ResilientSaleResult=
  |{kind:'synced';saleId:string;docNo:string}
  |{kind:'queued';provisionalDocNo:string};

export async function finalizeSaleResilient(input:{
  shopId:string;customerId?:string;businessDate:string;discountPaise:number;extraChargesPaise:number;clientId:string;
  lines:SaleLineInput[];payments:SalePaymentInput[];notes?:string;
}):Promise<ResilientSaleResult>{
  const rt=requireRuntime();
  const policy=(await getCachedPolicy(rt.db))??{allowCashierOfflineFinalization:false};
  if(rt.identity.role==='cashier'&&!policy.allowCashierOfflineFinalization){
    if(typeof navigator==='undefined'||!navigator.onLine){
      throw new Error('Offline finalization is disabled for cashiers. Keep this sale as a draft until online.');
    }
    await runSyncNow();
    if(state.lastError){
      throw new Error('Cashier finalization needs a live server connection. Your cart is preserved; retry when sync is healthy.');
    }
  }
  const onlineInitiated=typeof navigator!=='undefined'&&navigator.onLine&&!state.lastError;
  const payload={...input,lines:input.lines.map(l=>({...l,discountPaise:l.discountPaise??0})),payments:input.payments};
  let record:OfflineSaleRecord;
  try{
    record=await queueOfflineSale(rt.db,payload,{deviceId:rt.identity.deviceId,role:rt.identity.role,policy,onlineInitiated});
  }catch(error){
    if(typeof navigator==='undefined'||!navigator.onLine)throw error;
    // A freshly-created item/price can be inside the server's 1-second cursor
    // safety window. Wait past that window, pull once, then retry locally.
    await new Promise(resolve=>window.setTimeout(resolve,1100));
    await runSyncNow();
    const retryOnlineInitiated=typeof navigator!=='undefined'&&navigator.onLine&&!state.lastError;
    record=await queueOfflineSale(rt.db,payload,{deviceId:rt.identity.deviceId,role:rt.identity.role,policy,onlineInitiated:retryOnlineInitiated});
  }
  emit();
  if(navigator.onLine)await runSyncNow();
  const final=await rt.db.offlineSales.get(record.clientId);
  if(final?.status==='SYNCED'&&final.officialSaleId&&final.officialDocNo)return {kind:'synced',saleId:final.officialSaleId,docNo:final.officialDocNo};
  if(final?.status==='REJECTED')throw new Error(final.rejectionReason??'Queued sale was rejected by the server.');
  return {kind:'queued',provisionalDocNo:record.provisionalDocNo};
}

export function getOfflineRuntimeState():PublicState{return {...state};}
export function getOfflineRuntimeIdentity():SyncIdentity|null{return runtime?.identity??null;}
export async function getOfflineItems():Promise<SyncedItem[]>{return getCachedItems(requireRuntime().db);}
export async function getOfflineCustomers():Promise<SyncedCustomer[]>{return getCachedCustomers(requireRuntime().db);}
export async function getOfflinePrices(itemId:string):Promise<SyncedPrice[]>{return getCachedPrices(requireRuntime().db,itemId);}
export async function getOfflineBusinessDate():Promise<string|null>{return getCachedBusinessDate(requireRuntime().db);}
export async function findOfflineBarcode(barcode:string):Promise<SyncedBarcode|null>{
  const db=requireRuntime().db; const row=await db.barcodes.where('barcode').equals(barcode.trim()).first();
  return row&&row.deleted_at===null?row:null;
}
export async function listOfflineSales():Promise<OfflineSaleRecord[]>{
  return (await requireRuntime().db.offlineSales.orderBy('createdAt').reverse().toArray()).slice(0,50);
}
export async function getSyncDashboard(){
  const rt=requireRuntime();
  const [health,conflicts,sales]=await Promise.all([
    getSyncHealth(rt.db),rt.db.conflicts.orderBy('createdAt').reverse().toArray(),listOfflineSales(),
  ]);
  return {health,conflicts,sales,state:getOfflineRuntimeState(),identity:rt.identity,policy:(await getCachedPolicy(rt.db))??{allowCashierOfflineFinalization:false}};
}
export async function forceRetryNow():Promise<void>{
  const rt=requireRuntime();
  const retries=await rt.db.outbox.where('state').equals('retry').toArray();
  await rt.db.outbox.bulkPut(retries.map(r=>({...r,nextAttemptAt:0} as OutboxEntry)));
  await runSyncNow();
}
export async function resolveConflictLocally(conflict:LocalSyncConflict):Promise<void>{
  if(conflict.id===undefined)return;
  await resolveLocalConflict(requireRuntime().db,conflict.id);emit();
}
export async function updateCashierOfflinePolicy(allow:boolean):Promise<void>{
  await setOfflineCashierFinalization(allow);
  await runSyncNow();
}
