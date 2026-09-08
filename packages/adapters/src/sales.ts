import { getSupabaseClient } from './client';
import { classifyError, errorMessage } from './errors';

export type Customer = {
  id:string; name:string; phone:string|null; address:string|null; gstin:string|null;
  credit_limit_paise:number; notes:string|null;
};
export type SaleLineInput = { itemId:string; unitLevel:1|2|3; qty:number; priceKind:'retail'|'wholesale'; discountPaise?:number };
export type SalePaymentInput = { amountPaise:number; mode:'cash'|'upi'|'card'|'bank'|'other'; reference?:string };
export type SaleInvoice = {
  id:string; customer_id:string|null; doc_no:string; business_date:string; status:'DRAFT'|'FINALIZED'|'VOID';
  subtotal_paise:number; discount_paise:number; extra_charges_paise:number; total_paise:number; notes:string|null; created_at:string;
};
export type CustomerBalance = { customer_id:string; balance_paise:number };
export type PaymentAllocationInput = { saleInvoiceId:string; amountPaise:number };
export type CustomerLedgerRow = { customer_id:string; business_date:string; created_at:string; entry_type:'SALE'|'PAYMENT'; ref_id:string; reference:string|null; debit_paise:number; credit_paise:number };
export type SaleReceiptLine = { item_name_snapshot:string; unit_name_snapshot:string; qty:number; unit_price_paise:number; discount_paise:number; line_total_paise:number };
export type SaleReceiptPayment = { id:string; amount_paise:number; mode:SalePaymentInput['mode']; reference:string|null; status:'POSTED'|'VOID' };
export type SaleReceipt = { invoice:SaleInvoice; lines:SaleReceiptLine[]; payments:SaleReceiptPayment[] };

const friendly=(error:unknown)=>errorMessage(classifyError(error),error);
function must<T>(value:T|null,error:unknown):T { if(error) throw new Error(friendly(error)); if(value===null) throw new Error('Expected data was not returned.'); return value; }

export async function listCustomers():Promise<Customer[]> {
  const {data,error}=await getSupabaseClient().from('customers').select('id,name,phone,address,gstin,credit_limit_paise,notes').order('name');
  if(error) throw new Error(friendly(error)); return (data??[]) as Customer[];
}

export async function createCustomer(input:{tenantId:string;name:string;phone?:string;address?:string;gstin?:string;creditLimitPaise?:number;notes?:string;clientId:string}):Promise<Customer>{
  const {data,error}=await getSupabaseClient().from('customers').insert({
    tenant_id:input.tenantId,name:input.name.trim(),phone:input.phone?.trim()||null,address:input.address?.trim()||null,
    gstin:input.gstin?.trim()||null,credit_limit_paise:input.creditLimitPaise??0,notes:input.notes?.trim()||null,client_id:input.clientId,
  }).select('id,name,phone,address,gstin,credit_limit_paise,notes').single();
  return must(data,error) as Customer;
}

export async function postSale(input:{shopId:string;customerId?:string;businessDate:string;discountPaise?:number;extraChargesPaise?:number;clientId:string;lines:SaleLineInput[];payments?:SalePaymentInput[];notes?:string}):Promise<string>{
  const {data,error}=await getSupabaseClient().rpc('post_sale',{
    p_shop_id:input.shopId,p_customer_id:input.customerId??null,p_business_date:input.businessDate,
    p_discount_paise:input.discountPaise??0,p_extra_charges_paise:input.extraChargesPaise??0,p_client_id:input.clientId,
    p_lines:input.lines.map(l=>({item_id:l.itemId,unit_level:l.unitLevel,qty:l.qty,price_kind:l.priceKind,discount_paise:l.discountPaise??0})),
    p_payments:(input.payments??[]).map(p=>({amount_paise:p.amountPaise,mode:p.mode,reference:p.reference??null})),p_notes:input.notes??null,
  });
  return must(data,error) as string;
}

export async function voidSale(saleId:string,clientId:string):Promise<string>{
  const {data,error}=await getSupabaseClient().rpc('void_sale',{p_sale_invoice_id:saleId,p_client_id:clientId});
  return must(data,error) as string;
}

export async function recordCustomerPayment(input:{shopId:string;customerId:string;businessDate:string;amountPaise:number;mode:SalePaymentInput['mode'];reference?:string;allocations?:PaymentAllocationInput[];clientId:string}):Promise<string>{
  const {data,error}=await getSupabaseClient().rpc('record_customer_payment',{
    p_shop_id:input.shopId,p_customer_id:input.customerId,p_business_date:input.businessDate,p_amount_paise:input.amountPaise,
    p_mode:input.mode,p_reference:input.reference??null,p_allocations:(input.allocations??[]).map(a=>({sale_invoice_id:a.saleInvoiceId,amount_paise:a.amountPaise})),p_client_id:input.clientId,
  });
  return must(data,error) as string;
}

export async function voidPayment(paymentId:string):Promise<string>{
  const {data,error}=await getSupabaseClient().rpc('void_payment',{p_payment_id:paymentId});
  return must(data,error) as string;
}

export async function listRecentSales(shopId:string,limit=50):Promise<SaleInvoice[]> {
  const {data,error}=await getSupabaseClient().from('sale_invoices').select('id,customer_id,doc_no,business_date,status,subtotal_paise,discount_paise,extra_charges_paise,total_paise,notes,created_at').eq('shop_id',shopId).order('created_at',{ascending:false}).limit(limit);
  if(error) throw new Error(friendly(error)); return (data??[]) as SaleInvoice[];
}

export async function listCustomerBalances():Promise<CustomerBalance[]> {
  const {data,error}=await getSupabaseClient().from('customer_balances').select('customer_id,balance_paise');
  if(error) throw new Error(friendly(error)); return (data??[]) as CustomerBalance[];
}

export async function listCustomerLedger(customerId:string):Promise<CustomerLedgerRow[]> {
  const {data,error}=await getSupabaseClient().from('customer_ledger').select('customer_id,business_date,created_at,entry_type,ref_id,reference,debit_paise,credit_paise').eq('customer_id',customerId).order('created_at',{ascending:false});
  if(error) throw new Error(friendly(error)); return (data??[]) as CustomerLedgerRow[];
}

export async function listOpenCustomerSales(customerId:string):Promise<SaleInvoice[]> {
  const {data,error}=await getSupabaseClient().from('sale_invoices').select('id,customer_id,doc_no,business_date,status,subtotal_paise,discount_paise,extra_charges_paise,total_paise,notes,created_at').eq('customer_id',customerId).eq('status','FINALIZED').order('business_date',{ascending:true});
  if(error) throw new Error(friendly(error)); return (data??[]) as SaleInvoice[];
}

export async function getSaleReceipt(saleId:string):Promise<SaleReceipt>{
  const client=getSupabaseClient();
  const [invoiceResult,lineResult,paymentResult]=await Promise.all([
    client.from('sale_invoices').select('id,customer_id,doc_no,business_date,status,subtotal_paise,discount_paise,extra_charges_paise,total_paise,notes,created_at').eq('id',saleId).single(),
    client.from('sale_invoice_items').select('item_name_snapshot,unit_name_snapshot,qty,unit_price_paise,discount_paise,line_total_paise').eq('sale_invoice_id',saleId).order('line_no'),
    client.from('payments').select('id,amount_paise,mode,reference,status').eq('source_sale_invoice_id',saleId).order('created_at'),
  ]);
  const invoice=must(invoiceResult.data,invoiceResult.error) as SaleInvoice;
  if(lineResult.error) throw new Error(friendly(lineResult.error));
  if(paymentResult.error) throw new Error(friendly(paymentResult.error));
  return {invoice,lines:(lineResult.data??[]) as SaleReceiptLine[],payments:(paymentResult.data??[]) as SaleReceiptPayment[]};
}
