import { useEffect, useState } from 'preact/hooks';
import {
  getDefaultShopId,getShopBusinessDate,listRecentReturns,listReturnableLines,listReturnSources,postReturn,voidReturn,
  type PostedReturn,type ReturnDisposition,type ReturnSource,type ReturnType,type ReturnableLine,
} from '@dsb-pro/adapters';
import { appRoute } from '../lib/paths';

const money=(paise:number)=>`₹${(paise/100).toFixed(2)}`;
const dispositions:{value:ReturnDisposition;label:string}[]=[
  {value:'RETURN_TO_SELLABLE',label:'Return to sellable stock'},
  {value:'DAMAGED',label:'Damaged'},
  {value:'EXPIRED',label:'Expired'},
  {value:'SUPPLIER_RETURN',label:'Send to supplier'},
];
type DraftLine={sourceLineId:string;qty:string;disposition:ReturnDisposition};

export function ReturnsScreen(){
  const [shopId,setShopId]=useState(''); const [businessDate,setBusinessDate]=useState('');
  const [type,setType]=useState<ReturnType>('SALE'); const [sources,setSources]=useState<ReturnSource[]>([]); const [sourceId,setSourceId]=useState('');
  const [lines,setLines]=useState<ReturnableLine[]>([]); const [draft,setDraft]=useState<DraftLine[]>([]); const [notes,setNotes]=useState('');
  const [recent,setRecent]=useState<PostedReturn[]>([]); const [busy,setBusy]=useState(false); const [error,setError]=useState(''); const [message,setMessage]=useState('');
  const [clientId,setClientId]=useState(()=>crypto.randomUUID());

  async function refreshRecent(shop:string){setRecent(await listRecentReturns(shop));}
  async function refreshSources(nextType:ReturnType,shop:string){setSources(await listReturnSources(nextType,shop));setSourceId('');setLines([]);setDraft([]);}
  useEffect(()=>{void (async()=>{try{const shop=await getDefaultShopId();setShopId(shop);setBusinessDate(await getShopBusinessDate(shop));await Promise.all([refreshSources('SALE',shop),refreshRecent(shop)]);}catch(e){setError(String(e));}})();},[]);

  async function changeType(next:ReturnType){setType(next);setError('');setMessage('');if(shopId)await refreshSources(next,shopId);}
  async function changeSource(next:string){setSourceId(next);setError('');setMessage('');if(!next){setLines([]);setDraft([]);return;}try{
    const rows=await listReturnableLines(type,next);setLines(rows);setDraft(rows.map(row=>({sourceLineId:row.id,qty:'',disposition:type==='SALE'?'RETURN_TO_SELLABLE':'SUPPLIER_RETURN'})));
  }catch(e){setError(String(e));}}
  function patchLine(id:string,change:Partial<DraftLine>){setDraft(rows=>rows.map(row=>row.sourceLineId===id?{...row,...change}:row));}

  async function submit(ev:Event){ev.preventDefault();if(busy||!shopId||!sourceId)return;setBusy(true);setError('');setMessage('');try{
    const selected=draft.flatMap(row=>{const qty=Number(row.qty);return Number.isFinite(qty)&&qty>0?[{sourceLineId:row.sourceLineId,qty,disposition:row.disposition}]:[];});
    if(!selected.length)throw new Error('Enter a return quantity for at least one line.');
    for(const row of selected){const source=lines.find(line=>line.id===row.sourceLineId);if(!source||row.qty>source.remaining_qty)throw new Error(`Return quantity exceeds the remaining quantity for ${source?.item_name_snapshot??'a line'}.`);}
    await postReturn({type,sourceId,businessDate,clientId,lines:selected,notes:notes.trim()||undefined});
    setClientId(crypto.randomUUID());setNotes('');setMessage(type==='SALE'?'Sale return posted. Cash refund and customer balance were calculated by the server.':'Purchase return posted. Supplier ledger and stock were updated by the server.');
    await Promise.all([changeSource(sourceId),refreshRecent(shopId)]);
  }catch(e){setError(String(e));}finally{setBusy(false);}}

  async function undo(row:PostedReturn){if(!confirm(`Void return ${row.doc_no}? Its money and stock effects will be reversed without deleting history.`))return;setBusy(true);setError('');try{
    await voidReturn(row.return_type,row.id,crypto.randomUUID());setMessage(`Return ${row.doc_no} voided.`);await refreshRecent(shopId);if(sourceId)await changeSource(sourceId);
  }catch(e){setError(String(e));}finally{setBusy(false);}}

  return <main class="page wide"><p><a href={appRoute.home}>← Home</a></p><h1>Returns</h1>
    <p class="muted">Returns are separate immutable documents. The server calculates amounts, refund limits, stock movements and ledger entries.</p>
    {error&&<p role="alert" class="alert">{error}</p>}{message&&<p role="status" class="success">{message}</p>}
    <section class="card"><h2>Post a return</h2><form onSubmit={submit}>
      <div class="grid-form">
        <label>Return type <select value={type} onChange={e=>void changeType((e.currentTarget as HTMLSelectElement).value as ReturnType)}><option value="SALE">Customer sale return</option><option value="PURCHASE">Supplier purchase return</option></select></label>
        <label>Business date <input type="date" required value={businessDate} onInput={e=>setBusinessDate((e.currentTarget as HTMLInputElement).value)}/></label>
        <label>Source document <select required value={sourceId} onChange={e=>void changeSource((e.currentTarget as HTMLSelectElement).value)}><option value="">Choose…</option>{sources.map(source=><option key={source.id} value={source.id}>{source.doc_no} · {source.business_date} · {money(source.total_paise)}{source.customer_name?` · ${source.customer_name}`:source.party_name?` · ${source.party_name}`:''}</option>)}</select></label>
      </div>
      {lines.length>0&&<div class="table-wrap"><table><thead><tr><th>Item</th><th>Sold/bought</th><th>Already returned</th><th>Return qty</th><th>Disposition</th></tr></thead><tbody>{lines.map(line=>{const row=draft.find(x=>x.sourceLineId===line.id);return <tr key={line.id}><td>{line.item_name_snapshot}</td><td>{line.qty} {line.unit_name_snapshot}</td><td>{line.returned_qty}</td><td><input aria-label={`Return quantity for ${line.item_name_snapshot}`} type="number" min="0" max={line.remaining_qty} step="0.000001" disabled={line.remaining_qty<=0||busy} value={row?.qty??''} onInput={e=>patchLine(line.id,{qty:(e.currentTarget as HTMLInputElement).value})}/></td><td><select aria-label={`Disposition for ${line.item_name_snapshot}`} disabled={line.remaining_qty<=0||busy} value={row?.disposition} onChange={e=>patchLine(line.id,{disposition:(e.currentTarget as HTMLSelectElement).value as ReturnDisposition})}>{dispositions.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select></td></tr>})}</tbody></table></div>}
      <label>Notes <textarea value={notes} onInput={e=>setNotes((e.currentTarget as HTMLTextAreaElement).value)}/></label>
      <p><button class="primary" disabled={busy||!sourceId||!lines.some(line=>line.remaining_qty>0)}>{busy?'Posting…':'Post return'}</button></p>
    </form></section>
    <section class="card"><h2>Recent returns</h2>{!recent.length?<p>No returns posted.</p>:<div class="table-wrap"><table><thead><tr><th>Document</th><th>Type</th><th>Date</th><th>Total</th><th>Refund / balance</th><th>Status</th><th/></tr></thead><tbody>{recent.map(row=><tr key={`${row.return_type}:${row.id}`}><td>{row.doc_no}</td><td>{row.return_type}</td><td>{row.business_date}</td><td>{money(row.total_paise)}</td><td>{row.return_type==='SALE'?`${money(row.cash_refund_paise??0)} cash · ${money(row.balance_credit_paise??0)} balance`:'Supplier credit'}</td><td>{row.status}</td><td>{row.status==='POSTED'&&<button type="button" disabled={busy} onClick={()=>void undo(row)}>Void</button>}</td></tr>)}</tbody></table></div>}</section>
  </main>;
}
