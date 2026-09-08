import { useEffect, useState } from 'preact/hooks';
import { compareLegacyDsbDayToPro, type LegacyDsbDayComparison } from '@dsb-pro/core';
import { getDefaultShopId, getSaleReceipt, getShopBusinessDate, getShopDayReconciliation, listRecentSales, voidSale, type SaleInvoice, type SaleReceipt, type ShopDayReconciliation } from '@dsb-pro/adapters';
import { LanguageToggle } from '../components/LanguageToggle';
import { appRoute } from '../lib/paths';
import { getLocale, t } from '../lib/i18n';

const money=(paise:number)=>`₹${(paise/100).toFixed(2)}`;

type PrintMode='thermal'|'a4';

export function SalesHistoryScreen(){
  const [sales,setSales]=useState<SaleInvoice[]>([]); const [receipt,setReceipt]=useState<SaleReceipt|null>(null); const [printMode,setPrintMode]=useState<PrintMode>('a4');
  const [shopId,setShopId]=useState(''); const [reportDate,setReportDate]=useState(''); const [report,setReport]=useState<ShopDayReconciliation|null>(null); const [reportBusy,setReportBusy]=useState(false);
  const [legacyComparison,setLegacyComparison]=useState<LegacyDsbDayComparison|null>(null); const [legacyCompareFile,setLegacyCompareFile]=useState('');
  const [error,setError]=useState(''); const [message,setMessage]=useState(''); const [busy,setBusy]=useState(false);
  const [,forceLocale]=useState(0);

  async function loadReport(shop:string,date:string){setReportBusy(true);try{setReport(await getShopDayReconciliation(shop,date));}finally{setReportBusy(false);}}
  async function refresh(){
    const shop=await getDefaultShopId(); setShopId(shop);
    const date=reportDate||await getShopBusinessDate(shop); if(!reportDate)setReportDate(date);
    const [recent,day]=await Promise.all([listRecentSales(shop,100),getShopDayReconciliation(shop,date)]);
    setSales(recent); setReport(day);
  }
  useEffect(()=>{void refresh().catch(e=>setError(String(e)));const h=()=>forceLocale(v=>v+1);window.addEventListener('dsb-locale-change',h);return()=>window.removeEventListener('dsb-locale-change',h);},[]);

  async function openReceipt(sale:SaleInvoice,mode:PrintMode){setBusy(true);setError('');try{setPrintMode(mode);setReceipt(await getSaleReceipt(sale.id));setTimeout(()=>window.print(),50);}catch(e){setError(String(e));}finally{setBusy(false);}}
  async function doVoid(sale:SaleInvoice){if(!confirm(`Void invoice ${sale.doc_no}? This creates reversing stock movements; history is retained.`))return;setBusy(true);setError('');try{await voidSale(sale.id,crypto.randomUUID());setMessage(`Invoice ${sale.doc_no} voided.`);await refresh();if(receipt?.invoice.id===sale.id)setReceipt(null);}catch(e){setError(String(e));}finally{setBusy(false);}}
  async function refreshReport(){if(!shopId||!reportDate)return;setError('');setLegacyComparison(null);setLegacyCompareFile('');try{await loadReport(shopId,reportDate);}catch(e){setError(String(e));}}
  async function compareLegacyBackup(ev:Event){
    setError(''); setLegacyComparison(null); setLegacyCompareFile('');
    if(!report){setError('Refresh the DSB Pro day totals before comparing a legacy backup.');return;}
    const file=(ev.currentTarget as HTMLInputElement).files?.[0]; if(!file)return;
    if(file.size>5*1024*1024){setError('Legacy DSB backup is too large for this comparison screen.');return;}
    try{
      const parsed=JSON.parse(await file.text()) as unknown;
      const comparison=compareLegacyDsbDayToPro(parsed,reportDate,report);
      setLegacyComparison(comparison); setLegacyCompareFile(file.name);
    }catch(e){setError(e instanceof Error?e.message:String(e));}
  }

  const locale=getLocale();
  return <main class="page wide"><div class="row no-print"><a href={appRoute.home}>← {t('home',locale)}</a><LanguageToggle/></div><h1 class="no-print">{t('salesHistory',locale)}</h1>
    {error&&<p role="alert" class="alert no-print">{error}</p>}{message&&<p role="status" class="success no-print">{message}</p>}
    <section class="card no-print" aria-label="Day reconciliation">
      <div class="row"><div><h2>Day reconciliation</h2><p class="muted">Use this at shop close to compare DSB Pro with legacy DSB for the same business date.</p></div></div>
      <div class="row"><label>Business date <input aria-label="Reconciliation business date" type="date" value={reportDate} onInput={e=>setReportDate((e.currentTarget as HTMLInputElement).value)}/></label><button type="button" disabled={reportBusy||!shopId||!reportDate} onClick={()=>void refreshReport()}>{reportBusy?'Refreshing…':'Refresh totals'}</button></div>
      {report&&<div data-testid="day-reconciliation-summary">
        <div class="table-wrap"><table><tbody>
          <tr><th>Finalized invoices</th><td>{report.invoiceCount}</td></tr>
          <tr><th>Sales total</th><td>{money(report.salesTotalPaise)}</td></tr>
          <tr><th>Discounts</th><td>{money(report.discountPaise)}</td></tr>
          <tr><th>Extra charges</th><td>{money(report.extraChargesPaise)}</td></tr>
          <tr><th>Direct sale receipts</th><td>{money(report.directSaleReceiptsPaise)}</td></tr>
          <tr><th>Credit created on sales</th><td>{money(report.creditCreatedPaise)}</td></tr>
          <tr><th>Standalone customer receipts</th><td>{money(report.standaloneCustomerReceiptsPaise)}</td></tr>
          <tr><th>Customer advance created today</th><td>{money(report.standaloneAdvancePaise)}</td></tr>
          <tr><th>All customer receipts</th><td>{money(report.allCustomerReceiptsPaise)}</td></tr>
          <tr><th>Voided invoices</th><td>{report.voidCount} · {money(report.voidedTotalPaise)}</td></tr>
        </tbody></table></div>
        <h3>Payment modes</h3>
        <div class="table-wrap"><table><thead><tr><th>Cash</th><th>UPI</th><th>Card</th><th>Bank</th><th>Other</th></tr></thead><tbody><tr><td>{money(report.paymentModes.cash)}</td><td>{money(report.paymentModes.upi)}</td><td>{money(report.paymentModes.card)}</td><td>{money(report.paymentModes.bank)}</td><td>{money(report.paymentModes.other)}</td></tr></tbody></table></div>
        <p><strong>Current customer outstanding:</strong> {money(report.currentCustomerOutstandingPaise)} · <strong>Current customer advance:</strong> {money(report.currentCustomerAdvancePaise)}</p>
        <h3>Items sold on {report.businessDate}</h3>
        {report.soldItems.length?<div class="table-wrap"><table><thead><tr><th>Item</th><th>Sold</th><th>Current stock</th></tr></thead><tbody>{report.soldItems.map(i=><tr><td>{i.name}</td><td>{i.soldQtySmallest} {i.smallestUnit}</td><td>{i.currentStockSmallest} {i.smallestUnit}</td></tr>)}</tbody></table></div>:<p>No finalized sale items for this date.</p>}
        <hr/>
        <h3>Compare with old DSB backup</h3>
        <p class="muted">At shop closing, export a fresh JSON backup from old DSB and choose it here. The file is read in this browser; it is not uploaded to GitHub.</p>
        <input aria-label="Choose closing DSB backup JSON" type="file" accept=".json,application/json" onChange={compareLegacyBackup}/>
        {legacyComparison&&<div class="card" aria-label="Legacy DSB comparison result">
          <p><strong>{legacyCompareFile}</strong><br/>Old DSB exported at {new Date(legacyComparison.legacy.exportedAt).toLocaleString()}.</p>
          <p role="status" class={legacyComparison.exactMatch?'success':'alert'}><strong>{legacyComparison.exactMatch?'MATCH — Phase 4 day totals reconcile':'MISMATCH — review the rows below'}</strong></p>
          <div class="table-wrap"><table><thead><tr><th>Check</th><th>Old DSB</th><th>DSB Pro</th><th>Result</th></tr></thead><tbody>
            {legacyComparison.rows.map(row=><tr><td>{row.label}</td><td>{row.kind==='paise'?money(row.legacy):row.legacy}</td><td>{row.kind==='paise'?money(row.dsbPro):row.dsbPro}</td><td><strong>{row.match?'MATCH':'MISMATCH'}</strong></td></tr>)}
          </tbody></table></div>
          {legacyComparison.legacy.returnCreditPaise>0&&<p class="alert">Old DSB contains sale-return credit of {money(legacyComparison.legacy.returnCreditPaise)}. Returns need manual review and cannot receive an automatic PASS.</p>}
          {legacyComparison.legacy.warnings.length>0&&<details><summary>Comparison warnings ({legacyComparison.legacy.warnings.length})</summary><ul>{legacyComparison.legacy.warnings.map(w=><li>{w}</li>)}</ul></details>}
        </div>}
      </div>}
    </section>

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
