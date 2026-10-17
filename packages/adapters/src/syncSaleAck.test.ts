import {beforeEach,describe,expect,it,vi} from 'vitest';

const rpc=vi.fn();
vi.mock('./client',()=>({getSupabaseClient:()=>({rpc})}));

import {pushSyncedSale} from './sync';

const input={deviceId:'device',shopId:'shop',businessDate:'2026-09-20',discountPaise:0,extraChargesPaise:0,
  clientId:'client',intentFingerprint:'intent-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  lines:[{itemId:'item',unitLevel:1 as const,qty:'0.145',priceKind:'retail' as const,discountPaise:0,expectedUnitPricePaise:100}],
  payments:[{amountPaise:15,mode:'cash' as const}]};
const acknowledgement={saleId:'sale',docNo:'INV-1',clientId:'client',intentFingerprint:input.intentFingerprint,
  subtotalPaise:15,discountPaise:0,extraChargesPaise:0,totalPaise:15,stock:[],
  lines:[{itemId:'item',unitLevel:1,qty:'0.145',priceKind:'retail',unitPricePaise:100,discountPaise:0,lineTotalPaise:15}],
  payments:[{amountPaise:15,mode:'cash',reference:null}]};

describe('synced-sale authoritative acknowledgement',()=>{
  beforeEach(()=>rpc.mockReset());

  it('sends canonical quantity and the intent checksum in every server line',async()=>{
    rpc.mockResolvedValue({data:acknowledgement,error:null});
    await expect(pushSyncedSale(input)).resolves.toEqual(acknowledgement);
    expect(rpc).toHaveBeenCalledWith('phase5_sync_post_sale',expect.objectContaining({
      p_lines:[expect.objectContaining({qty:'0.145',intent_fingerprint:input.intentFingerprint})],
    }));
  });

  it('refuses a shallow or malformed acknowledgement before local reconciliation',async()=>{
    rpc.mockResolvedValue({data:{...acknowledgement,lines:[{itemId:'item',lineTotalPaise:15}]},error:null});
    await expect(pushSyncedSale(input)).rejects.toThrow(/invalid synced-sale result/);
  });
});
