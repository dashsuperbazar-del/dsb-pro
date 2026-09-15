import {beforeEach,describe,expect,it,vi} from 'vitest';
import {pullReturnSources,pushSyncedReturn} from './returns';
const {rpc}=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('./client',()=>({getSupabaseClient:()=>({rpc})}));
const input={type:'SALE' as const,sourceId:'sale',shopId:'shop',businessDate:'2026-09-15',clientId:'return-intent',lines:[{sourceLineId:'line',qty:1,disposition:'RETURN_TO_SELLABLE' as const}]};
const source={return_type:'SALE',id:'sale',shop_id:'shop',posted_return_client_ids:[],lines:[{id:'line',item_id:'item',qty:2,base_qty:2,returned_qty:0}]};
const confirmation={returnId:'return',docNo:'SR-1',status:'POSTED',totalPaise:100,cashRefundPaise:60,balanceCreditPaise:40,stock:[{shop_id:'shop',item_id:'item',updated_at:1,available:2,on_hand:2,reserved:0,qty_base:2}]};
beforeEach(()=>rpc.mockReset());
describe('return sync adapter',()=>{
  it('sends only the intent, never an offline refund split',async()=>{
    rpc.mockResolvedValue({data:confirmation,error:null});
    await expect(pushSyncedReturn({...input,deviceId:'device'})).resolves.toEqual(confirmation);
    expect(rpc).toHaveBeenCalledWith('phase65_sync_post_return',{
      p_device_id:'device',p_schema_version:1,p_return_type:'SALE',p_source_id:'sale',p_business_date:'2026-09-15',p_client_id:'return-intent',p_notes:null,
      p_lines:[{sale_invoice_item_id:'line',qty:1,disposition:'RETURN_TO_SELLABLE'}],
    });
  });
  it('preserves database rejection text so the outbox can reverse its projection',async()=>{
    rpc.mockResolvedValue({data:null,error:{message:'sale return quantity exceeds sold quantity'}});
    await expect(pushSyncedReturn({...input,deviceId:'device'})).rejects.toThrow('sale return quantity exceeds sold quantity');
  });
  it.each([
    {...confirmation,cashRefundPaise:-1},
    {...confirmation,balanceCreditPaise:0.1},
    {...confirmation,stock:[{...confirmation.stock[0],shop_id:'other-shop'}]},
    {...confirmation,stock:[{...confirmation.stock[0],available:NaN}]},
  ])('rejects malformed confirmation without acknowledging unknown outcome',async data=>{
    rpc.mockResolvedValue({data,error:null});
    await expect(pushSyncedReturn({...input,deviceId:'device'})).rejects.toThrow('Malformed return confirmation');
  });
  it('accepts scoped source snapshots without payment ledgers',async()=>{
    rpc.mockResolvedValue({data:{sources:[source]},error:null});
    await expect(pullReturnSources({deviceId:'device',shopId:'shop'})).resolves.toEqual([source]);
  });
  it.each([{...source,shop_id:'other-shop'},{...source,lines:[{...source.lines[0],qty:NaN}]}])('refuses malformed/cross-shop source replacement',async row=>{
    rpc.mockResolvedValue({data:{sources:[row]},error:null});
    await expect(pullReturnSources({deviceId:'device',shopId:'shop'})).rejects.toThrow('Invalid return source rows');
  });
});
