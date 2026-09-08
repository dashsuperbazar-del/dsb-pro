import { describe,expect,it } from 'vitest';
import { compareLegacyDsbDayToPro, summarizeLegacyDsbDayBackup } from './legacyDsbReconciliation';

const backup={
  version:3,
  exportedAt:'2026-09-08T17:07:18.601Z',
  saleInvoices:[
    {id:'I1',date:'2026-09-08',paymentType:'cash',grandTotal:2200},
    {id:'I2',date:'2026-09-08',paymentType:'upi',grandTotal:300},
    {id:'I3',date:'2026-09-08',paymentType:'credit',grandTotal:500},
    {id:'I4',date:'2026-09-08',paymentType:'cheque',grandTotal:700},
    {id:'old',date:'2026-09-07',paymentType:'cash',grandTotal:999},
  ],
  salePayments:[
    {id:'P1',date:'2026-09-08',amount:150,mode:'cash'},
    {id:'P2',date:'2026-09-08',amount:50,mode:'upi'},
    {id:'P3',date:'2026-09-08',amount:25,mode:'bank'},
    {id:'oldp',date:'2026-09-07',amount:500,mode:'cash'},
  ],
};

describe('legacy DSB day reconciliation',()=>{
  it('reproduces old DSB day totals and maps cheque to bank',()=>{
    const s=summarizeLegacyDsbDayBackup(backup,'2026-09-08');
    expect(s).toMatchObject({
      invoiceCount:4,
      salesTotalPaise:370000,
      directSaleReceiptsPaise:320000,
      creditCreatedPaise:50000,
      standaloneCustomerReceiptsPaise:22500,
      allCustomerReceiptsPaise:342500,
      paymentModes:{cashPaise:235000,upiPaise:35000,cardPaise:0,bankPaise:72500,otherPaise:0},
      returnCreditPaise:0,
    });
  });

  it('matches an equivalent DSB Pro server report exactly',()=>{
    const result=compareLegacyDsbDayToPro(backup,'2026-09-08',{
      invoiceCount:4,salesTotalPaise:370000,directSaleReceiptsPaise:320000,creditCreatedPaise:50000,
      standaloneCustomerReceiptsPaise:22500,allCustomerReceiptsPaise:342500,
      paymentModes:{cash:235000,upi:35000,card:0,bank:72500,other:0},
    });
    expect(result.exactMatch).toBe(true);
    expect(result.rows.every(r=>r.match)).toBe(true);
  });

  it('pinpoints mismatched totals rather than collapsing to one verdict',()=>{
    const result=compareLegacyDsbDayToPro(backup,'2026-09-08',{
      invoiceCount:4,salesTotalPaise:369900,directSaleReceiptsPaise:320000,creditCreatedPaise:50000,
      standaloneCustomerReceiptsPaise:22500,allCustomerReceiptsPaise:342500,
      paymentModes:{cash:235000,upi:35000,card:0,bank:72500,other:0},
    });
    expect(result.exactMatch).toBe(false);
    expect(result.rows.filter(r=>!r.match).map(r=>r.key)).toEqual(['salesTotal']);
  });

  it('forces manual review for legacy sale returns',()=>{
    const result=compareLegacyDsbDayToPro({...backup,salePayments:[...backup.salePayments,{id:'RET1',date:'2026-09-08',amount:100,mode:'return'}]},'2026-09-08',{
      invoiceCount:4,salesTotalPaise:370000,directSaleReceiptsPaise:320000,creditCreatedPaise:50000,
      standaloneCustomerReceiptsPaise:22500,allCustomerReceiptsPaise:342500,
      paymentModes:{cash:235000,upi:35000,card:0,bank:72500,other:0},
    });
    expect(result.manualReviewRequired).toBe(true);
    expect(result.exactMatch).toBe(false);
    expect(result.legacy.returnCreditPaise).toBe(10000);
  });

  it('rejects stale schema shapes instead of guessing',()=>{
    expect(()=>summarizeLegacyDsbDayBackup(null,'2026-09-08')).toThrow(/JSON object/);
    expect(()=>summarizeLegacyDsbDayBackup({version:2,exportedAt:'2026-09-08T00:00:00Z'},'2026-09-08')).toThrow(/Unsupported/);
    expect(()=>summarizeLegacyDsbDayBackup({version:3,exportedAt:'bad'},'2026-09-08')).toThrow(/exportedAt/);
    expect(()=>summarizeLegacyDsbDayBackup({version:3,exportedAt:'2026-09-08T00:00:00Z'},'08-09-2026')).toThrow(/YYYY-MM-DD/);
  });
});
