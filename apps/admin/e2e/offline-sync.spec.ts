import {test,expect} from '@playwright/test';

const PASSWORD='TestOnly-2026!pw';
function uniqueEmail(){return `offline-${Date.now()}-${Math.floor(Math.random()*1e6)}@example.com`;}

async function createOwnerShop(page:import('@playwright/test').Page){
  await page.goto('/signup');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password',{exact:true}).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button',{name:'Sign up'}).click();
  await expect(page.getByRole('heading',{name:'Welcome'})).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Offline Chaos Shop');
  await page.getByRole('button',{name:'Create your shop'}).click();
  await expect(page.getByText(/DSB Pro — Admin/)).toBeVisible();
}

async function seedOfflineItem(page:import('@playwright/test').Page){
  await page.getByRole('link',{name:'Inventory & purchases'}).click();
  await page.getByPlaceholder('Item name').fill('Offline E2E Item');
  await page.getByPlaceholder('SKU').fill(`OFF-${Date.now()}`);
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button',{name:'Create item'}).click();
  await expect(page.getByRole('status')).toContainText('Created Offline E2E Item');
  await page.getByLabel('Peek item').selectOption({label:'Offline E2E Item'});
  const priceForm=page.getByRole('button',{name:'Set price'}).locator('xpath=..');
  await priceForm.locator('input[name="price"]').fill('10');
  await page.getByRole('button',{name:'Set price'}).click();
  await expect(page.getByRole('status')).toContainText('Price history updated');
  const purchase=page.locator('section').filter({has:page.getByRole('heading',{name:'Post purchase'})});
  await purchase.locator('select[name="itemId"]').selectOption({label:'Offline E2E Item'});
  await purchase.locator('input[name="qty"]').fill('3');
  await purchase.locator('input[name="price"]').fill('5');
  await purchase.getByRole('button',{name:'Post purchase'}).click();
  await expect(page.getByRole('status')).toContainText('Purchase posted and stock updated');
  await page.waitForTimeout(1200);
  await page.goto('/sync');
  await page.getByRole('button',{name:'Sync now'}).click();
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('0');
}

async function addOnePaidLine(page:import('@playwright/test').Page){
  await page.getByLabel('Item').selectOption({label:'Offline E2E Item'});
  await page.getByLabel('Quantity').fill('1');
  await page.getByRole('button',{name:'Add line'}).click();
  await expect(page.locator('section').filter({has:page.getByRole('heading',{name:'2. Cart'})})).toContainText('Offline E2E Item');
  await page.getByLabel('Amount ₹').first().fill('10');
}

test('chaos: airplane mode + app restart + logical one-hour outage preserves and later syncs sales',async({page,context})=>{
  await createOwnerShop(page);
  await seedOfflineItem(page);
  await page.goto('/pos');
  await expect(page.getByRole('heading',{name:'Sales POS'})).toBeVisible();
  await page.evaluate(async()=>{
    await navigator.serviceWorker.ready;
    if(!navigator.serviceWorker.controller){
      await new Promise<void>((resolve,reject)=>{
        const timeout=window.setTimeout(()=>reject(new Error('service worker did not claim the current page')),5000);
        navigator.serviceWorker.addEventListener('controllerchange',()=>{window.clearTimeout(timeout);resolve();},{once:true});
      });
    }
    const keys=await caches.keys();
    if(!keys.some(key=>key.startsWith('dsb-pro-shell-')))throw new Error('offline app-shell cache was not created');
  });

  // Begin a real bill while online, then lose the backend before finalization.
  await addOnePaidLine(page);
  await context.setOffline(true);
  await page.getByRole('button',{name:'Finalize sale'}).click();
  await expect(page.getByRole('status')).toContainText('Saved locally as T-');
  await expect(page.locator('section[aria-label="Local offline sales"]')).toContainText('QUEUED');
  await page.getByRole('button',{name:'Print provisional'}).first().click();
  await expect(page.locator('[aria-label="provisional offline receipt"]')).toContainText('PROVISIONAL — PENDING SYNC');

  // Kill/reload the SPA while still offline. The service worker must boot the
  // app shell and IndexedDB must retain both the outbox and cached shop data.
  await page.reload({waitUntil:'domcontentloaded'});
  await expect(page.getByRole('heading',{name:'Sales POS'})).toBeVisible();
  await expect(page.locator('section[aria-label="Local offline sales"]')).toContainText('QUEUED');

  // Simulate that the backend has remained unavailable for one hour. Sync
  // retries may run, but the first queued bill must remain durable.
  await page.evaluate(()=>{
    const realNow=Date.now.bind(Date);
    Date.now=()=>realNow()+60*60*1000;
  });
  await addOnePaidLine(page);
  await page.getByRole('button',{name:'Finalize sale'}).click();
  await expect(page.getByRole('status')).toContainText('Saved locally as T-');

  // Navigate through the running SPA while still offline. This is the real
  // PWA user path; it must not depend on a new network navigation.
  await page.getByRole('link',{name:'Sync & offline'}).click();
  await expect(page.getByRole('heading',{name:'Sync & offline'})).toBeVisible();
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('2');
  await page.getByRole('button',{name:'Sync now'}).click();
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('2');

  // Network returns: ordered outbox drains, official numbering replaces the
  // two provisional identities, and no financial event is duplicated.
  await context.setOffline(false);
  await page.getByRole('button',{name:'Retry queued work now'}).click();
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('0',{timeout:15000});
  await expect(page.getByTestId('sync-queued-sales')).toHaveText('0');
  const rows=page.locator('section[aria-label="Offline sales"] tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('SYNCED');
  await expect(rows.nth(1)).toContainText('SYNCED');

  await page.goto('/sales-history');
  const reconciliation=page.locator('section[aria-label="Day reconciliation"]');
  await expect(reconciliation.locator('tr').filter({hasText:'Finalized invoices'})).toContainText('2');
  await expect(reconciliation.locator('tr').filter({hasText:'Sales total'})).toContainText('₹20.00');

  await page.goto('/inventory');
  await page.getByLabel('Peek item').selectOption({label:'Offline E2E Item'});
  await expect(page.locator('[aria-label="item peek"]')).toContainText('Stock 1 piece');
});
