import {describe,expect,it} from 'vitest';
import {SYNC_PULL_LIMITS,isolateSyncPullCursors,syncPullMayHaveMore,type SyncPullWire} from './sync';

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

  it('continues after a full 1,000-item streaming page so larger catalogs are not truncated',()=>{
    expect(syncPullMayHaveMore(pull({items:1000}))).toBe(true);
  });

  it('isolates parallel table pulls without losing the selected cursor',()=>{
    const cursors={items:{updatedAt:42,id:'item-42'},stock:{updatedAt:7,id:'stock-7'}};
    const isolated=isolateSyncPullCursors('items',cursors);
    expect(isolated.items).toEqual(cursors.items);
    expect(isolated.stock.updatedAt).toBe(Number.MAX_SAFE_INTEGER);
    expect(isolated.prices.updatedAt).toBe(Number.MAX_SAFE_INTEGER);
  });
});
