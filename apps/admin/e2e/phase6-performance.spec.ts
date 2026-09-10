import {test,expect,type BrowserContext,type Page} from '@playwright/test';

const enabled=process.env.PHASE6_PERF==='1';
const EMAIL=process.env.PHASE6_PERF_EMAIL??'';
const PASSWORD=process.env.PHASE6_PERF_PASSWORD??'';
const ITEM_TARGET=10000;
const SYNC_LIMIT_MS=60_000;
const SEARCH_LIMIT_MS=300;

async function throttle3g(context:BrowserContext,page:Page){
  const cdp=await context.newCDPSession(page);
  await cdp.send('Network.enable');
  // Consistent synthetic 3G profile: 150 ms RTT, 1.6 Mbit/s down,
  // 750 Kbit/s up. This is intentionally slower than an unconstrained CI LAN
  // but fast enough to represent usable Indian 3G rather than an obsolete
  // worst-case "slow 3G" preset.
  await cdp.send('Network.emulateNetworkConditions',{
    offline:false,
    latency:150,
    downloadThroughput:(1_600*1024)/8,
    uploadThroughput:(750*1024)/8,
    connectionType:'cellular3g',
  });
}

async function itemCount(page:Page):Promise<number>{
  return page.evaluate(async()=>{
    const infos=await indexedDB.databases();
    const name=infos.map(x=>x.name).find(x=>x?.startsWith('dsb-pro-sync-'));
    if(!name)return 0;
    return await new Promise<number>((resolve,reject)=>{
      const req=indexedDB.open(name);
      req.onerror=()=>reject(req.error);
      req.onsuccess=()=>{
        const db=req.result;
        if(!db.objectStoreNames.contains('items')){db.close();resolve(0);return;}
        const tx=db.transaction('items','readonly');
        const count=tx.objectStore('items').count();
        count.onerror=()=>reject(count.error);
        count.onsuccess=()=>{const n=count.result;db.close();resolve(n);};
      };
    });
  });
}

async function loginAndFullSync(browser:import('@playwright/test').Browser,deviceId:string){
  const context=await browser.newContext();
  await context.addInitScript((id:string)=>localStorage.setItem('dsb-pro-device-id',id),deviceId);
  const page=await context.newPage();
  await throttle3g(context,page);

  const started=Date.now();
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button',{name:'Log in'}).click();
  await expect(page.getByText(/DSB Pro — Admin/)).toBeVisible({timeout:20_000});
  await expect.poll(()=>itemCount(page),{timeout:SYNC_LIMIT_MS,intervals:[250,500,1000]}).toBe(ITEM_TARGET);
  const elapsed=Date.now()-started;
  console.log(`PERF full_sync_ms device=${deviceId} value=${elapsed}`);
  expect(elapsed,`fresh-device full sync exceeded ${SYNC_LIMIT_MS} ms`).toBeLessThan(SYNC_LIMIT_MS);
  return {context,page,elapsed};
}

test.describe('Phase 6 production-scale performance gate',()=>{
  test.skip(!enabled,'Heavy Phase 6 performance gate runs only in its dedicated workflow.');
  test('10k items / 100k invoices / 3 devices under throttled 3G',async({browser})=>{
    test.setTimeout(240_000);
    expect(EMAIL).not.toBe('');
    expect(PASSWORD).not.toBe('');

    const syncTimes:number[]=[];
    let first:Awaited<ReturnType<typeof loginAndFullSync>>|null=null;
    for(let i=1;i<=3;i++){
      const result=await loginAndFullSync(browser,`phase6-perf-device-${i}`);
      syncTimes.push(result.elapsed);
      if(i===1)first=result;
      else await result.context.close();
    }

    expect(first).not.toBeNull();
    const page=first!.page;
    await page.goto('/pos');
    await expect(page.getByRole('heading',{name:'Sales POS'})).toBeVisible();
    const search=page.getByLabel('Find product');
    const startSearch=performance.now();
    await search.fill('09999');
    await expect(page.getByLabel('Item').locator('option').filter({hasText:'Performance Item 09999'})).toHaveCount(1);
    const searchMs=performance.now()-startSearch;
    console.log(`PERF billing_search_ms value=${searchMs.toFixed(1)}`);
    console.log(`PERF full_sync_all_ms values=${syncTimes.join(',')}`);
    expect(searchMs,`billing search exceeded ${SEARCH_LIMIT_MS} ms`).toBeLessThan(SEARCH_LIMIT_MS);
    await first!.context.close();
  });
});
