import type { OutboxEntry } from './types';

function assertSequence(value:number){
  if(!Number.isSafeInteger(value)||value<1)throw new Error('outbox sequence must be a positive safe integer');
}

export function nextOutboxEntry<T>(entries:ReadonlyArray<OutboxEntry<T>>,now:number):OutboxEntry<T>|null{
  const ordered=[...entries].sort((a,b)=>a.sequence-b.sequence);
  const first=ordered[0];
  if(!first)return null;
  assertSequence(first.sequence);
  if(first.state==='sending')return null;
  if(first.state==='retry'&&first.nextAttemptAt>now)return null;
  return first;
}

export function markOutboxSending<T>(entry:OutboxEntry<T>):OutboxEntry<T>{
  assertSequence(entry.sequence);
  if(entry.state==='sending')throw new Error('outbox entry is already sending');
  return {...entry,state:'sending',attempts:entry.attempts+1,lastError:null};
}

export function markOutboxRetry<T>(entry:OutboxEntry<T>,error:string,nextAttemptAt:number):OutboxEntry<T>{
  if(entry.state!=='sending')throw new Error('only a sending outbox entry can be retried');
  if(!error.trim())throw new Error('retry error is required');
  if(!Number.isFinite(nextAttemptAt)||nextAttemptAt<0)throw new Error('nextAttemptAt is invalid');
  return {...entry,state:'retry',lastError:error.trim(),nextAttemptAt};
}

export function retryDelayMs(attempts:number,baseMs=1000,maxMs=60000):number{
  if(!Number.isSafeInteger(attempts)||attempts<1)throw new Error('attempts must be a positive safe integer');
  if(!Number.isFinite(baseMs)||baseMs<=0||!Number.isFinite(maxMs)||maxMs<baseMs)throw new Error('invalid backoff bounds');
  return Math.min(maxMs,baseMs*(2**Math.min(attempts-1,20)));
}

export function provisionalDocNo(deviceId:string,sequence:number):string{
  const device=deviceId.trim();
  if(!/^[A-Za-z0-9_-]+$/.test(device))throw new Error('deviceId must contain only letters, numbers, _ or -');
  assertSequence(sequence);
  return `T-${device}-${sequence}`;
}

export function isDefinitiveFinancialRejectionMessage(message:string):boolean{
  const normalized=message.toLowerCase();
  return [
    'insufficient stock','offline sale price changed','client_id payload mismatch',
    'not permitted','membership inactive','device revoked','device not registered',
    'shop not permitted','shop not in tenant','customer not in tenant',
    'sale requires lines','invalid sale line','payments must be an array',
    'invalid payment','payments exceed sale total','walk-in sale must be fully paid',
    'discount exceeds subtotal','negative adjustment','sale price unavailable',
  ].some(pattern=>normalized.includes(pattern));
}
