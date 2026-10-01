import type {DsbSyncDb} from './db';

// C2 durable financial attempts (COMPLETE_REMAINING_BUILD_PLAN v1.1 §8). An online money request is
// persisted READY before dispatch, so a lost response becomes UNKNOWN and is reconciled by the same
// request ID -- never re-sent with a new ID or a changed payload.
export type FinancialAttemptState='DRAFT'|'READY'|'SENDING'|'UNKNOWN'|'COMMITTED'|'REJECTED';
export type FinancialAttemptOperation='supplier.record.v1'|'supplier.allocate.v1'|'supplier.void.v1'|'supplier.release.v1'
  |'record_customer_payment_v2'|'allocate_customer_payment_v2';
export type FinancialAttempt={
  id:string;operation:FinancialAttemptOperation;shopId:string;accountId:string;
  payload:Readonly<Record<string,unknown>>;state:FinancialAttemptState;createdAt:number;lastAttemptAt:number|null;
  committedResult:unknown|null;errorCode:string|null;errorMessage:string|null;
};
export type AttemptSendOutcome=
  |{kind:'committed';result:unknown}
  |{kind:'rejected';code:string;message:string}
  |{kind:'unknown';message:string};
export type AttemptLookup=
  |{kind:'committed';result:unknown}
  |{kind:'not_found'}
  |{kind:'unavailable';message:string};

const OPEN_STATES:FinancialAttemptState[]=['READY','SENDING','UNKNOWN'];
const deepFreeze=<T>(value:T):T=>{
  if(value&&typeof value==='object'){Object.freeze(value);for(const v of Object.values(value))deepFreeze(v);}
  return value;
};

export async function createAttemptDraft(db:DsbSyncDb,input:{operation:FinancialAttemptOperation;shopId:string;accountId:string;payload:Record<string,unknown>},now=Date.now()):Promise<FinancialAttempt>{
  const attempt:FinancialAttempt={id:crypto.randomUUID(),operation:input.operation,shopId:input.shopId,accountId:input.accountId,
    payload:structuredClone(input.payload),state:'DRAFT',createdAt:now,lastAttemptAt:null,committedResult:null,errorCode:null,errorMessage:null};
  await db.financialAttempts.put(attempt);
  return attempt;
}
export async function updateAttemptDraft(db:DsbSyncDb,id:string,payload:Record<string,unknown>):Promise<FinancialAttempt>{
  return db.transaction('rw',db.financialAttempts,async()=>{
    const row=await db.financialAttempts.get(id);
    if(!row)throw new Error('Payment draft not found.');
    if(row.state!=='DRAFT')throw new Error('This payment was already submitted and can no longer be edited.');
    const next={...row,payload:structuredClone(payload)};
    await db.financialAttempts.put(next);
    return next;
  });
}
export async function cancelAttemptDraft(db:DsbSyncDb,id:string):Promise<void>{
  await db.transaction('rw',db.financialAttempts,async()=>{
    const row=await db.financialAttempts.get(id);
    if(row&&row.state!=='DRAFT')throw new Error('Only an unsubmitted draft can be discarded.');
    if(row)await db.financialAttempts.delete(id);
  });
}
// Freezing is the durable commit point: the payload can never change after this.
export async function freezeAttempt(db:DsbSyncDb,id:string):Promise<FinancialAttempt>{
  return db.transaction('rw',db.financialAttempts,async()=>{
    const row=await db.financialAttempts.get(id);
    if(!row)throw new Error('Payment draft not found.');
    if(row.state==='DRAFT'){const next={...row,state:'READY' as const};await db.financialAttempts.put(next);return next;}
    return row;
  });
}

const inFlight=new Map<string,Promise<FinancialAttempt>>();
async function transition(db:DsbSyncDb,id:string,from:FinancialAttemptState[],patch:Partial<FinancialAttempt>):Promise<FinancialAttempt>{
  return db.transaction('rw',db.financialAttempts,async()=>{
    const row=await db.financialAttempts.get(id);
    if(!row)throw new Error('Payment attempt not found.');
    if(!from.includes(row.state))return row;
    const next={...row,...patch};
    await db.financialAttempts.put(next);
    return next;
  });
}

// Sends a READY attempt, or retries an UNKNOWN one only after the caller's lookup says NOT_FOUND.
// Concurrent calls for one ID share a single in-flight promise (double-click safety).
export function submitAttempt(db:DsbSyncDb,id:string,send:(attempt:FinancialAttempt)=>Promise<AttemptSendOutcome>,now=()=>Date.now()):Promise<FinancialAttempt>{
  const existing=inFlight.get(id);
  if(existing)return existing;
  const run=(async()=>{
    const claimed=await db.transaction('rw',db.financialAttempts,async()=>{
      const row=await db.financialAttempts.get(id);
      if(!row)throw new Error('Payment attempt not found.');
      if(row.state!=='READY')return {row,claimed:false};
      const next={...row,state:'SENDING' as const,lastAttemptAt:now()};
      await db.financialAttempts.put(next);
      return {row:next,claimed:true};
    });
    if(!claimed.claimed)return claimed.row;
    let outcome:AttemptSendOutcome;
    try{outcome=await send(deepFreeze(structuredClone(claimed.row)));}
    catch(error){outcome={kind:'unknown',message:error instanceof Error?error.message:String(error)};}
    // A final answer for this id also overrides UNKNOWN (set by another tab's startup recovery).
    if(outcome.kind==='committed')return transition(db,id,['SENDING','UNKNOWN'],{state:'COMMITTED',committedResult:outcome.result,errorCode:null,errorMessage:null});
    if(outcome.kind==='rejected')return transition(db,id,['SENDING','UNKNOWN'],{state:'REJECTED',errorCode:outcome.code,errorMessage:outcome.message});
    return transition(db,id,['SENDING'],{state:'UNKNOWN',errorCode:null,errorMessage:outcome.message});
  })().finally(()=>inFlight.delete(id));
  inFlight.set(id,run);
  return run;
}

// Startup: an attempt left SENDING by a crash or refresh has an unknown outcome.
export async function recoverInterruptedAttempts(db:DsbSyncDb):Promise<number>{
  return db.transaction('rw',db.financialAttempts,async()=>{
    const rows=await db.financialAttempts.where('state').equals('SENDING').toArray();
    for(const row of rows){if(!inFlight.has(row.id))await db.financialAttempts.put({...row,state:'UNKNOWN',errorMessage:'Interrupted before the server answer was known.'});}
    return rows.length;
  });
}

// UNKNOWN → COMMITTED on a found server result; NOT_FOUND → READY (same ID and payload may be
// re-sent); a lookup failure (offline, permission, auth expiry) keeps UNKNOWN: it proves nothing.
export async function reconcileAttempt(db:DsbSyncDb,id:string,lookup:(attempt:FinancialAttempt)=>Promise<AttemptLookup>):Promise<FinancialAttempt>{
  const row=await db.financialAttempts.get(id);
  if(!row)throw new Error('Payment attempt not found.');
  if(row.state!=='UNKNOWN')return row;
  let found:AttemptLookup;
  try{found=await lookup(row);}catch(error){found={kind:'unavailable',message:error instanceof Error?error.message:String(error)};}
  if(found.kind==='committed')return transition(db,id,['UNKNOWN'],{state:'COMMITTED',committedResult:found.result,errorMessage:null});
  if(found.kind==='not_found')return transition(db,id,['UNKNOWN'],{state:'READY',errorMessage:null});
  return transition(db,id,['UNKNOWN'],{errorMessage:found.message});
}

// A rejected attempt is never resubmitted; its payload is copied into a new editable draft (new ID).
export async function copyRejectedToDraft(db:DsbSyncDb,id:string,now=Date.now()):Promise<FinancialAttempt>{
  const row=await db.financialAttempts.get(id);
  if(!row||row.state!=='REJECTED')throw new Error('Only a rejected payment can be copied to a new draft.');
  return createAttemptDraft(db,{operation:row.operation,shopId:row.shopId,accountId:row.accountId,payload:structuredClone(row.payload) as Record<string,unknown>},now);
}

export async function listOpenAttempts(db:DsbSyncDb,shopId:string,accountId?:string):Promise<FinancialAttempt[]>{
  const rows=await db.financialAttempts.where('state').anyOf(OPEN_STATES).toArray();
  return rows.filter(r=>r.shopId===shopId&&(accountId===undefined||r.accountId===accountId)).sort((a,b)=>a.createdAt-b.createdAt);
}
export async function getAttempt(db:DsbSyncDb,id:string):Promise<FinancialAttempt|undefined>{return db.financialAttempts.get(id);}
