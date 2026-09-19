import { getSupabaseClient } from './client';
import { classifyError, errorMessage } from './errors';
function fail(error:unknown){ throw new Error(errorMessage(classifyError(error),error)); }
export type DayBookRow={business_date:string;sales_paise:number;purchases_paise:number;receipts_paise:number;payments_paise:number;expenses_paise:number;net_cashflow_paise:number};
export type StockValueRow={item_id:string;item_name:string;qty_base:number;cost_paise:number;value_paise:number};
export type GstRow={tax_rate_bp:number;taxable_sales_paise:number;gross_sales_paise:number;taxable_purchases_paise:number;gross_purchases_paise:number};
export async function getDayBook(shopId:string,from:string,to:string){const {data,error}=await getSupabaseClient().rpc('get_day_book',{p_shop_id:shopId,p_from:from,p_to:to});if(error)fail(error);return (data??[]) as DayBookRow[];}
export async function getStockValuation(shopId:string){const {data,error}=await getSupabaseClient().rpc('get_stock_valuation',{p_shop_id:shopId});if(error)fail(error);return (data??[]) as StockValueRow[];}
export async function getGstSummary(shopId:string,from:string,to:string){const {data,error}=await getSupabaseClient().rpc('get_gst_summary',{p_shop_id:shopId,p_from:from,p_to:to});if(error)fail(error);return (data??[]) as GstRow[];}
export async function postExpense(shopId:string,businessDate:string,category:string,description:string,amountPaise:number,mode:string,reference:string|null,clientId:string){const {data,error}=await getSupabaseClient().rpc('post_expense',{p_shop_id:shopId,p_business_date:businessDate,p_category:category,p_description:description,p_amount_paise:amountPaise,p_mode:mode,p_reference:reference,p_client_id:clientId});if(error)fail(error);return data as string;}
export async function exportTenant(shopId:string){const {data,error}=await getSupabaseClient().rpc('phase6_export_tenant',{p_shop_id:shopId});if(error)fail(error);return data as Record<string,unknown>;}
export type InvariantHealth={ok:boolean;saleTotalViolations:number;purchaseTotalViolations:number;negativeStock:number;allocationViolations:number;stockProjectionViolations:number;voidReversalViolations:number};
export async function checkInvariants(){const {data,error}=await getSupabaseClient().rpc('check_invariants');if(error)fail(error);return data as InvariantHealth;}

export type PartyLedgerRow={business_date:string;entry_type:string;document:string;debit_paise:number;credit_paise:number;running_balance_paise:number};
export async function getPartyLedger(partyId:string,from:string,to:string){const {data,error}=await getSupabaseClient().rpc('get_party_ledger',{p_party_id:partyId,p_from:from,p_to:to});if(error)fail(error);return (data??[]) as PartyLedgerRow[];}
export async function createStockCount(shopId:string,businessDate:string,lines:{item_id:string;counted_qty:number;reason?:string}[],notes:string,clientId:string){const {data,error}=await getSupabaseClient().rpc('create_stock_count',{p_shop_id:shopId,p_business_date:businessDate,p_lines:lines,p_notes:notes,p_client_id:clientId});if(error)fail(error);return data as string;}
export async function postStockCount(stockCountId:string){const {error}=await getSupabaseClient().rpc('post_stock_count',{p_stock_count_id:stockCountId});if(error)fail(error);}
export async function voidExpense(expenseId:string){const {error}=await getSupabaseClient().rpc('void_expense',{p_expense_id:expenseId});if(error)fail(error);}

export type LowStockRow={item_id:string;item_name:string;unit_name:string;on_hand:number;min_stock:number;shortfall:number};
export async function getLowStockReport(shopId:string){const {data,error}=await getSupabaseClient().rpc('get_low_stock_report',{p_shop_id:shopId});if(error)fail(error);return (data??[]) as LowStockRow[];}

export type ItemSalesRow={item_id:string;item_name:string;qty_sold:number;qty_returned:number;net_qty:number;gross_sales_paise:number;net_sales_paise:number};
export async function getItemSalesReport(shopId:string,from:string,to:string){const {data,error}=await getSupabaseClient().rpc('get_item_sales_report',{p_shop_id:shopId,p_from:from,p_to:to});if(error)fail(error);return (data??[]) as ItemSalesRow[];}

export type PurchaseRegisterRow={bill_id:string;doc_no:string;business_date:string;party_name:string|null;subtotal_paise:number;discount_paise:number;extra_charges_paise:number;total_paise:number;status:'POSTED'|'VOID'};
export async function getPurchaseRegister(shopId:string,from:string,to:string){const {data,error}=await getSupabaseClient().rpc('get_purchase_register',{p_shop_id:shopId,p_from:from,p_to:to});if(error)fail(error);return (data??[]) as PurchaseRegisterRow[];}

export type CustomerAgingRow={customer_id:string;customer_name:string;not_due_paise:number;days_1_30_paise:number;days_31_60_paise:number;days_61_90_paise:number;days_90_plus_paise:number;total_outstanding_paise:number};
export async function getCustomerAgingReport(shopId:string,asOf:string){const {data,error}=await getSupabaseClient().rpc('get_customer_aging_report',{p_shop_id:shopId,p_as_of:asOf});if(error)fail(error);return (data??[]) as CustomerAgingRow[];}
