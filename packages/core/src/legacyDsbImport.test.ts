import { describe, expect, it } from 'vitest';
import { buildLegacyDsbImportPlan } from './legacyDsbImport';

const base = {
  version:3, exportedAt:'2026-09-08T17:07:18.601Z',
  parties:[{id:'P1',name:'Supplier',phone:'123'}],
  customers:[{id:'C0',name:'Walk-in Customer'},{id:'C1',name:'Santosh',creditLimit:50}],
};

describe('legacy DSB import plan',()=>{
  it('preserves three-tier units, sale-price semantics and smallest-unit opening stock',()=>{
    const plan=buildLegacyDsbImportPlan({...base,items:[{
      id:'I1',name:'Biscuit',unit1:'Ctn',unit2:'Pkt',unit3:'Pcs',conv1:12,conv2:12,
      priceUnit:'3',retail:5,wholesaleQty:12,wholesaleSale:54,stock:2,gst:5,
    }]});
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({unit1:'Ctn',unit2:'Pkt',unit3:'Pcs',conv1:12,conv2:12,taxRateBp:500,openingStockSmallest:288});
    expect(plan.items[0].prices).toEqual(expect.arrayContaining([
      {kind:'retail',unitLevel:3,pricePaise:500},
      {kind:'wholesale',unitLevel:3,pricePaise:450},
      {kind:'retail',unitLevel:2,pricePaise:6000},
      {kind:'retail',unitLevel:1,pricePaise:72000},
    ]));
  });

  it('uses retail fallback for wholesale when legacy wholesale-sale is absent',()=>{
    const plan=buildLegacyDsbImportPlan({...base,items:[{id:'I1',name:'Soap',unit1:'Pcs',unit2:'',unit3:'',conv1:1,conv2:1,retail:40,wholesaleSale:0,stock:3}]});
    expect(plan.items[0].prices).toEqual([
      {kind:'retail',unitLevel:1,pricePaise:4000},
      {kind:'wholesale',unitLevel:1,pricePaise:4000},
    ]);
  });

  it('skips malformed items, clamps negative stock, and never imports walk-in as a customer',()=>{
    const plan=buildLegacyDsbImportPlan({...base,items:[
      {id:'bad',name:'No unit',unit1:'',unit2:'Pkt',conv1:10,stock:4},
      {id:'ok',name:'Parle',unit1:'Ctn',unit2:'Pkt',conv1:6,conv2:1,retail:10,stock:-1},
    ]});
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].openingStockSmallest).toBe(0);
    expect(plan.customers.map(c=>c.name)).toEqual(['Santosh']);
    expect(plan.warnings.some(w=>w.includes('base unit is missing'))).toBe(true);
    expect(plan.warnings.some(w=>w.includes('negative'))).toBe(true);
  });

  it('rejects unsupported or structurally invalid backups',()=>{
    expect(()=>buildLegacyDsbImportPlan(null)).toThrow(/JSON object/);
    expect(()=>buildLegacyDsbImportPlan({version:2,exportedAt:'2026-01-01T00:00:00Z',items:[{}]})).toThrow(/Unsupported/);
    expect(()=>buildLegacyDsbImportPlan({version:3,exportedAt:'bad',items:[{}]})).toThrow(/exportedAt/);
    expect(()=>buildLegacyDsbImportPlan({version:3,exportedAt:'2026-01-01T00:00:00Z',items:[]})).toThrow(/no item master/);
  });
});
