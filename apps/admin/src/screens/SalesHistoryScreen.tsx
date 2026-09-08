import { useEffect, useState } from 'preact/hooks';
import { getDefaultShopId, getSaleReceipt, listRecentSales, voidSale, type SaleInvoice, type SaleReceipt } from '@dsb-pro/adapters';
import { LanguageToggle } from '../components/LanguageToggle';
import { appRoute } from '../lib/paths';
import { getLocale, t } from '../lib/i18n';

const money=(paise:number)=>`₹${(paise/100).toFixed(2)}`;

type PrintMode='thermal'|'a4';

export function SalesHistoryScreen(){
  const [sales,setSales]=useState<SaleInvoice[]>([]); const [receipt,setReceipt]=useState<SaleReceipt|null>(null); const [printMode,setPrintMode]=useState<PrintMode>('a4');
  const [error,setError]=useState(''); const [message,setMessage]=useState(''); const [busy,setBusy]=useState(false);
  const [,forceLocale]=useState(0);

  async function refresh(){const shop=await getDefaultShopId();setSales(await listRecentSales(shop,100));}
  useEffect(()=>{void refresh().catch(e=>setError(String(e)));const h=()=>forceLocale(v=>v+1);window.addEventListener('dsb-locale-change',h);return()=>window.removeEventListener('dsb-locale-change',h);},[]);

  async function openReceipt(sale:SaleInvoice,mode:PrintMode){setBusy(true);setError('');try{setPrintMode(mode);setReceipt(await getSaleReceipt(sale.id));setTimeout(()=>window.print(),50);}catch(e){setError(String(e));}finally{setBusy(false);}}
  async function doVoid(sale:SaleInvoice){if(!confirm(`Void invoice ${sale.doc_no}? This creates reversing stock movements; history is retained.`))return;setBusy(true);setError('');try{await voidSale(sale.id,crypto.randomUUID());setMessage(`Invoice ${sale.doc_no} voided.`);await refresh();if(receipt?.invoice.id===sale.id)setReceipt(null);}catch(e){setError(String(e));}finally{setBusy(false);}}

  const locale=getLocale();
  return <main class="page wide"><div class="row no-print"><a href={appRoute.home}>← {t('home',locale)}</a><LanguageToggle/></div><h1 class="no-print">{t('salesHistory',locale)}</h1>
    {error&&<p role="alert" class="alert no-print">{error}</p>}{message&&<p role="status" class="success no-print">{message}</p>}
    <section class="card no-print"><div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Date</th><th>Status</th><th>Total</th><th>Actions</th></tr></thead><tbody>{sales.map(s=><tr><td>{s.doc_no}</td><td>{s.business_date}</td><td>{s.status}</td><td>{money(s.total_paise)}</td><td><div class="row"><button disabled={busy} onClick={()=>void openReceipt(s,'thermal')}>{t('printThermal',locale)}</button><button disabled={busy} onClick={()=>void openReceipt(s,'a4')}>{t('printA4',locale)}</button>{s.status==='FINALIZED'&&<button disabled={busy} onClick={()=>void doVoid(s)}>{t('voidSale',locale)}</button>}</div></td></tr>)}</tbody></table></div></section>

    {receipt&&<article class={`receipt-print receipt-${printMode}`} aria-label="invoice receipt">
      <header><h1>DSB Store</h1><p>Invoice {receipt.invoice.doc_no}<br/>Date {receipt.invoice.business_date}<br/>Status {receipt.invoice.status}</p></header>
      <table><thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead><tbody>{receipt.lines.map(l=><tr><td>{l.item_name_snapshot}<small>{l.unit_name_snapshot}{l.discount_paise?` · discount ${money(l.discount_paise)}`:''}</small></td><td>{l.qty}</td><td>{money(l.unit_price_paise)}</td><td>{money(l.line_total_paise)}</td></tr>)}</tbody></table>
      <dl class="receipt-totals"><div><dt>Subtotal</dt><dd>{money(receipt.invoice.subtotal_paise)}</dd></div>{receipt.invoice.discount_paise>0&&<div><dt>Discount</dt><dd>−{money(receipt.invoice.discount_paise)}</dd></div>}{receipt.invoice.extra_charges_paise>0&&<div><dt>Extra charges</dt><dd>{money(receipt.invoice.extra_charges_paise)}</dd></div>}<div><dt>Total</dt><dd><strong>{money(receipt.invoice.total_paise)}</strong></dd></div></dl>
      <h2>Payments</h2>{receipt.payments.length?<ul>{receipt.payments.map(p=><li>{p.mode.toUpperCase()} {money(p.amount_paise)}{p.reference?` · ${p.reference}`:''}{p.status==='VOID'?' · VOID':''}</li>)}</ul>:<p>Credit / unpaid</p>}
      {receipt.invoice.notes&&<p>Notes: {receipt.invoice.notes}</p>}<footer><p>Thank you · Powered by DSB Pro</p></footer>
    </article>}
  </main>;
}
