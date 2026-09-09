import {useEffect,useState} from 'preact/hooks';
import type {LocalSyncConflict} from '@dsb-pro/sync';
import {appRoute} from '../lib/paths';
import {forceRetryNow,getSyncDashboard,resolveConflictLocally,runSyncNow,updateCashierOfflinePolicy,waitForOfflineRuntime} from '../lib/offlineSync';

type Dashboard=Awaited<ReturnType<typeof getSyncDashboard>>;
const when=(value:number|null)=>value?new Date(value).toLocaleString():'Never';

export function SyncScreen(){
  const [dashboard,setDashboard]=useState<Dashboard|null>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  async function refresh(){
    try{await waitForOfflineRuntime();setDashboard(await getSyncDashboard());setError('');}
    catch(e){setError(e instanceof Error?e.message:String(e));}
  }
  useEffect(()=>{
    void refresh();
    const handler=()=>void refresh();
    window.addEventListener('dsb-sync-state',handler);
    const timer=window.setInterval(handler,2000);
    return()=>{window.removeEventListener('dsb-sync-state',handler);window.clearInterval(timer);};
  },[]);
  async function act(fn:()=>Promise<void>){
    setBusy(true);setError('');
    try{await fn();await refresh();}catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  }
  async function resolve(conflict:LocalSyncConflict){await act(()=>resolveConflictLocally(conflict));}
  return <main class="page wide">
    <p><a href={appRoute.home}>← Home</a></p>
    <h1>Sync & offline</h1>
    <p class="muted">Queued financial work stays in IndexedDB until the server confirms it. Rejected work stays visible for review.</p>
    {error&&<p role="alert" class="alert">{error}</p>}
    {!dashboard?<p>Loading sync state…</p>:<>
      <section class="card" aria-label="Sync health"><h2>Sync health</h2>
        <div class="sync-grid">
          <div><strong>Network</strong><br/>{dashboard.state.online?'Online':'Offline'}</div>
          <div><strong>Outbox</strong><br/><span data-testid="sync-outbox-count">{dashboard.health.outboxCount}</span></div>
          <div><strong>Queued sales</strong><br/><span data-testid="sync-queued-sales">{dashboard.health.queuedSales}</span></div>
          <div><strong>Open conflicts</strong><br/><span data-testid="sync-conflict-count">{dashboard.health.conflictCount}</span></div>
          <div><strong>Last clean sync</strong><br/>{when(dashboard.health.lastSyncAt)}</div>
          <div><strong>Clock drift</strong><br/>{dashboard.health.clockDriftMs===null?'Unknown':Math.round(dashboard.health.clockDriftMs/1000)+' sec'}</div>
        </div>
        {dashboard.health.clockDriftMs!==null&&dashboard.health.clockDriftMs>300000&&<p class="alert">Device clock differs from server by more than 5 minutes. Fix the device clock before relying on business dates.</p>}
        {dashboard.state.lastError&&<p class="alert">Last sync issue: {dashboard.state.lastError}</p>}
        <div class="row"><button disabled={busy||dashboard.state.running} onClick={()=>void act(runSyncNow)}>{dashboard.state.running?'Syncing…':'Sync now'}</button><button disabled={busy} onClick={()=>void act(forceRetryNow)}>Retry queued work now</button></div>
      </section>
      <section class="card" aria-label="Offline finalization policy"><h2>Offline finalization policy</h2>
        <p>Owner and manager billing may be queued offline. Cashier offline finalization is <strong>{dashboard.policy.allowCashierOfflineFinalization?'allowed':'disabled'}</strong>.</p>
        {dashboard.identity.role==='owner'&&<label><input type="checkbox" checked={dashboard.policy.allowCashierOfflineFinalization} onChange={e=>void act(()=>updateCashierOfflinePolicy((e.currentTarget as HTMLInputElement).checked))}/> Allow cashiers to finalize sales while offline</label>}
      </section>
      <section class="card" aria-label="Offline sales"><h2>Provisional / synced offline sales</h2>
        {dashboard.sales.length?<div class="table-wrap"><table><thead><tr><th>Number</th><th>Date</th><th>Total</th><th>Status</th><th>Official</th></tr></thead><tbody>{dashboard.sales.map(s=><tr><td>{s.provisionalDocNo}</td><td>{s.businessDate}</td><td>{'₹'+(s.totalPaise/100).toFixed(2)}</td><td>{s.status}</td><td>{s.officialDocNo??'—'}</td></tr>)}</tbody></table></div>:<p>No offline sales on this device.</p>}
      </section>
      <section class="card" aria-label="Sync conflicts"><h2>Needs review</h2>
        {dashboard.conflicts.filter(c=>c.status==='OPEN').length?<ul>{dashboard.conflicts.filter(c=>c.status==='OPEN').map(c=><li><strong>{c.kind}</strong> · {c.target}{c.clientId?' · '+c.clientId:''}<br/>{c.reason} <button disabled={busy} onClick={()=>void resolve(c)}>Mark reviewed</button></li>)}</ul>:<p>No open conflicts.</p>}
      </section>
    </>}
  </main>;
}
