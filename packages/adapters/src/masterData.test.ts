import { describe,expect,it,vi } from 'vitest';
import { collectPaginatedRows } from './masterData';

describe('collectPaginatedRows',()=>{
  it('loads all 10,000 rows instead of stopping at the API response cap',async()=>{
    const source=Array.from({length:10_000},(_,i)=>i);
    const readPage=vi.fn(async(from:number,to:number)=>source.slice(from,to+1));

    const rows=await collectPaginatedRows(readPage,1000);

    expect(rows).toEqual(source);
    expect(readPage).toHaveBeenCalledTimes(11);
    expect(readPage).toHaveBeenLastCalledWith(10_000,10_999);
  });

  it('rejects an invalid page size instead of looping forever',async()=>{
    await expect(collectPaginatedRows(async()=>[],0)).rejects.toThrow('Page size must be a positive integer.');
  });
});
