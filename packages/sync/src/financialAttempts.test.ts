import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {DsbSyncDb} from './db';
import {
  cancelAttemptDraft,copyRejectedToDraft,createAttemptDraft,freezeAttempt,getAttempt,listOpenAttempts,
  reconcileAttempt,recoverInterruptedAttempts,submitAttempt,updateAttemptDraft,
} from './financialAttempts';

const opened:DsbSyncDb[]=[];
function db(name=crypto.randomUUID()){const value=new DsbSyncDb(`attempt-test-${name}`);opened.push(value);return value;}
afterEach(async()=>{for(const value of opened.splice(0)){value.close();await value.delete();}});
const input={operation:'supplier.record.v1' as const,shopId:'shop-1',accountId:'party-1',payload:{amountPaise:'100000',allocations:[]}};

describe('financial attempts',()=>{
  it('upgrades a v4 database without losing outbox or held carts',async()=>{
    const name=`attempt-test-${crypto.randomUUID()}`;
    const v4=new Dexie(name);
    v4.version(4).stores({outbox:'&sequence,&clientId,state,nextAttemptAt,kind,target,createdAt',heldCarts:'&id,shopId,createdAt'});
    await v4.open();
    await v4.table('outbox').put({sequence:1,clientId:'c1',state:'pending',nextAttemptAt:0,kind:'sale',target:'t',createdAt:1});
    await v4.table('heldCarts').put({id:'h1',shopId:'shop-1',createdAt:1});
    v4.close();
    const v5=new DsbSyncDb(name);opened.push(v5);await v5.open();
    expect(await v5.outbox.count()).toBe(1);
    expect(await v5.heldCarts.get('h1')).toBeTruthy();
    expect(await v5.financialAttempts.count()).toBe(0);
  });
  it('edits only while DRAFT and freezes the payload at READY',async()=>{
    const v=db();await v.open();const a=await createAttemptDraft(v,input);
    await updateAttemptDraft(v,a.id,{amountPaise:'5'});
    await freezeAttempt(v,a.id);
    await expect(updateAttemptDraft(v,a.id,{amountPaise:'6'})).rejects.toThrow(/no longer be edited/);
    await expect(cancelAttemptDraft(v,a.id)).rejects.toThrow(/unsubmitted/);
    expect((await getAttempt(v,a.id))?.payload).toEqual({amountPaise:'5'});
  });
  it('never sends a DRAFT and sends a double-click exactly once',async()=>{
    const v=db();await v.open();const a=await createAttemptDraft(v,input);
    const send=vi.fn(async()=>({kind:'committed' as const,result:{paymentId:'p'}}));
    expect((await submitAttempt(v,a.id,send)).state).toBe('DRAFT');
    await freezeAttempt(v,a.id);
    const [x,y]=await Promise.all([submitAttempt(v,a.id,send),submitAttempt(v,a.id,send)]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(x.state).toBe('COMMITTED');expect(y.state).toBe('COMMITTED');
    await submitAttempt(v,a.id,send);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('maps a thrown or lost response to UNKNOWN, not a failure',async()=>{
    const v=db();await v.open();const a=await createAttemptDraft(v,input);await freezeAttempt(v,a.id);
    const r=await submitAttempt(v,a.id,async()=>{throw new Error('network down');});
    expect(r).toMatchObject({state:'UNKNOWN',errorMessage:'network down'});
  });
  it('maps SENDING to UNKNOWN on restart',async()=>{
    const v=db();await v.open();const a=await createAttemptDraft(v,input);
    await v.financialAttempts.put({...a,state:'SENDING'});
    expect(await recoverInterruptedAttempts(v)).toBe(1);
    expect((await getAttempt(v,a.id))?.state).toBe('UNKNOWN');
  });
  it('reconciles UNKNOWN by the same ID: committed, not found, or unavailable',async()=>{
    const v=db();await v.open();
    const mk=async()=>{const a=await createAttemptDraft(v,input);await v.financialAttempts.put({...a,state:'UNKNOWN'});return a.id;};
    const c=await mk(),n=await mk(),u=await mk();
    expect((await reconcileAttempt(v,c,async()=>({kind:'committed',result:{paymentId:'p'}})))).toMatchObject({state:'COMMITTED',committedResult:{paymentId:'p'}});
    expect((await reconcileAttempt(v,n,async()=>({kind:'not_found'}))).state).toBe('READY');
    expect((await reconcileAttempt(v,u,async()=>{throw new Error('permission denied');}))).toMatchObject({state:'UNKNOWN',errorMessage:'permission denied'});
    const seen:string[]=[];
    await submitAttempt(v,n,async(att)=>{seen.push(att.id);return {kind:'committed',result:{}};});
    expect(seen).toEqual([n]);
  });
  it('copies a REJECTED attempt to a new draft with a new ID',async()=>{
    const v=db();await v.open();const a=await createAttemptDraft(v,input);await freezeAttempt(v,a.id);
    await submitAttempt(v,a.id,async()=>({kind:'rejected',code:'DSB_ALLOCATION_EXCEEDS_BILL',message:'too much'}));
    const copy=await copyRejectedToDraft(v,a.id);
    expect(copy.id).not.toBe(a.id);expect(copy.state).toBe('DRAFT');expect(copy.payload).toEqual(input.payload);
    expect((await getAttempt(v,a.id))?.state).toBe('REJECTED');
  });
  it('lists unresolved attempts per shop and account',async()=>{
    const v=db();await v.open();
    const a=await createAttemptDraft(v,input);await freezeAttempt(v,a.id);
    await createAttemptDraft(v,{...input,accountId:'party-2'});
    expect((await listOpenAttempts(v,'shop-1','party-1')).map(r=>r.id)).toEqual([a.id]);
    expect(await listOpenAttempts(v,'shop-2')).toEqual([]);
  });
});
describe('cross-tab recovery',()=>{
  it('lets the sending tab finalize an attempt another tab marked UNKNOWN',async()=>{
    const v=db();await v.open();const a=await createAttemptDraft(v,input);await freezeAttempt(v,a.id);
    const r=await submitAttempt(v,a.id,async()=>{await v.financialAttempts.update(a.id,{state:'UNKNOWN'});return {kind:'committed',result:{paymentId:'p'}};});
    expect(r.state).toBe('COMMITTED');
  });
});
