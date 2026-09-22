import { afterEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { DsbSyncDb } from './db';
import { completeOfflineSale,queueOfflineSale } from './offlineSale';
import type { OfflineSaleRecord, OutboxEntry, SyncedSaleResult } from './types';

const open: DsbSyncDb[] = [];
afterEach(async () => {
  for (const db of open.splice(0)) { db.close(); await db.delete(); }
});

function record(totalPaise: number): OfflineSaleRecord {
  return {
    clientId:'client-145',provisionalDocNo:'T-device-1',officialSaleId:null,officialDocNo:null,
    shopId:'shop',customerId:null,businessDate:'2026-09-20',subtotalPaise:totalPaise,discountPaise:0,
    extraChargesPaise:0,totalPaise,payments:[{amountPaise:totalPaise,mode:'cash'}],
    lines:[{itemId:'item',unitLevel:1,qty:'0.145',priceKind:'retail',discountPaise:0,expectedUnitPricePaise:100,
      itemName:'Tie item',unitName:'Each',unitPricePaise:100,baseQty:0.145,lineTotalPaise:totalPaise}],
    status:'QUEUED',createdAt:1,syncedAt:null,rejectionReason:null,intentFingerprint:'intent-v1:test',
    reconciliationWarning:null,reconciliationReviewedAt:null,
  };
}

function result(totalPaise=15): SyncedSaleResult {
  return {
    saleId:'sale-1',docNo:'INV-000001',clientId:'client-145',intentFingerprint:'intent-v1:test',stock:[],
    subtotalPaise:totalPaise,discountPaise:0,extraChargesPaise:0,totalPaise,
    lines:[{itemId:'item',unitLevel:1,qty:'0.145',priceKind:'retail',unitPricePaise:100,discountPaise:0,lineTotalPaise:totalPaise}],
    payments:[{amountPaise:totalPaise,mode:'cash'}],
  };
}

async function seeded(totalPaise:number):Promise<DsbSyncDb>{
  const db=new DsbSyncDb(`sale-reconcile-${crypto.randomUUID()}`); open.push(db); await db.open();
  const outbox:OutboxEntry={sequence:1,clientId:'client-145',kind:'financial-rpc',target:'post_sale',payload:{},createdAt:1,attempts:1,state:'sending',nextAttemptAt:0,lastError:null};
  await db.offlineSales.put(record(totalPaise)); await db.outbox.put(outbox); return db;
}

describe('authoritative offline-sale acknowledgement',()=>{
  it('replaces a pre-fix 0.145 × 100 snapshot and preserves a persistent warning',async()=>{
    const db=await seeded(14);
    await completeOfflineSale(db,'client-145',result(15));
    const sale=await db.offlineSales.get('client-145');
    expect(sale).toMatchObject({status:'SYNCED',officialSaleId:'sale-1',totalPaise:15,
      provisionalTotals:{subtotalPaise:14,totalPaise:14},reconciliationReviewedAt:null});
    expect(sale?.lines[0].lineTotalPaise).toBe(15);
    expect(sale?.reconciliationWarning).toMatch(/Server totals replaced/);
    expect(await db.outbox.count()).toBe(0);
  });

  it('queues and reconciles the new-format 0.145 × 100 sale without a false warning',async()=>{
    const db=new DsbSyncDb(`sale-compound-${crypto.randomUUID()}`); open.push(db); await db.open();
    await db.items.put({id:'item',tenant_id:'tenant',name:'Tie item',sku:null,unit1:'Each',unit2:null,unit3:null,
      conv1:null,conv2:null,tax_rate_bp:0,min_stock:0,image_path:null,is_active:true,updated_at:1,deleted_at:null});
    await db.prices.put({id:'price',tenant_id:'tenant',item_id:'item',shop_id:'shop',kind:'retail',unit_level:1,price_paise:100,
      effective_from:'2026-01-01T00:00:00Z',effective_to:null,updated_at:1,deleted_at:null});
    await db.stock.put({id:'shop:item',key:'shop:item',tenant_id:'tenant',shop_id:'shop',item_id:'item',on_hand:1,reserved:0,available:1,qty_base:1,updated_at:1,deleted_at:null});
    const queued=await queueOfflineSale(db,{clientId:'client-145',shopId:'shop',businessDate:'2026-09-20',discountPaise:0,extraChargesPaise:0,
      lines:[{itemId:'item',unitLevel:1,qty:'0.145',priceKind:'retail',discountPaise:0}],payments:[{amountPaise:15,mode:'cash'}]},
      {deviceId:'device',role:'owner',policy:{allowCashierOfflineFinalization:false,allowNegativeStock:false,canViewCostPrices:true},onlineInitiated:false});
    expect(queued).toMatchObject({subtotalPaise:15,totalPaise:15,status:'QUEUED'});
    const fingerprint=queued.intentFingerprint!;
    await completeOfflineSale(db,'client-145',{...result(15),intentFingerprint:fingerprint});
    expect(await db.offlineSales.get('client-145')).toMatchObject({status:'SYNCED',totalPaise:15,reconciliationWarning:null});
    expect(await db.outbox.count()).toBe(0);
  });

  it('does not mutate or acknowledge a response for another intent',async()=>{
    const db=await seeded(14);
    await expect(completeOfflineSale(db,'client-145',{...result(),intentFingerprint:'intent-v1:wrong'})).rejects.toThrow(/fingerprint mismatch/);
    expect(await db.offlineSales.get('client-145')).toMatchObject({status:'QUEUED',totalPaise:14});
    expect(await db.outbox.count()).toBe(1);
  });
});
