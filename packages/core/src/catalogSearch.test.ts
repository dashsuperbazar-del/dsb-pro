import { describe,expect,it } from 'vitest';
import { searchCatalogItems } from './catalogSearch';

describe('searchCatalogItems',()=>{
  it('prefers prefix matches and caps rendered results',()=>{
    const items=[
      {id:'1',name:'Rice Premium',sku:'R1'},
      {id:'2',name:'Brown Rice',sku:'BR'},
      {id:'3',name:'Rice Bran',sku:'R2'},
    ];
    expect(searchCatalogItems(items,'rice',2).map(x=>x.id)).toEqual(['1','3']);
  });
  it('handles a 10k catalog well below the 300ms billing-search gate',()=>{
    const items=Array.from({length:10_000},(_,i)=>({id:String(i),name:`Item ${String(i).padStart(5,'0')}`,sku:`SKU-${i}`}));
    const start=performance.now();
    const out=searchCatalogItems(items,'9999',50);
    const elapsed=performance.now()-start;
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(elapsed).toBeLessThan(300);
  });
});
