import { useEffect, useState } from 'preact/hooks';
import {
  getCurrentMembership, getDefaultShopId, getShopSettings, updateShopSettings, getCashierOfflineFinalizationPolicy,
  type PrinterWidth,
} from '@dsb-pro/adapters';
import { updateCashierOfflinePolicy } from '../lib/offlineSync';
import { appRoute } from '../lib/paths';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

export function SettingsScreen() {
  const [shopId,setShopId]=useState(''); const [role,setRole]=useState('');
  const [loaded,setLoaded]=useState(false);
  const [name,setName]=useState(''); const [address,setAddress]=useState(''); const [gstin,setGstin]=useState('');
  const [invoicePrefix,setInvoicePrefix]=useState(''); const [timezone,setTimezone]=useState('');
  const [printerWidth,setPrinterWidth]=useState<PrinterWidth>('80mm'); const [fiscalYearStartMonth,setFiscalYearStartMonth]=useState(4);
  const [allowCashierOffline,setAllowCashierOffline]=useState(false); const [policyBusy,setPolicyBusy]=useState(false);
  const [busy,setBusy]=useState(false); const [message,setMessage]=useState(''); const [error,setError]=useState('');

  async function refresh(){
    const membership=await getCurrentMembership(); if(!membership) throw new Error('No tenant membership.');
    const shop=await getDefaultShopId();
    setRole(membership.role); setShopId(shop);
    const [s,policy]=await Promise.all([getShopSettings(shop),getCashierOfflineFinalizationPolicy(membership.tenantId)]);
    setName(s.name); setAddress(s.address??''); setGstin(s.gstin??''); setInvoicePrefix(s.invoicePrefix??'');
    setTimezone(s.timezone); setPrinterWidth(s.printerWidth); setFiscalYearStartMonth(s.fiscalYearStartMonth);
    setAllowCashierOffline(policy); setLoaded(true);
  }
  useEffect(()=>{ void refresh().catch(e=>setError(String(e))); },[]);

  async function saveProfile(ev:Event){
    ev.preventDefault(); if(busy)return; setError(''); setMessage(''); setBusy(true);
    try{
      await updateShopSettings({ shopId, name, address: address||undefined, gstin: gstin||undefined, invoicePrefix: invoicePrefix||undefined, timezone, printerWidth, fiscalYearStartMonth });
      setMessage('Shop settings saved.');
    }catch(e){setError(String(e));} finally{setBusy(false);}
  }
  async function togglePolicy(ev:Event){
    const allow=(ev.currentTarget as HTMLInputElement).checked;
    if(policyBusy)return;
    // Optimistic: this is a controlled checkbox, so the setError/setMessage
    // calls below trigger a re-render before the RPC resolves. Flip the
    // bound state first so that render reflects the click instead of
    // snapping the checkbox back to its old value until the await settles.
    setAllowCashierOffline(allow); setError(''); setMessage(''); setPolicyBusy(true);
    try{ await updateCashierOfflinePolicy(allow); setMessage(`Cashier offline finalization ${allow?'enabled':'disabled'}.`); }
    catch(e){ setAllowCashierOffline(!allow); setError(String(e)); } finally{setPolicyBusy(false);}
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
        <p><button disabled={busy}>{busy?'Saving…':'Save shop profile'}</button></p>
      </form>
    </section>
    <section><h2>POS ergonomics policy</h2>
      <p class="muted">A cashier till may finalize a sale while offline only when this is on. When it is off, a cashier who loses connection cannot finalize — the cart stays on screen as a draft, unsubmitted, until the connection returns. An owner or manager can always finalize offline regardless of this setting.</p>
      <label><input type="checkbox" checked={allowCashierOffline} disabled={policyBusy||role!=='owner'} onChange={togglePolicy}/> Allow cashiers to finalize sales while offline</label>
      {role!=='owner'&&<p class="muted">Only the owner can change this.</p>}
    </section>
  </main>;
}
