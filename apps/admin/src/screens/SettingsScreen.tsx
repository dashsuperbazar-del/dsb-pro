import { useEffect, useState } from 'preact/hooks';
import {
  getCurrentMembership, getDefaultShopId, getShopSettings, updateShopSettings,
  type PrinterWidth,
} from '@dsb-pro/adapters';
import { appRoute } from '../lib/paths';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

export function SettingsScreen() {
  const [shopId,setShopId]=useState('');
  const [loaded,setLoaded]=useState(false);
  const [name,setName]=useState(''); const [address,setAddress]=useState(''); const [gstin,setGstin]=useState('');
  const [invoicePrefix,setInvoicePrefix]=useState(''); const [timezone,setTimezone]=useState('');
  const [printerWidth,setPrinterWidth]=useState<PrinterWidth>('80mm'); const [fiscalYearStartMonth,setFiscalYearStartMonth]=useState(4);
  const [allowNegativeStock,setAllowNegativeStock]=useState(false);
  const [busy,setBusy]=useState(false); const [message,setMessage]=useState(''); const [error,setError]=useState('');

  async function refresh(){
    const membership=await getCurrentMembership(); if(!membership) throw new Error('No tenant membership.');
    const shop=await getDefaultShopId();
    setShopId(shop);
    const s=await getShopSettings(shop);
    setName(s.name); setAddress(s.address??''); setGstin(s.gstin??''); setInvoicePrefix(s.invoicePrefix??'');
    setTimezone(s.timezone); setPrinterWidth(s.printerWidth); setFiscalYearStartMonth(s.fiscalYearStartMonth);
    setAllowNegativeStock(s.allowNegativeStock); setLoaded(true);
  }
  useEffect(()=>{ void refresh().catch(e=>setError(String(e))); },[]);

  async function saveProfile(ev:Event){
    ev.preventDefault(); if(busy)return; setError(''); setMessage(''); setBusy(true);
    try{
      await updateShopSettings({ shopId, name, address: address||undefined, gstin: gstin||undefined, invoicePrefix: invoicePrefix||undefined, timezone, printerWidth, fiscalYearStartMonth, allowNegativeStock });
      setMessage('Shop settings saved.');
    }catch(e){setError(String(e));} finally{setBusy(false);}
  }

  if(!loaded) return <main><p><a href={appRoute.home}>← Home</a></p><h1>Settings</h1>{error?<p role="alert">{error}</p>:<p>Loading…</p>}</main>;
  return <main>
    <p><a href={appRoute.home}>← Home</a></p><h1>Settings</h1>
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    <section><h2>Shop profile</h2>
      <form onSubmit={saveProfile}>
        <label>Shop name <input value={name} onInput={e=>setName((e.currentTarget as HTMLInputElement).value)} required/></label> <label>Address <input value={address} onInput={e=>setAddress((e.currentTarget as HTMLInputElement).value)}/></label> <label>GSTIN <input value={gstin} onInput={e=>setGstin((e.currentTarget as HTMLInputElement).value)} placeholder="27ABCDE1234F1Z5"/></label>
        <br/><label>Invoice prefix <input value={invoicePrefix} onInput={e=>setInvoicePrefix((e.currentTarget as HTMLInputElement).value)} placeholder="INV"/></label> <label>Timezone <input value={timezone} onInput={e=>setTimezone((e.currentTarget as HTMLInputElement).value)} required/></label>
        <label>Printer width <select value={printerWidth} onChange={e=>setPrinterWidth((e.currentTarget as HTMLSelectElement).value as PrinterWidth)}><option value="58mm">58mm thermal</option><option value="80mm">80mm thermal</option></select></label>
        <label>Fiscal year starts <select value={String(fiscalYearStartMonth)} onChange={e=>setFiscalYearStartMonth(Number((e.currentTarget as HTMLSelectElement).value))}>{MONTHS.map((m,i)=><option key={m} value={i+1}>{m}</option>)}</select></label>
        <p><label><input type="checkbox" checked={allowNegativeStock} onChange={e=>setAllowNegativeStock((e.currentTarget as HTMLInputElement).checked)}/> Allow selling below zero stock</label></p>
        <p class="muted">On: a sale never blocks on stock — it posts, the item's stock can go negative, and you reconcile it at the next physical count. Off (default): a sale is blocked if it would take an item below zero.</p>
        <p><button disabled={busy}>{busy?'Saving…':'Save shop profile'}</button></p>
      </form>
    </section>
    <p class="muted">Cashier offline-finalization policy moved to <a href={appRoute.sync}>Sync & offline</a>, where it already lived.</p>
  </main>;
}
