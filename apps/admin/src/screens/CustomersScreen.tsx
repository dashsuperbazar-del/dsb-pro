import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  createCustomer, getCurrentMembership, getDefaultShopId, getShopBusinessDate, listCustomerBalances,
  listCustomerLedger, listCustomerOutstandingInvoices, listCustomers, recordCustomerPayment, voidPayment,
  type Customer, type CustomerLedgerRow, type CustomerOutstandingInvoice,
} from '@dsb-pro/adapters';
import { appRoute } from '../lib/paths';

const money=(paise:number)=>`₹${(paise/100).toFixed(2)}`;
const toPaise=(rupees:string)=>Math.round(Number(rupees||'0')*100);

type AllocationDraft={saleId:string;docNo:string;checked:boolean;amount:string};

export function CustomersScreen(){
  const [customers,setCustomers]=useState<Customer[]>([]); const [balances,setBalances]=useState<Record<string,number>>({});
  const [selected,setSelected]=useState(''); const [ledger,setLedger]=useState<CustomerLedgerRow[]>([]); const [openSales,setOpenSales]=useState<CustomerOutstandingInvoice[]>([]);
  const [allocations,setAllocations]=useState<AllocationDraft[]>([]); const [tenantId,setTenantId]=useState(''); const [shopId,setShopId]=useState(''); const [businessDate,setBusinessDate]=useState('');
  const [amount,setAmount]=useState(''); const [mode,setMode]=useState<'cash'|'upi'|'card'|'bank'|'other'>('cash'); const [reference,setReference]=useState(''); const [error,setError]=useState(''); const [message,setMessage]=useState(''); const [busy,setBusy]=useState(false);

  async function refreshBase(){
    const membership=await getCurrentMembership(); if(!membership) throw new Error('No tenant membership.');
    const shop=await getDefaultShopId(); const [c,b,d]=await Promise.all([listCustomers(),listCustomerBalances(),getShopBusinessDate(shop)]);
    setTenantId(membership.tenantId); setShopId(shop); setCustomers(c); setBalances(Object.fromEntries(b.map(x=>[x.customer_id,x.balance_paise]))); setBusinessDate(d);
  }
  async function refreshCustomer(customerId=selected){
    if(!customerId){setLedger([]);setOpenSales([]);setAllocations([]);return;}
    const [l,s]=await Promise.all([listCustomerLedger(customerId),listCustomerOutstandingInvoices(customerId)]); setLedger(l); setOpenSales(s);
    setAllocations(s.map(x=>({saleId:x.sale_invoice_id,docNo:x.doc_no,checked:false,amount:''})));
  }
  useEffect(()=>{void refreshBase().catch(e=>setError(String(e)));},[]);
  useEffect(()=>{void refreshCustomer(selected).catch(e=>setError(String(e)));},[selected]);
  const allocated=useMemo(()=>allocations.filter(a=>a.checked).reduce((sum,a)=>sum+toPaise(a.amount),0),[allocations]);

  async function addCustomer(ev:Event){ev.preventDefault();setError('');const f=new FormData(ev.currentTarget as HTMLFormElement);try{
    const c=await createCustomer({tenantId,name:String(f.get('name')),phone:String(f.get('phone')||'')||undefined,address:String(f.get('address')||'')||undefined,clientId:crypto.randomUUID()});
    await refreshBase(); setSelected(c.id); setMessage(`Customer ${c.name} created.`); (ev.currentTarget as HTMLFormElement).reset();
  }catch(e){setError(String(e));}}

  async function receive(ev:Event){ev.preventDefault();if(!selected)return;setBusy(true);setError('');try{
    const paymentPaise=toPaise(amount); if(paymentPaise<=0) throw new Error('Payment must be greater than zero.'); if(allocated>paymentPaise) throw new Error('Selected allocations exceed the payment amount.');
    for(const draft of allocations.filter(a=>a.checked)){
      const invoice=openSales.find(s=>s.sale_invoice_id===draft.saleId); if(invoice&&toPaise(draft.amount)>invoice.outstanding_paise) throw new Error(`Allocation for ${draft.docNo} exceeds its outstanding amount.`);
    }
    await recordCustomerPayment({shopId,customerId:selected,businessDate,amountPaise:paymentPaise,mode,reference:reference||undefined,clientId:crypto.randomUUID(),allocations:allocations.filter(a=>a.checked&&toPaise(a.amount)>0).map(a=>({saleInvoiceId:a.saleId,amountPaise:toPaise(a.amount)}))});
    setAmount('');setReference('');setMessage('Payment recorded. Any unallocated remainder is retained as customer advance.');await refreshBase();await refreshCustomer(selected);
  }catch(e){setError(String(e));}finally{setBusy(false);}}

  async function voidLedgerPayment(row:CustomerLedgerRow){if(row.entry_type!=='PAYMENT')return;if(!confirm('Void this payment? The ledger entry will remain in history as a voided financial record.'))return;setBusy(true);setError('');try{
    await voidPayment(row.ref_id);setMessage('Payment voided.');await refreshBase();await refreshCustomer(selected);
  }catch(e){setError(String(e));}finally{setBusy(false);}}

  const customer=customers.find(c=>c.id===selected);
  return <main class="page wide"><p><a href={appRoute.home}>← Home</a></p><h1>Customers & ledger</h1>
    {error&&<p role="alert" class="alert">{error}</p>}{message&&<p role="status" class="success">{message}</p>}
    <section class="card"><h2>Customer master</h2><form onSubmit={addCustomer} class="grid-form"><label>Name<input name="name" required/></label><label>Phone<input name="phone"/></label><label>Address<input name="address"/></label><button>Create customer</button></form>
      <label>Customer<select value={selected} onChange={e=>setSelected((e.currentTarget as HTMLSelectElement).value)}><option value="">Choose…</option>{customers.map(c=><option value={c.id}>{c.name}</option>)}</select></label>
      {customer&&<p><strong>{customer.name}</strong> · Balance {money(balances[customer.id]??0)} <small>(positive = customer owes; negative = advance)</small></p>}
    </section>

    {selected&&<section class="card"><h2>Receive payment / allocate invoices</h2><form onSubmit={receive}>
      <div class="grid-form"><label>Business date<input type="date" value={businessDate} onInput={e=>setBusinessDate((e.currentTarget as HTMLInputElement).value)} required/></label><label>Amount ₹<input type="number" min="0.01" step="0.01" value={amount} onInput={e=>setAmount((e.currentTarget as HTMLInputElement).value)} required/></label><label>Mode<select value={mode} onChange={e=>setMode((e.currentTarget as HTMLSelectElement).value as typeof mode)}><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option><option value="bank">Bank</option><option value="other">Other</option></select></label><label>Reference<input value={reference} onInput={e=>setReference((e.currentTarget as HTMLInputElement).value)}/></label></div>
      <h3>Invoice allocation</h3>{!openSales.length?<p class="muted">No outstanding customer invoices.</p>:<div class="table-wrap"><table><thead><tr><th>Select</th><th>Invoice</th><th>Date</th><th>Total</th><th>Outstanding</th><th>Allocate ₹</th></tr></thead><tbody>{openSales.map(s=>{const a=allocations.find(x=>x.saleId===s.sale_invoice_id);return <tr><td><input aria-label={`Allocate ${s.doc_no}`} type="checkbox" checked={a?.checked??false} onChange={e=>setAllocations(v=>v.map(x=>x.saleId===s.sale_invoice_id?{...x,checked:(e.currentTarget as HTMLInputElement).checked}:x))}/></td><td>{s.doc_no}</td><td>{s.business_date}</td><td>{money(s.total_paise)}</td><td>{money(s.outstanding_paise)}</td><td><input aria-label={`Amount for ${s.doc_no}`} type="number" min="0" max={(s.outstanding_paise/100).toFixed(2)} step="0.01" disabled={!a?.checked} value={a?.amount??''} onInput={e=>setAllocations(v=>v.map(x=>x.saleId===s.sale_invoice_id?{...x,amount:(e.currentTarget as HTMLInputElement).value}:x))}/></td></tr>})}</tbody></table></div>}
      <p>Allocated {money(allocated)} · Unallocated advance {money(Math.max(0,toPaise(amount)-allocated))}</p><button class="primary" disabled={busy}>{busy?'Saving…':'Record payment'}</button>
    </form></section>}

    {selected&&<section class="card"><h2>Customer ledger</h2>{!ledger.length?<p class="muted">No ledger entries.</p>:<div class="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Reference</th><th>Debit</th><th>Credit</th><th/></tr></thead><tbody>{ledger.map(r=><tr><td>{r.business_date}</td><td>{r.entry_type}</td><td>{r.reference}</td><td>{r.debit_paise?money(r.debit_paise):'—'}</td><td>{r.credit_paise?money(r.credit_paise):'—'}</td><td>{r.entry_type==='PAYMENT'&&<button type="button" disabled={busy} onClick={()=>void voidLedgerPayment(r)}>Void payment</button>}</td></tr>)}</tbody></table></div>}</section>}
  </main>;
}
