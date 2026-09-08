import { getSupabaseClient } from './client';
import { classifyError, errorMessage } from './errors';

export type DayReconciliationPaymentModes = {
  cash:number; upi:number; card:number; bank:number; other:number;
};

export type DayReconciliationSoldItem = {
  itemId:string;
  name:string;
  soldQtySmallest:number;
  saleLines:number;
  smallestUnit:string;
  currentStockSmallest:number;
};

export type ShopDayReconciliation = {
  businessDate:string;
  invoiceCount:number;
  salesTotalPaise:number;
  discountPaise:number;
  extraChargesPaise:number;
  voidCount:number;
  voidedTotalPaise:number;
  directSaleReceiptsPaise:number;
  creditCreatedPaise:number;
  standaloneCustomerReceiptsPaise:number;
  standaloneAllocatedPaise:number;
  standaloneAdvancePaise:number;
  allCustomerReceiptsPaise:number;
  paymentModes:DayReconciliationPaymentModes;
  currentCustomerOutstandingPaise:number;
  currentCustomerAdvancePaise:number;
  soldItems:DayReconciliationSoldItem[];
};

const n=(value:unknown)=>Number(value??0);

export async function getShopDayReconciliation(shopId:string,businessDate:string):Promise<ShopDayReconciliation>{
  const {data,error}=await getSupabaseClient().rpc('get_shop_day_reconciliation',{
    p_shop_id:shopId,
    p_business_date:businessDate,
  });
  if(error) throw new Error(errorMessage(classifyError(error),error));
  if(!data || typeof data!=='object' || Array.isArray(data)) throw new Error('Day reconciliation report was not returned.');
  const raw=data as Record<string,unknown>;
  const modes=(raw.paymentModes && typeof raw.paymentModes==='object' && !Array.isArray(raw.paymentModes)
    ? raw.paymentModes : {}) as Record<string,unknown>;
  const sold=Array.isArray(raw.soldItems)?raw.soldItems:[];
  return {
    businessDate:String(raw.businessDate??businessDate),
    invoiceCount:n(raw.invoiceCount),
    salesTotalPaise:n(raw.salesTotalPaise),
    discountPaise:n(raw.discountPaise),
    extraChargesPaise:n(raw.extraChargesPaise),
    voidCount:n(raw.voidCount),
    voidedTotalPaise:n(raw.voidedTotalPaise),
    directSaleReceiptsPaise:n(raw.directSaleReceiptsPaise),
    creditCreatedPaise:n(raw.creditCreatedPaise),
    standaloneCustomerReceiptsPaise:n(raw.standaloneCustomerReceiptsPaise),
    standaloneAllocatedPaise:n(raw.standaloneAllocatedPaise),
    standaloneAdvancePaise:n(raw.standaloneAdvancePaise),
    allCustomerReceiptsPaise:n(raw.allCustomerReceiptsPaise),
    paymentModes:{cash:n(modes.cash),upi:n(modes.upi),card:n(modes.card),bank:n(modes.bank),other:n(modes.other)},
    currentCustomerOutstandingPaise:n(raw.currentCustomerOutstandingPaise),
    currentCustomerAdvancePaise:n(raw.currentCustomerAdvancePaise),
    soldItems:sold.flatMap(value=>{
      if(!value || typeof value!=='object' || Array.isArray(value))return[];
      const row=value as Record<string,unknown>;
      return [{
        itemId:String(row.itemId??''),
        name:String(row.name??''),
        soldQtySmallest:n(row.soldQtySmallest),
        saleLines:n(row.saleLines),
        smallestUnit:String(row.smallestUnit??''),
        currentStockSmallest:n(row.currentStockSmallest),
      }];
    }),
  };
}
