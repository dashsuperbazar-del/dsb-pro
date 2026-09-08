import { getSupabaseClient } from './client';
import { classifyError, errorMessage } from './errors';

export type CustomerOutstandingInvoice={
  sale_invoice_id:string; customer_id:string; doc_no:string; business_date:string;
  total_paise:number; allocated_paise:number; outstanding_paise:number;
};

export async function listCustomerOutstandingInvoices(customerId:string):Promise<CustomerOutstandingInvoice[]>{
  const {data,error}=await getSupabaseClient().from('customer_invoice_outstanding')
    .select('sale_invoice_id,customer_id,doc_no,business_date,total_paise,allocated_paise,outstanding_paise')
    .eq('customer_id',customerId).order('business_date',{ascending:true});
  if(error) throw new Error(errorMessage(classifyError(error),error));
  return (data??[]) as CustomerOutstandingInvoice[];
}
