import {
  ackSync,classifyError,ensureFreshSession,errorMessage,getDefaultShopId,getOrCreateDeviceId,listServerSyncConflicts,pullSyncTable,pushSyncedSale,
  recordServerSyncConflict,resolveServerSyncConflict,setOfflineCashierFinalization,subscribeSyncWakeup,SYNC_PULL_LIMITS,
  pullReturnSources,pushSyncedReturn,pushSyncedReturnVoid,type Membership,type SaleLineInput,type SalePaymentInput,type SyncPullTable,
} from '@dsb-pro/adapters';
import {
  applySyncPull,completeOfflineSale,getCachedBusinessDate,getCachedCustomers,getCachedItems,getCachedPolicy,getCachedPrices,
  getSyncCursors,getSyncHealth,isDefinitiveFinancialRejectionMessage,markOutboxRetry,markOutboxSending,nextOutboxEntry,openSyncDb,queueOfflineSale,
  recoverInterruptedOutbox,rejectOfflineSale,retryDelayMs,resolveLocalConflict,
  restrictCachedCostPrices,
  reviewOfflineSaleReconciliation,
  type DsbSyncDb,type LocalSyncConflict,type OfflineSalePayload,type OfflineSaleRecord,type OutboxEntry,
  cacheReturnSources,returnableCachedLines,queueOfflineReturn,completeOfflineReturn,rejectOfflineReturn,queueReturnVoid,completeReturnVoid,getMeta,canUnblockRejectedReturnVoid,type ReturnVoidIntent,
  type OfflineReturnPayload,type OfflineReturnRecord,type OfflineReturnType,
  holdCart,listHeldCarts,discardHeldCart,claimHeldCart,releaseHeldCartClaim,completeHeldCartResume,type HeldCartLine,type HeldCartRecord,
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
function asPull(value:Awaited<ReturnType<typeof pullSyncTable>>):SyncPullPayload{
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
  // A role downgrade must remove a formerly authorized cost cache even when
  // this device starts offline and cannot yet receive the server capability.
  if(identity.role==='cashier')await restrictCachedCostPrices(db);
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
function onlineHandler(){emit();void forceRetryNow();}
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
    // An unknown-outcome operation may already have committed at the server.
    // Do not pull that movement beneath its still-pending local overlay.
    if(!next)return rows.length===0;
    const sending=markOutboxSending(next);
    await rt.db.outbox.put(sending);
    if(sending.kind==='financial-rpc'&&sending.target==='void_return'){
      const intent=sending.payload as ReturnVoidIntent;
      try{await completeReturnVoid(rt.db,intent,await pushSyncedReturnVoid({...intent,deviceId:rt.identity.deviceId}));}
      catch(error){
        const message=error instanceof Error?error.message:String(error);
        // Unknown outcomes and read snapshots retain the durable billing block.
        // A later permission/device rejection cannot prove an earlier unknown
        // attempt did not commit. Only a first-attempt DB rejection can unblock.
        if(canUnblockRejectedReturnVoid(sending.attempts,message,intent.readOnly)){
          await rt.db.transaction('rw',[rt.db.meta,rt.db.outbox,rt.db.conflicts],async()=>{
            await rt.db.conflicts.add({createdAt:Date.now(),status:'OPEN',kind:'financial-rejection',target:'void_return',clientId:intent.clientId,reason:message,payload:intent,serverRef:null});
            await rt.db.outbox.where('clientId').equals(intent.clientId).delete();await rt.db.meta.delete('pendingReturnVoid');
          });
        }else{await rt.db.outbox.put(markOutboxRetry(sending,message,Date.now()+retryDelayMs(sending.attempts+1)));throw error;}
      }
      continue;
    }
    if(sending.kind==='financial-rpc'&&sending.target==='post_return'){
      try{
        const result=await pushSyncedReturn({...sending.payload as OfflineReturnPayload,deviceId:rt.identity.deviceId});
        await completeOfflineReturn(rt.db,sending.clientId,result);
      }catch(error){
        const message=error instanceof Error?error.message:String(error);
        if(isDefinitiveFinancialRejectionMessage(message))await rejectOfflineReturn(rt.db,sending.clientId,message);
        else {await rt.db.outbox.put(markOutboxRetry(sending,message,Date.now()+retryDelayMs(sending.attempts+1)));throw error;}
      }
      continue;
    }
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
        intentFingerprint:payload.intentFingerprint??'',
        lines:payload.lines as Array<SaleLineInput&{expectedUnitPricePaise?:number}>,payments:payload.payments as SalePaymentInput[],notes:payload.notes,
      });
    }catch(error){
      const message=reason(error);
      if(!isDefinitiveFinancialRejectionMessage(error instanceof Error?error.message:String(error))){
        const retry=markOutboxRetry(sending,message,Date.now()+retryDelayMs(sending.attempts+1));
        await rt.db.outbox.put(retry);
        throw error;
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
      const retry=markOutboxRetry(
        sending,
        `Server confirmed sale but local acknowledgement failed: ${reason(error)}`,
        Date.now()+retryDelayMs(sending.attempts+1),
      );
      await rt.db.outbox.put(retry);
      throw error;
    }
  }
  throw new Error('Sync outbox safety limit reached.');
}

async function pullTablePages(rt:Runtime,table:SyncPullTable){
  for(let page=0;page<100;page++){
    const cursors=await getSyncCursors(rt.db);
    const pulled=await pullSyncTable({table,deviceId:rt.identity.deviceId,shopId:rt.identity.shopId,cursors});
    await applySyncPull(rt.db,asPull(pulled));
    if(pulled[table].length<SYNC_PULL_LIMITS[table])return;
  }
  throw new Error(`Sync pull safety limit reached before ${table} pages were drained.`);
}

async function pullAllPages(rt:Runtime){
  // Items are the billing catalog and must become searchable first on a weak
  // link. Sharing the initial bandwidth with four other large tables left a
  // 10k catalog only partially usable at the performance deadline. Once items
  // are complete, drain the dependent/reference caches concurrently.
  await pullTablePages(rt,'items');
  const remaining=(Object.keys(SYNC_PULL_LIMITS) as SyncPullTable[]).filter(table=>table!=='items');
  await Promise.all(remaining.map(table=>pullTablePages(rt,table)));
  await refreshOfflineReturnSources();
  return getSyncCursors(rt.db);
}

export async function runSyncNow():Promise<void>{
  const rt=requireRuntime();
  if(typeof navigator!=='undefined'&&!navigator.onLine){emit();return;}
  if(rt.running)return rt.running;
  rt.running=(async()=>{
    state={...state,running:true,lastError:null};emit();
    try{
      const session=await ensureFreshSession();
      if(!session)throw new Error('Authentication session is unavailable. Sign in again before syncing queued work.');
      if(!await processOutbox(rt))return;
      const nextCursors=await pullAllPages(rt);
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
  const policy=(await getCachedPolicy(rt.db))??{allowCashierOfflineFinalization:false,allowNegativeStock:false,canViewCostPrices:false};
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
export async function refreshOfflineReturnSources():Promise<void>{
  const rt=requireRuntime();
  await cacheReturnSources(rt.db,rt.identity.shopId,await pullReturnSources({deviceId:rt.identity.deviceId,shopId:rt.identity.shopId}));
}
export async function getOfflineReturnSources(type:OfflineReturnType){
  const rt=requireRuntime();
  return (await rt.db.returnSources.where('shop_id').equals(rt.identity.shopId).toArray()).filter(row=>row.return_type===type);
}
export async function getOfflineReturnLines(type:OfflineReturnType,sourceId:string){return returnableCachedLines(requireRuntime().db,type,sourceId);}
export async function listOfflineReturns():Promise<OfflineReturnRecord[]>{return (await requireRuntime().db.offlineReturns.orderBy('createdAt').reverse().toArray()).slice(0,100);}
export async function reviewOfflineSaleMismatch(clientId:string):Promise<void>{await reviewOfflineSaleReconciliation(requireRuntime().db,clientId);emit();}
export async function holdCurrentCart(input:{label:string;customerId:string;globalDiscount:string;extra:string;lines:HeldCartLine[]}):Promise<HeldCartRecord>{
  const rt=requireRuntime();
  return holdCart(rt.db,{shopId:rt.identity.shopId,...input});
}
export async function listHeldCartsForShop():Promise<HeldCartRecord[]>{
  const rt=requireRuntime();
  return listHeldCarts(rt.db,rt.identity.shopId);
}
export async function claimHeldCartForResume(id:string,token:string):Promise<HeldCartRecord|undefined>{return claimHeldCart(requireRuntime().db,id,token);}
export async function releaseHeldCartForResume(id:string,token:string):Promise<boolean>{return releaseHeldCartClaim(requireRuntime().db,id,token);}
export async function completeHeldCartForResume(id:string,token:string):Promise<boolean>{return completeHeldCartResume(requireRuntime().db,id,token);}
export async function discardHeldCartById(id:string):Promise<void>{return discardHeldCart(requireRuntime().db,id);}
export async function recordLocalReturnVoid(returnId:string):Promise<void>{
  const rt=requireRuntime(),row=await rt.db.offlineReturns.filter(row=>row.officialReturnId===returnId&&row.status!=='VOID').first();
  if(!row||await getMeta(rt.db,'pendingReturnVoid'))return;
  await queueReturnVoid(rt.db,{type:row.payload.type,returnId,shopId:rt.identity.shopId,clientId:crypto.randomUUID(),readOnly:true});
  emit();await runSyncNow();
  if(navigator.onLine&&await getMeta(rt.db,'pendingReturnVoid'))await runSyncNow();
}
export async function voidReturnResilient(type:OfflineReturnType,returnId:string):Promise<void>{
  if(!navigator.onLine)throw new Error('Reconnect before voiding a confirmed return.');
  const rt=requireRuntime(),intent=await queueReturnVoid(rt.db,{type,returnId,shopId:rt.identity.shopId,clientId:crypto.randomUUID()});
  emit();await runSyncNow();
  // The intent can be appended after an already-running cycle drained its
  // outbox. Joining that cycle alone does not send this newly queued void.
  if(navigator.onLine&&await getMeta(rt.db,'pendingReturnVoid'))await runSyncNow();
  if(await getMeta(rt.db,'pendingReturnVoid'))throw new Error('Void confirmation pending — billing is blocked until reconnect confirms authoritative stock.');
  const rejected=await rt.db.conflicts.filter(row=>row.target==='void_return'&&row.status==='OPEN'&&row.clientId===intent.clientId).first();
  if(rejected)throw new Error(rejected.reason);
}
export async function hasPendingReturnVoid():Promise<boolean>{return !!await getMeta(requireRuntime().db,'pendingReturnVoid');}
export async function postReturnResilient(input:OfflineReturnPayload):Promise<OfflineReturnRecord>{
  const rt=requireRuntime();
  if(input.shopId!==rt.identity.shopId)throw new Error('Return shop does not match this till.');
  const record=await queueOfflineReturn(rt.db,input,{role:rt.identity.role,deviceId:rt.identity.deviceId});
  emit();
  if(navigator.onLine)await runSyncNow();
  const final=(await rt.db.offlineReturns.get(record.clientId))??record;
  return final;
}
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
export async function exportOfflineBillingSnapshot(){
  const rt=requireRuntime();
  const [items,barcodes,prices,customers,stock,outbox,metadata,conflicts,reservations,offlineSales,returnSources,offlineReturns,heldCarts]=await Promise.all([
    rt.db.items.toArray(),rt.db.barcodes.toArray(),rt.db.prices.toArray(),rt.db.customers.toArray(),rt.db.stock.toArray(),
    rt.db.outbox.toArray(),rt.db.meta.toArray(),rt.db.conflicts.toArray(),rt.db.reservations.toArray(),rt.db.offlineSales.toArray(),
    rt.db.returnSources.toArray(),rt.db.offlineReturns.toArray(),rt.db.heldCarts.toArray(),
  ]);
  return {
    schemaVersion:3,exportKind:'offline-billing-continuity',exportedAt:new Date().toISOString(),identity:rt.identity,
    items,barcodes,prices,customers,stock,outbox,metadata,conflicts,reservations,offlineSales,returnSources,offlineReturns,heldCarts,
  };
}
export async function getSyncDashboard(){
  const rt=requireRuntime();
  const serverConflictPromise=(typeof navigator!=='undefined'&&!navigator.onLine)
    ? Promise.resolve([])
    : listServerSyncConflicts().catch(()=>[]);
  const [health,conflicts,sales,serverConflicts]=await Promise.all([
    getSyncHealth(rt.db),rt.db.conflicts.orderBy('createdAt').reverse().toArray(),listOfflineSales(),
    serverConflictPromise,
  ]);
  return {health,conflicts,sales,serverConflicts,state:getOfflineRuntimeState(),identity:rt.identity,policy:(await getCachedPolicy(rt.db))??{allowCashierOfflineFinalization:false,allowNegativeStock:false,canViewCostPrices:false}};
}
export async function forceRetryNow():Promise<void>{
  const rt=requireRuntime();
  if(rt.running)await rt.running;

  const retryWaits=[0,500,1000,2000,4000];
  for(let attempt=0;attempt<retryWaits.length;attempt++){
    if(retryWaits[attempt]>0)await new Promise(resolve=>window.setTimeout(resolve,retryWaits[attempt]));
    await recoverInterruptedOutbox(rt.db);
    const retries=await rt.db.outbox.where('state').equals('retry').toArray();
    if(retries.length)await rt.db.outbox.bulkPut(retries.map(r=>({...r,nextAttemptAt:0} as OutboxEntry)));

    await runSyncNow();
    if((await rt.db.outbox.count())===0)return;
    if(typeof navigator!=='undefined'&&!navigator.onLine)return;
  }
}
export async function resolveConflictLocally(conflict:LocalSyncConflict):Promise<void>{
  if(conflict.id===undefined)return;
  await resolveLocalConflict(requireRuntime().db,conflict.id);emit();
}
export async function updateCashierOfflinePolicy(allow:boolean):Promise<void>{
  await setOfflineCashierFinalization(allow);
  await runSyncNow();
}

export async function resolveConflictOnServer(id:string):Promise<void>{
  const rt=requireRuntime();
  await resolveServerSyncConflict({deviceId:rt.identity.deviceId,id});
  emit();
}
