import {describe,expect,it} from 'vitest';
import {SYNC_PULL_LIMITS,syncPullMayHaveMore,type SyncPullWire} from './sync';

function pull(overrides:Partial<Record<'items'|'barcodes'|'prices'|'customers'|'stock',number>>={}):SyncPullWire{
  const rows=(n:number)=>Array.from({length:n},()=>({}));
  return {
    schemaVersion:1,serverNowMs:2,cutoffMs:1,businessDate:'2026-09-10',
    policy:{allowCashierOfflineFinalization:false},
    items:rows(overrides.items??0),
    barcodes:rows(overrides.barcodes??0),
    prices:rows(overrides.prices??0),
    customers:rows(overrides.customers??0),
    stock:rows(overrides.stock??0),
  };
}

describe('syncPullMayHaveMore',()=>{
  it('stops only when every collection is below its server page limit',()=>{
    expect(syncPullMayHaveMore(pull({
      items:SYNC_PULL_LIMITS.items-1,
      barcodes:SYNC_PULL_LIMITS.barcodes-1,
      prices:SYNC_PULL_LIMITS.prices-1,
      customers:SYNC_PULL_LIMITS.customers-1,
      stock:SYNC_PULL_LIMITS.stock-1,
    }))).toBe(false);
  });

  it.each([
    ['items',SYNC_PULL_LIMITS.items],
    ['barcodes',SYNC_PULL_LIMITS.barcodes],
    ['prices',SYNC_PULL_LIMITS.prices],
    ['customers',SYNC_PULL_LIMITS.customers],
    ['stock',SYNC_PULL_LIMITS.stock],
  ] as const)('continues when %s fills its page limit',(key,limit)=>{
    expect(syncPullMayHaveMore(pull({[key]:limit}))).toBe(true);
  });

  it('continues for the first 5,000-item page of a 10,000-item fresh sync',()=>{
    expect(syncPullMayHaveMore(pull({items:5000}))).toBe(true);
  });
});
