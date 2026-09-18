import {test,expect} from '@playwright/test';
import {build} from 'vite';
import {fileURLToPath} from 'node:url';
declare global {interface Window {DsbSync:typeof import('@dsb-pro/sync')}}

test('return IndexedDB transactions preserve replay, overlays and rejection rollback',async({page})=>{
  const built=await build({configFile:false,logLevel:'silent',build:{write:false,minify:false,lib:{entry:fileURLToPath(new URL('../../../packages/sync/src/index.ts',import.meta.url)),name:'DsbSync',formats:['iife']}}});
  const output=Array.isArray(built)?built[0]:built;
  if(!('output' in output))throw new Error('Sync test bundle unexpectedly started a watcher.');
  const chunk=output.output.find(part=>part.type==='chunk');
  if(!chunk||chunk.type!=='chunk')throw new Error('Sync test bundle was not generated.');
  // No auth, server or financial secrets: real browser IndexedDB, isolated DB.
  await page.route('**/offline-return-db-test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Sync database test</title>'}));
  await page.goto('/offline-return-db-test');
  await page.addScriptTag({content:chunk.code});
  const result=await page.evaluate(async()=>{
    const s=window.DsbSync,db=new s.DsbSyncDb(`return-db-test-${crypto.randomUUID()}`);await db.open();
    const source={key:'SALE:source',return_type:'SALE' as const,id:'source',shop_id:'shop',doc_no:'S-1',business_date:'2026-09-15',total_paise:400,customer_name:null,party_name:null,posted_return_client_ids:[],lines:[{id:'line',item_id:'item',item_name_snapshot:'Item',unit_name_snapshot:'piece',qty:4,base_qty:4,returned_qty:0}]};
    const stock={id:'shop:item',key:'shop:item',tenant_id:'tenant',shop_id:'shop',item_id:'item',on_hand:4,reserved:0,available:4,qty_base:4,updated_at:1,deleted_at:null};
    await db.returnSources.put(source);await db.stock.put(stock);
    await db.items.put({id:'item',tenant_id:'tenant',name:'Item',sku:null,unit1:'piece',unit2:null,unit3:null,conv1:null,conv2:null,tax_rate_bp:0,min_stock:0,image_path:null,is_active:true,updated_at:1,deleted_at:null});
    await db.prices.put({id:'price',tenant_id:'tenant',item_id:'item',shop_id:'shop',kind:'retail',unit_level:1,price_paise:100,effective_from:'2020-01-01',effective_to:null,updated_at:1,deleted_at:null});
    const input={type:'SALE' as const,sourceId:'source',shopId:'shop',businessDate:'2026-09-15',clientId:'return-1',lines:[{sourceLineId:'line',qty:2,disposition:'RETURN_TO_SELLABLE' as const}]};
    const context={role:'owner' as const,deviceId:'test-device'};
    const first=await s.queueOfflineReturn(db,input,context);await s.queueOfflineReturn(db,input,context);
    const initial={outbox:await db.outbox.count(),reservation:(await db.reservations.get('shop:item'))?.qty,refund:first.cashRefundPaise,balance:first.balanceCreditPaise};
    let mismatch=false;try{await s.queueOfflineReturn(db,{...input,notes:'different'},context);}catch{mismatch=true;}
    await s.queueOfflineSale(db,{shopId:'shop',businessDate:'2026-09-15',discountPaise:0,extraChargesPaise:0,clientId:'sale-1',lines:[{itemId:'item',unitLevel:1,qty:2,priceKind:'retail',discountPaise:0}],payments:[{amountPaise:200,mode:'cash'}]},{...context,policy:{allowCashierOfflineFinalization:true,allowNegativeStock:false},onlineInitiated:false});
    const mixedProjection=(await db.reservations.get('shop:item'))?.qty;
    const ack={returnId:'official-return',docNo:'SR-1',status:'POSTED' as const,totalPaise:200,cashRefundPaise:150,balanceCreditPaise:50,stock:[{...stock,available:6,on_hand:6,qty_base:6,updated_at:2}]};
    await s.completeOfflineReturn(db,input.clientId,ack);await s.completeOfflineReturn(db,input.clientId,ack);
    const acknowledged={returned:(await db.returnSources.get(source.key))?.lines[0].returned_qty,reservation:(await db.reservations.get(stock.key))?.qty,refund:(await db.offlineReturns.get(input.clientId))?.cashRefundPaise,outbox:await db.outbox.count()};
    await s.rejectOfflineSale(db,'sale-1','insufficient stock');
    const second={...input,clientId:'return-2',lines:[{...input.lines[0],qty:1}]};
    await s.queueOfflineReturn(db,second,context);
    const queued=await db.outbox.where('clientId').equals(second.clientId).first();
    await db.outbox.put(s.markOutboxSending(queued!));db.close();await db.open();
    await s.recoverInterruptedOutbox(db);
    const recovered=await db.outbox.where('clientId').equals(second.clientId).first();
    await s.rejectOfflineReturn(db,second.clientId,'sale unavailable for return');
    const rejected={status:(await db.offlineReturns.get(second.clientId))?.status,outbox:await db.outbox.count(),stock:(await db.stock.get(stock.key))?.available,reservations:await db.reservations.count()};
    const purchase={...source,key:'PURCHASE:purchase',return_type:'PURCHASE' as const,id:'purchase'};await db.returnSources.put(purchase);
    const purchaseIntent={...second,type:'PURCHASE' as const,sourceId:'purchase',clientId:'purchase-return',lines:[{sourceLineId:'line',qty:2,disposition:'SUPPLIER_RETURN' as const}]};
    await s.queueOfflineReturn(db,purchaseIntent,context);
    const purchaseProjection=(await db.reservations.get(stock.key))?.qty;
    await s.rejectOfflineReturn(db,purchaseIntent.clientId,'purchase unavailable for return');
    let forbidden=false;try{await s.queueOfflineReturn(db,{...purchaseIntent,clientId:'cashier-return'},{...context,role:'cashier'});}catch{forbidden=true;}
    let overReturn=false;try{await s.queueOfflineReturn(db,{...second,clientId:'over-return',lines:[{...second.lines[0],qty:9}]},context);}catch{overReturn=true;}
    const final={outbox:await db.outbox.count(),reservations:await db.reservations.count(),overReturnPersisted:!!await db.offlineReturns.get('over-return')};
    const voidIntent={type:'SALE' as const,returnId:ack.returnId,shopId:'shop',clientId:'void-id'};
    await s.queueReturnVoid(db,voidIntent);await s.queueReturnVoid(db,voidIntent);
    db.close();await db.open();
    let billingBlocked=false;try{await s.queueOfflineSale(db,{shopId:'shop',businessDate:'2026-09-15',discountPaise:0,extraChargesPaise:0,clientId:'blocked-sale',lines:[{itemId:'item',unitLevel:1,qty:1,priceKind:'retail',discountPaise:0}],payments:[{amountPaise:100,mode:'cash'}]},{...context,policy:{allowCashierOfflineFinalization:true,allowNegativeStock:false},onlineInitiated:false});}catch(e){billingBlocked=String(e).includes('void confirmation pending');}
    let malformedBlocked=false;try{await s.completeReturnVoid(db,voidIntent,ack);}catch{malformedBlocked=!!await s.getMeta(db,'pendingReturnVoid');}
    await s.completeReturnVoid(db,voidIntent,{...ack,status:'VOID',stock:[{...stock,updated_at:3}]});
    await s.completeOfflineReturn(db,input.clientId,ack); // stale POSTED reply cannot resurrect a void
    const voided={status:(await db.offlineReturns.get(input.clientId))?.status,returned:(await db.returnSources.get(source.key))?.lines[0].returned_qty,stock:(await db.stock.get(stock.key))?.available};
    const voidSafety={billingBlocked,malformedBlocked,blockCleared:!await s.getMeta(db,'pendingReturnVoid'),outbox:await db.outbox.count()};
    await db.delete();return {initial,mismatch,mixedProjection,acknowledged,recovered:{state:recovered?.state,clientId:recovered?.clientId,payloadMatches:JSON.stringify(recovered?.payload)===JSON.stringify(second)},rejected,purchaseProjection,forbidden,overReturn,final,voided,voidSafety};
  });
  expect(result.initial).toEqual({outbox:1,reservation:-2,refund:null,balance:null});
  expect(result.mismatch).toBe(true);expect(result.mixedProjection).toBe(0);
  expect(result.acknowledged).toEqual({returned:2,reservation:2,refund:150,outbox:1});
  expect(result.recovered).toEqual({state:'retry',clientId:'return-2',payloadMatches:true});
  expect(result.rejected).toEqual({status:'REJECTED',outbox:0,stock:6,reservations:0});
  expect(result.purchaseProjection).toBe(2);expect(result.forbidden).toBe(true);expect(result.overReturn).toBe(true);
  expect(result.final).toEqual({outbox:0,reservations:0,overReturnPersisted:false});
  expect(result.voided).toEqual({status:'VOID',returned:0,stock:4});
  expect(result.voidSafety).toEqual({billingBlocked:true,malformedBlocked:true,blockCleared:true,outbox:0});
});
