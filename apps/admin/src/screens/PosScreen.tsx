import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  createCustomer, findItemByBarcode, getShopBusinessDate,
  listCurrentPrices, listCustomerBalances, listCustomers, listItems, listRecentSales, recordCustomerPayment,
  type Customer, type Item, type SaleInvoice,
} from '@dsb-pro/adapters';
import type { OfflineSaleRecord } from '@dsb-pro/sync';
import { appRoute } from '../lib/paths';
import {
  finalizeSaleResilient, findOfflineBarcode, getOfflineBusinessDate, getOfflineCustomers, getOfflineItems,
  getOfflinePrices, getOfflineRuntimeIdentity, listOfflineSales, waitForOfflineRuntime,
} from '../lib/offlineSync';

type CartLine = { item:Item; unitLevel:1|2|3; qty:number; priceKind:'retail'|'wholesale'; unitPricePaise:number; discountPaise:number };
type Tender = { mode:'cash'|'upi'|'card'|'bank'|'other'; amount:string };
const money=(paise:number)=>`₹${(paise/100).toFixed(2)}`;
const paise=(rupees:string)=>Math.round(Number(rupees||'0')*100);

function unitName(item:Item,level:1|2|3){ return level===1?item.unit1:level===2?(item.unit2??item.unit1):(item.unit3??item.unit2??item.unit1); }

export function PosScreen(){
  const [items,setItems]=useState<Item[]>([]); const [customers,setCustomers]=useState<Customer[]>([]); const [sales,setSales]=useState<SaleInvoice[]>([]);
  const [offlineSales,setOfflineSales]=useState<OfflineSaleRecord[]>([]);
  const [balances,setBalances]=useState<Record<string,number>>({}); const [shopId,setShopId]=useState(''); const [tenantId,setTenantId]=useState(''); const [businessDate,setBusinessDate]=useState('');
  const [cart,setCart]=useState<CartLine[]>([]); const [customerId,setCustomerId]=useState(''); const [globalDiscount,setGlobalDiscount]=useState('0'); const [extra,setExtra]=useState('0');
  const [tenders,setTenders]=useState<Tender[]>([{mode:'cash',amount:''}]); const [message,setMessage]=useState(''); const [error,setError]=useState(''); const [busy,setBusy]=useState(false);
  const [barcode,setBarcode]=useState(''); const [manualItemId,setManualItemId]=useState(''); const [manualUnitLevel,setManualUnitLevel]=useState<1|2|3>(1); const [saleClientId,setSaleClientId]=useState(()=>crypto.randomUUID()); const [paymentClientId,setPaymentClientId]=useState(()=>crypto.randomUUID()); const [paymentCustomer,setPaymentCustomer]=useState(''); const [paymentAmount,setPaymentAmount]=useState(''); const [paymentMode,setPaymentMode]=useState<Tender['mode']>('cash');

  async function refresh(){
    await waitForOfflineRuntime();
    const identity=getOfflineRuntimeIdentity(); if(!identity) throw new Error('Offline shop cache is not ready.');
    setTenantId(identity.tenantId); setShopId(identity.shopId);
    try{
      const [i,c,d,s,b]=await Promise.all([listItems(),listCustomers(),getShopBusinessDate(identity.shopId),listRecentSales(identity.shopId,20),listCustomerBalances()]);
      setItems(i); setCustomers(c); setBusinessDate(d); setSales(s); setBalances(Object.fromEntries(b.map(x=>[x.customer_id,x.balance_paise])));
    }catch{
      const [i,c,d]=await Promise.all([getOfflineItems(),getOfflineCustomers(),getOfflineBusinessDate()]);
      setItems(i); setCustomers(c); setBusinessDate(d??new Date().toISOString().slice(0,10)); setSales([]); setBalances({});
    }
    setOfflineSales(await listOfflineSales());
  }
  useEffect(()=>{ void refresh().catch(e=>setError(String(e))); },[]);

  const manualItem=items.find(i=>i.id===manualItemId);
  const preview=useMemo(()=>cart.reduce((sum,l)=>sum+Math.round(l.qty*l.unitPricePaise)-l.discountPaise,0)-paise(globalDiscount)+paise(extra),[cart,globalDiscount,extra]);
  const tenderTotal=useMemo(()=>tenders.reduce((sum,t)=>sum+paise(t.amount),0),[tenders]);

  async function addLine(item:Item,unitLevel:1|2|3,qty:number,priceKind:'retail'|'wholesale',discountPaise=0){
    if(!Number.isFinite(qty)||qty<=0) throw new Error('Quantity must be greater than zero.');
    let prices;
    try{ prices=await listCurrentPrices(item.id); }catch{ prices=await getOfflinePrices(item.id); }
    const matching=prices.filter(p=>p.kind===priceKind&&p.unit_level===unitLevel);
    const chosen=matching.find(p=>p.shop_id===shopId)??matching.find(p=>p.shop_id===null);
    if(!chosen) throw new Error(`No active ${priceKind} price for ${item.name} / ${unitName(item,unitLevel)}.`);
    setCart(v=>[...v,{item,unitLevel,qty,priceKind,unitPricePaise:chosen.price_paise,discountPaise}]);
  }

  async function addManual(ev:Event){ ev.preventDefault(); setError(''); const f=new FormData(ev.currentTarget as HTMLFormElement); const item=items.find(i=>i.id===String(f.get('itemId'))); if(!item)return;
    try{ await addLine(item,manualUnitLevel,Number(f.get('qty')),String(f.get('priceKind')) as 'retail'|'wholesale',paise(String(f.get('lineDiscount')||'0'))); }catch(e){setError(String(e));}
  }

  async function scan(ev:Event){ ev.preventDefault(); setError(''); try{
    let hit; try{ hit=await findItemByBarcode(barcode); }catch{ hit=await findOfflineBarcode(barcode); }
    if(!hit) throw new Error('Barcode not found.'); const item=items.find(i=>i.id===hit.item_id); if(!item) throw new Error('Barcode item is unavailable.');
    await addLine(item,hit.unit_level,1,'retail'); setBarcode('');
  }catch(e){setError(String(e));} }

  async function finalizeSale(){
    if(busy)return; if(!cart.length){setError('Add at least one item.');return;} setBusy(true); setError('');
    try{
      const result=await finalizeSaleResilient({shopId,customerId:customerId||undefined,businessDate,discountPaise:paise(globalDiscount),extraChargesPaise:paise(extra),clientId:saleClientId,
        lines:cart.map(l=>({itemId:l.item.id,unitLevel:l.unitLevel,qty:l.qty,priceKind:l.priceKind,discountPaise:l.discountPaise})),
        payments:tenders.filter(t=>paise(t.amount)>0).map(t=>({amountPaise:paise(t.amount),mode:t.mode})),
      });
      setMessage(result.kind==='synced'?`Sale finalized: ${result.docNo}`:`Saved locally as ${result.provisionalDocNo}. It will sync automatically when the backend is reachable.`);
      setSaleClientId(crypto.randomUUID()); setCart([]); setGlobalDiscount('0'); setExtra('0'); setTenders([{mode:'cash',amount:''}]); await refresh();
    }catch(e){setError(String(e));} finally{setBusy(false);}
  }

  async function addCustomer(ev:Event){ ev.preventDefault(); setError(''); if(!tenantId){setError('Shop data is still loading.');return;} const form=ev.currentTarget as HTMLFormElement; const f=new FormData(form);
    try{ const c=await createCustomer({tenantId,name:String(f.get('name')),phone:String(f.get('phone')||'')||undefined,clientId:crypto.randomUUID()}); setCustomers(v=>[...v,c].sort((a,b)=>a.name.localeCompare(b.name))); setCustomerId(c.id); form.reset(); setMessage(`Customer ${c.name} created.`); }catch(e){setError(String(e));}
  }

  function handlePosKeyDown(ev:KeyboardEvent){ if(ev.ctrlKey&&ev.key==='Enter'){ ev.preventDefault(); void finalizeSale(); } }

  async function receivePayment(ev:Event){ ev.preventDefault(); if(busy||!paymentCustomer)return; setBusy(true); setError('');
    try{ await recordCustomerPayment({shopId,customerId:paymentCustomer,businessDate,amountPaise:paise(paymentAmount),mode:paymentMode,clientId:paymentClientId}); setPaymentClientId(crypto.randomUUID()); setMessage('Customer payment recorded.'); setPaymentAmount(''); await refresh(); }catch(e){setError(String(e));} finally{setBusy(false);}
  }

  return <main class="page wide" onKeyDown={handlePosKeyDown}>
    <p><a href={appRoute.home}>← Home</a> · <a href={appRoute.sync}>Sync & offline</a></p><h1>Sales POS</h1><p class="muted">Billing is written to the durable local outbox first. The server re-resolves permissions, prices and stock before assigning the official invoice number.</p><details class="card" open><summary><strong>Keyboard map</strong></summary><p><kbd>Enter</kbd> submits the focused scan/item form · <kbd>Tab</kbd> moves through billing fields · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> finalizes the current sale.</p></details>
    {error&&<p role="alert" class="alert">{error}</p>}{message&&<p role="status" class="success">{message}</p>}

    <section class="card"><h2>1. Scan or add item</h2>
      <form onSubmit={scan} class="row"><label>Barcode <input autofocus value={barcode} onInput={e=>setBarcode((e.currentTarget as HTMLInputElement).value)} /></label><button>Scan / Add</button></form>
      <form onSubmit={addManual} class="grid-form">
        <label>Item <select name="itemId" required value={manualItemId} onChange={e=>{const id=(e.currentTarget as HTMLSelectElement).value;setManualItemId(id);const item=items.find(i=>i.id===id);setManualUnitLevel(item?.unit3?3:item?.unit2?2:1);}}><option value="">Choose…</option>{items.map(i=><option value={i.id}>{i.name}</option>)}</select></label>
        <label>Unit <select name="unitLevel" value={manualUnitLevel} disabled={!manualItem} onChange={e=>setManualUnitLevel(Number((e.currentTarget as HTMLSelectElement).value) as 1|2|3)}><option value="1">{manualItem?.unit1||'Unit 1'}</option>{manualItem?.unit2&&<option value="2">{manualItem.unit2}</option>}{manualItem?.unit3&&<option value="3">{manualItem.unit3}</option>}</select></label>
        <label>Quantity <input name="qty" type="number" min="0.000001" step="any" value="1" required/></label>
        <label>Price <select name="priceKind"><option value="retail">Retail</option><option value="wholesale">Wholesale</option></select></label>
        <label>Line discount ₹ <input name="lineDiscount" type="number" min="0" step="0.01" value="0"/></label><button>Add line</button>
      </form>
    </section>

    <section class="card"><h2>2. Cart</h2>{!cart.length?<p class="muted">Cart is empty.</p>:<div class="table-wrap"><table><thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Discount</th><th>Total</th><th/></tr></thead><tbody>{cart.map((l,n)=><tr><td>{l.item.name}<small>{unitName(l.item,l.unitLevel)} · {l.priceKind}</small></td><td>{l.qty}</td><td>{money(l.unitPricePaise)}</td><td>{money(l.discountPaise)}</td><td>{money(Math.round(l.qty*l.unitPricePaise)-l.discountPaise)}</td><td><button type="button" onClick={()=>setCart(v=>v.filter((_,i)=>i!==n))}>Remove</button></td></tr>)}</tbody></table></div>}
      <div class="row"><label>Invoice discount ₹ <input value={globalDiscount} type="number" min="0" step="0.01" onInput={e=>setGlobalDiscount((e.currentTarget as HTMLInputElement).value)}/></label><label>Extra charges ₹ <input value={extra} type="number" min="0" step="0.01" onInput={e=>setExtra((e.currentTarget as HTMLInputElement).value)}/></label><strong>Preview {money(Math.max(0,preview))}</strong></div>
    </section>

    <section class="card"><h2>3. Customer & payment</h2>
      <label>Customer <select value={customerId} onChange={e=>setCustomerId((e.currentTarget as HTMLSelectElement).value)}><option value="">Walk-in</option>{customers.map(c=><option value={c.id}>{c.name}{balances[c.id]?` · balance ${money(balances[c.id])}`:''}</option>)}</select></label>
      <form onSubmit={addCustomer} class="row"><label>Quick customer <input name="name" placeholder="Name" required/></label><label>Phone <input name="phone" placeholder="Phone"/></label><button>Create & select</button></form>
      {tenders.map((t,n)=><div class="row"><label>Mode <select value={t.mode} onChange={e=>setTenders(v=>v.map((x,i)=>i===n?{...x,mode:(e.currentTarget as HTMLSelectElement).value as Tender['mode']}:x))}><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option><option value="bank">Bank</option><option value="other">Other</option></select></label><label>Amount ₹ <input value={t.amount} type="number" min="0" step="0.01" onInput={e=>setTenders(v=>v.map((x,i)=>i===n?{...x,amount:(e.currentTarget as HTMLInputElement).value}:x))}/></label>{n>0&&<button type="button" onClick={()=>setTenders(v=>v.filter((_,i)=>i!==n))}>Remove tender</button>}</div>)}
      <div class="row"><button type="button" onClick={()=>setTenders(v=>[...v,{mode:'upi',amount:''}])}>+ Split tender</button><span>Entered {money(tenderTotal)}</span><button class="primary" type="button" disabled={busy||!cart.length} onClick={()=>void finalizeSale()}>{busy?'Saving…':'Finalize sale'}</button></div>
    </section>

    <section class="card"><h2>Customer payment / advance</h2><form onSubmit={receivePayment} class="grid-form"><label>Customer <select value={paymentCustomer} onChange={e=>setPaymentCustomer((e.currentTarget as HTMLSelectElement).value)} required><option value="">Choose…</option>{customers.map(c=><option value={c.id}>{c.name}</option>)}</select></label><label>Amount ₹ <input value={paymentAmount} onInput={e=>setPaymentAmount((e.currentTarget as HTMLInputElement).value)} type="number" min="0.01" step="0.01" required/></label><label>Mode <select value={paymentMode} onChange={e=>setPaymentMode((e.currentTarget as HTMLSelectElement).value as Tender['mode'])}><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option><option value="bank">Bank</option><option value="other">Other</option></select></label><button disabled={busy}>Record payment</button></form></section>

    {offlineSales.length>0&&<section class="card no-print" aria-label="Local offline sales"><h2>Local provisional sales</h2><div class="table-wrap"><table><thead><tr><th>Provisional</th><th>Status</th><th>Total</th><th>Official</th></tr></thead><tbody>{offlineSales.map(s=><tr><td>{s.provisionalDocNo}</td><td>{s.status}</td><td>{money(s.totalPaise)}</td><td>{s.officialDocNo??'—'}</td></tr>)}</tbody></table></div></section>}
    <section class="card print-area"><div class="row no-print"><h2>Recent invoices</h2><button type="button" onClick={()=>window.print()}>Print list</button></div><table><thead><tr><th>Invoice</th><th>Date</th><th>Status</th><th>Total</th></tr></thead><tbody>{sales.map(s=><tr><td>{s.doc_no}</td><td>{s.business_date}</td><td>{s.status}</td><td>{money(s.total_paise)}</td></tr>)}</tbody></table></section>
  </main>;
}
