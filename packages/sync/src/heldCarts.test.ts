import 'fake-indexeddb/auto';
import {afterEach,describe,expect,it} from 'vitest';
import {DsbSyncDb} from './db';
import {
  HELD_CART_CLAIM_LEASE_MS,claimHeldCart,completeHeldCartResume,getHeldCart,holdCart,listHeldCarts,
  releaseHeldCartClaim,resolveHeldCart,
} from './heldCarts';
import type {HeldCartRecord} from './types';

const opened:DsbSyncDb[]=[];
function db(name=crypto.randomUUID()){const value=new DsbSyncDb(`held-cart-test-${name}`);opened.push(value);return value;}
afterEach(async()=>{for(const value of opened.splice(0)){value.close();await value.delete();}});
const input={shopId:'shop-1',label:'Table 3',customerId:'customer-1',globalDiscount:'1.25',extra:'2.50',lines:[{itemId:'item-1',unitLevel:1 as const,qty:2,priceKind:'retail' as const,discountPaise:25}]};

describe('held-cart durable claims',()=>{
  it('survives close and reopen without changing its contents',async()=>{
    const name=crypto.randomUUID(),first=db(name);await first.open();const held=await holdCart(first,input);first.close();
    const reopened=db(name);await reopened.open();
    expect(await listHeldCarts(reopened,'shop-1')).toEqual([held]);
  });
  it('allows exactly one concurrent claimant without deleting the cart',async()=>{
    const value=db();await value.open();const held=await holdCart(value,input);
    const results=await Promise.allSettled([claimHeldCart(value,held.id,'token-a',1000),claimHeldCart(value,held.id,'token-b',1000)]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);
    expect(await getHeldCart(value,held.id)).toMatchObject({id:held.id,lines:held.lines});
  });
  it('recovers a stale lease and prevents its former owner from deleting',async()=>{
    const value=db();await value.open();const held=await holdCart(value,input);
    await claimHeldCart(value,held.id,'old-token',1000);
    await expect(claimHeldCart(value,held.id,'new-token',1000+HELD_CART_CLAIM_LEASE_MS-1)).rejects.toThrow(/already being resumed/);
    await expect(claimHeldCart(value,held.id,'new-token',1000+HELD_CART_CLAIM_LEASE_MS)).resolves.toMatchObject({resumeToken:'new-token'});
    expect(await releaseHeldCartClaim(value,held.id,'old-token')).toBe(false);
    await expect(completeHeldCartResume(value,held.id,'old-token')).rejects.toThrow(/claim changed/);
    expect(await completeHeldCartResume(value,held.id,'new-token')).toBe(true);
    expect(await getHeldCart(value,held.id)).toBeUndefined();
  });
  it('releases a handled failure without losing saved work',async()=>{
    const value=db();await value.open();const held=await holdCart(value,input);
    await claimHeldCart(value,held.id,'token-a',1000);
    expect(await releaseHeldCartClaim(value,held.id,'token-a')).toBe(true);
    expect(await getHeldCart(value,held.id)).toEqual(held);
  });
});

const item={id:'item-1',name:'Tea',unit1:'case',unit2:'pack',unit3:'piece'};
const record=(lines:HeldCartRecord['lines']=input.lines):HeldCartRecord=>({id:'held-1',shopId:'shop-1',createdAt:1,label:'Saved',customerId:'customer-1',globalDiscount:'1.25',extra:'2.50',lines});
const price={shop_id:'shop-1',kind:'retail',unit_level:1,price_paise:1000};
const context={shopId:'shop-1',items:[item],customerIds:new Set(['customer-1']),loadPrices:async()=>[price]};

describe('held-cart all-or-nothing resolution',()=>{
  it('preserves customer, adjustments, quantity, kind, discount and current price',async()=>{
    await expect(resolveHeldCart(record(),context)).resolves.toEqual({customerId:'customer-1',globalDiscount:'1.25',extra:'2.50',lines:[{item,unitLevel:1,qty:'2',priceKind:'retail',unitPricePaise:1000,discountPaise:25}]});
  });
  it('rejects missing item, missing price, invalid unit and failed lookup',async()=>{
    await expect(resolveHeldCart(record(),{...context,items:[]})).rejects.toThrow(/item.*no longer available/i);
    await expect(resolveHeldCart(record(),{...context,loadPrices:async()=>[]})).rejects.toThrow(/No active retail price/);
    await expect(resolveHeldCart(record([{...input.lines[0],unitLevel:3}]),{...context,items:[{...item,unit3:null}]})).rejects.toThrow(/unit.*no longer available/i);
    await expect(resolveHeldCart(record(),{...context,loadPrices:async()=>{throw new Error('lookup failed');}})).rejects.toThrow('lookup failed');
  });
  it('does not return a partial candidate when a later line is invalid',async()=>{
    const lines=[input.lines[0],{...input.lines[0],itemId:'missing'}];
    await expect(resolveHeldCart(record(lines),context)).rejects.toThrow(/item.*no longer available/i);
  });
  it('rejects wrong shop, missing customer, invalid quantity and invalid discounts',async()=>{
    await expect(resolveHeldCart({...record(),shopId:'other-shop'},context)).rejects.toThrow(/different shop/);
    await expect(resolveHeldCart(record(),{...context,customerIds:new Set()})).rejects.toThrow(/customer.*no longer available/i);
    await expect(resolveHeldCart(record([{...input.lines[0],qty:0}]),context)).rejects.toThrow(/Quantity is invalid/);
    await expect(resolveHeldCart({...record(),globalDiscount:'-1'},context)).rejects.toThrow(/Invoice discount is invalid/);
    await expect(resolveHeldCart(record([{...input.lines[0],discountPaise:0.5}]),context)).rejects.toThrow(/Line discount is invalid/);
  });
});
