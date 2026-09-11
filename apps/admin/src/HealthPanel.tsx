import { useEffect, useState } from 'preact/hooks';
import { checkInvariants,getLatestBackupHealth,type BackupHealth,type InvariantHealth } from '@dsb-pro/adapters';

export function HealthPanel(){
  const [backup,setBackup]=useState<BackupHealth|null|undefined>(undefined);
  const [integrity,setIntegrity]=useState<InvariantHealth|null|undefined>(undefined);
  const [error,setError]=useState<string|null>(null);
  useEffect(()=>{void Promise.all([getLatestBackupHealth(),checkInvariants()])
    .then(([b,i])=>{setBackup(b);setIntegrity(i);})
    .catch((e:unknown)=>setError(e instanceof Error?e.message:String(e)));},[]);
  const backupAgeMs=backup?.finished_at?Date.now()-Date.parse(backup.finished_at):Number.POSITIVE_INFINITY;
  const backupOk=backup?.status==='success'&&backupAgeMs>=0&&backupAgeMs<=24*60*60*1000&&backup.destinations.length>=2&&backup.destinations.every(d=>d.verified);
  const integrityOk=integrity?.ok===true;
  return <section class="card" aria-label="System health">
    <h2>System health</h2>
    {error&&<p role="alert" class="alert">Health check unavailable: {error}</p>}
    {backup===undefined?<p>Loading backup health…</p>:backup===null?<p class="alert">No verified backup has run yet.</p>:<>
      <p class={backupOk?'success':'alert'}><strong>Backup:</strong> {backupOk?'PASS':'ATTENTION'} · {backup.status} · {backup.finished_at??'never'}{backupAgeMs>24*60*60*1000?' · older than 24 hours':''}</p>
      <p>Destinations: {backup.destinations.length?backup.destinations.map(d=>`${d.name} (${d.verified?'verified':'unverified'})`).join(', '):'none'}</p>
    </>}
    {integrity===undefined?<p>Loading invariant health…</p>:integrity===null?null:
      <p class={integrityOk?'success':'alert'}><strong>Financial invariants:</strong> {integrityOk?'PASS':'FAIL'} · sale totals {integrity.saleTotalViolations} · purchase totals {integrity.purchaseTotalViolations} · negative stock {integrity.negativeStock} · allocation violations {integrity.allocationViolations} · stock projection {integrity.stockProjectionViolations} · void reversals {integrity.voidReversalViolations}</p>}
    {!integrityOk&&integrity!==undefined&&<p class="alert"><strong>Stop financial posting and investigate before continuing.</strong></p>}
  </section>;
}
