import {describe,expect,it} from 'vitest';
import {
  advanceCursor,compareCursor,isRowAfterCursor,markOutboxRetry,markOutboxSending,
  mergeMasterRow,nextOutboxEntry,provisionalDocNo,reconcileAppendOnlyEvent,retryDelayMs,
  type MasterSyncRow,type OutboxEntry,
} from './index';

describe('sync cursor',()=>{
  it('uses updated_at plus id so equal timestamps cannot skip rows',()=>{
    const a={updatedAt:100,id:'a'};
    const b={updatedAt:100,id:'b'};
    expect(compareCursor(a,b)).toBeLessThan(0);
    expect(isRowAfterCursor({id:'b',updated_at:100},a)).toBe(true);
    expect(isRowAfterCursor({id:'a',updated_at:100},a)).toBe(false);
  });

  it('advances only to the greatest composite cursor',()=>{
    expect(advanceCursor({updatedAt:100,id:'b'},[
      {id:'z',updated_at:99},
      {id:'c',updated_at:100},
      {id:'a',updated_at:101},
    ])).toEqual({updatedAt:101,id:'a'});
  });
});

describe('master-data LWW and tombstones',()=>{
  const live=(updated:number,name:string):MasterSyncRow<{name:string}>=>({
    id:'item-1',updated_at:updated,deleted_at:null,data:{name},
  });
  const deleted=(updated:number):MasterSyncRow<{name:string}>=>({
    id:'item-1',updated_at:updated,deleted_at:updated,data:{name:'old'},
  });

  it('takes a newer server master row without field-wise union',()=>{
    const result=mergeMasterRow(live(10,'local'),live(11,'remote'));
    expect(result).toMatchObject({source:'remote',deleted:false,record:{data:{name:'remote'}}});
  });

  it('makes tombstones sticky so a later live snapshot cannot resurrect a delete',()=>{
    const result=mergeMasterRow(deleted(20),live(30,'stale-or-invalid-resurrection'));
    expect(result.source).toBe('local');
    expect(result.deleted).toBe(true);
  });

  it('lets a tombstone win an equal-timestamp tie',()=>{
    const result=mergeMasterRow(live(20,'live'),deleted(20));
    expect(result.source).toBe('remote');
    expect(result.deleted).toBe(true);
  });
});

describe('append-only financial events',()=>{
  it('deduplicates an exact client_id retry',()=>{
    const event={id:'sale-1',clientId:'client-1',fingerprint:'sha256:abc'};
    expect(reconcileAppendOnlyEvent(event,event).action).toBe('duplicate');
  });

  it('refuses to overwrite divergent data under the same client_id',()=>{
    const existing={id:'sale-1',clientId:'client-1',fingerprint:'sha256:abc'};
    const incoming={id:'sale-2',clientId:'client-1',fingerprint:'sha256:def'};
    expect(()=>reconcileAppendOnlyEvent(existing,incoming)).toThrow(/append-only collision/);
  });
});

describe('ordered outbox',()=>{
  const entry=(sequence:number,state:OutboxEntry['state']='pending'):OutboxEntry=>({
    sequence,clientId:`c-${sequence}`,kind:'financial-rpc',target:'post_sale',payload:{sequence},
    createdAt:1000+sequence,attempts:0,state,nextAttemptAt:0,lastError:null,
  });

  it('never overtakes an earlier retry that is still backing off',()=>{
    const first={...entry(1,'retry'),nextAttemptAt:5000};
    expect(nextOutboxEntry([entry(2),first],4999)).toBeNull();
    expect(nextOutboxEntry([entry(2),first],5000)?.sequence).toBe(1);
  });

  it('tracks attempts and retry state without changing client identity',()=>{
    const sending=markOutboxSending(entry(1));
    expect(sending).toMatchObject({state:'sending',attempts:1,clientId:'c-1'});
    const retry=markOutboxRetry(sending,'network down',7000);
    expect(retry).toMatchObject({state:'retry',attempts:1,nextAttemptAt:7000,lastError:'network down'});
    expect(retryDelayMs(1)).toBe(1000);
    expect(retryDelayMs(10,1000,60000)).toBe(60000);
  });
});

describe('offline provisional numbering',()=>{
  it('is deterministic and device-separated',()=>{
    expect(provisionalDocNo('device_A',7)).toBe('T-device_A-7');
    expect(provisionalDocNo('device_B',7)).toBe('T-device_B-7');
  });
});
