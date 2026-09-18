import { test, expect } from '@playwright/test';

const PASSWORD='TestOnly-2026!pw';
function uniqueEmail(){ return `pos-${Date.now()}-${Math.floor(Math.random()*1e6)}@example.com`; }

async function createOwnerShop(page:import('@playwright/test').Page){
  await page.goto('/signup');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password',{exact:true}).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button',{name:'Sign up'}).click();
  await expect(page.getByRole('heading',{name:'Welcome'})).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('POS Smoke Shop');
  await page.getByRole('button',{name:'Create your shop'}).click();
  await expect(page.getByText(/DSB Pro — Admin/)).toBeVisible();
}

test('owner can open the Phase 4 POS and customer payment surface',async({page})=>{
  await createOwnerShop(page);
  await page.getByRole('link',{name:'Sales POS'}).click();
  await expect(page.getByRole('heading',{name:'Sales POS'})).toBeVisible();
  await expect(page.getByText('Cart is empty.')).toBeVisible();
  await expect(page.getByText(/Ctrl.*Enter.*finalizes the current sale/)).toBeVisible();
  await expect(page.getByRole('heading',{name:'Customer payment / advance'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Finalize sale'})).toBeDisabled();
});

test('real browser money path posts stock then finalizes a paid sale',async({page,context})=>{
  test.setTimeout(60000);
  await createOwnerShop(page);
  await page.getByRole('link',{name:'Inventory & purchases'}).click();
  await page.getByPlaceholder('Item name').fill('POS E2E Item');
  await page.getByPlaceholder('SKU').fill(`POS-${Date.now()}`);
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button',{name:'Create item'}).click();
  await expect(page.getByRole('status')).toContainText('Created POS E2E Item');

  await page.getByLabel('Peek item').selectOption({label:'POS E2E Item'});
  const priceForm=page.getByRole('button',{name:'Set price'}).locator('xpath=..');
  await priceForm.locator('input[name="price"]').fill('10');
  await page.getByRole('button',{name:'Set price'}).click();
  await expect(page.getByRole('status')).toContainText('Price history updated');

  const purchase=page.locator('section').filter({has:page.getByRole('heading',{name:'Post purchase'})});
  await purchase.locator('select[name="itemId"]').selectOption({label:'POS E2E Item'});
  await purchase.locator('input[name="qty"]').fill('5');
  await purchase.locator('input[name="price"]').fill('5');
  await purchase.getByRole('button',{name:'Add line'}).click();
  await purchase.getByRole('button',{name:'Post purchase'}).click();
  await expect(page.getByRole('status')).toContainText('Purchase posted (1 line) and stock updated');

  await page.goto('/pos');
  await page.getByLabel('Find product').fill('POS E2E Item');
  await expect(page.getByLabel('Item').locator('option')).toHaveCount(2);
  await page.getByLabel('Item').selectOption({index:1});
  await page.getByLabel('Quantity').fill('1');
  await page.getByRole('button',{name:'Add line'}).click();
  await expect(page.getByRole('cell',{name:/POS E2E Item/})).toBeVisible();
  await page.getByLabel('Amount ₹').first().fill('10');
  await page.getByRole('button',{name:'Finalize sale'}).click();
  await expect(page.getByRole('status')).toContainText('Sale finalized');
  await expect(page.locator('table').last()).toContainText('₹10.00');

  await page.goto('/sales-history');
  const reconciliation=page.locator('section[aria-label="Day reconciliation"]');
  await expect(reconciliation.getByRole('heading',{name:'Day reconciliation'})).toBeVisible();
  await expect(reconciliation.locator('tr').filter({hasText:'Finalized invoices'})).toContainText('1');
  await expect(reconciliation.locator('tr').filter({hasText:'Sales total'})).toContainText('₹10.00');
  await expect(reconciliation.locator('tr').filter({hasText:'All customer receipts'})).toContainText('₹10.00');
  await expect(reconciliation.locator('table').nth(1).locator('tbody td').first()).toHaveText('₹10.00');

  const businessDate=await page.getByLabel('Reconciliation business date').inputValue();
  const legacyClosingBackup={
    version:3,
    exportedAt:new Date().toISOString(),
    saleInvoices:[{
      id:'LEGACY-E2E-1',date:businessDate,customerId:'C-WALKIN',customerName:'Walk-in Customer',
      paymentType:'cash',items:[],extraCharges:[],subtotal:10,discountTotal:0,gstTotal:0,grandTotal:10,
    }],
    salePayments:[],
  };
  await page.getByLabel('Choose closing DSB backup JSON').setInputFiles({
    name:'DSB_closing_test.json',
    mimeType:'application/json',
    buffer:Buffer.from(JSON.stringify(legacyClosingBackup)),
  });
  const comparison=page.locator('[aria-label="Legacy DSB comparison result"]');
  await expect(comparison.getByRole('status')).toContainText('MATCH — Phase 4 day totals reconcile');
  await expect(comparison.locator('tbody tr').filter({hasText:'Sales total'})).toContainText('MATCH');
  await expect(comparison.locator('tbody tr').filter({hasText:'Cash'})).toContainText('MATCH');

  await page.goto('/returns');
  await expect(page.getByRole('heading',{name:'Returns',exact:true})).toBeVisible();
  await expect(page.getByLabel('Source document').locator('option')).toHaveCount(2);
  await page.getByLabel('Source document').selectOption({index:1});
  await context.setOffline(true);
  await page.getByLabel('Return quantity for POS E2E Item').fill('1');
  await page.getByRole('button',{name:'Post return'}).click();
  await expect(page.getByRole('status')).toContainText('Refund pending confirmation');
  await expect(page.getByRole('status')).toContainText('do not hand over cash');
  // The provisional document and stock overlay survive a full app restart.
  await page.reload();
  const queue=page.locator('section').filter({has:page.getByRole('heading',{name:'This till’s return queue'})});
  await expect(queue).toContainText('Refund pending confirmation — no cash payout');
  const projection=await page.evaluate(async()=>{
    const name=(await indexedDB.databases()).find(db=>db.name?.startsWith('dsb-pro-sync-'))!.name!;
    return new Promise<{stock:number;reservation:number;refund:number|null;outbox:number}>((resolve,reject)=>{
      const request=indexedDB.open(name);request.onerror=()=>reject(request.error);
      request.onsuccess=()=>{const db=request.result,tx=db.transaction(['stock','reservations','offlineReturns','outbox'],'readonly');
        const stock=tx.objectStore('stock').getAll(),reservations=tx.objectStore('reservations').getAll(),returns=tx.objectStore('offlineReturns').getAll(),outbox=tx.objectStore('outbox').count();
        tx.oncomplete=()=>{resolve({stock:stock.result[0].available,reservation:reservations.result[0].qty,refund:returns.result[0].cashRefundPaise,outbox:outbox.result});db.close();};
      };
    });
  });
  expect(projection).toEqual({stock:4,reservation:-1,refund:null,outbox:1});
  // Commit at the server, then deliberately lose its response. The retry must
  // reuse the durable intent/client ID, not create another outgoing payment.
  let lostAcknowledgement=false;
  await page.route('**/rest/v1/rpc/phase65_sync_post_return',async route=>{
    if(!lostAcknowledgement){const response=await route.fetch();expect(response.ok()).toBe(true);lostAcknowledgement=true;await context.setOffline(true);await route.abort('failed');}
    else await route.continue();
  });
  await context.setOffline(false);
  await expect.poll(()=>lostAcknowledgement).toBe(true);
  await expect(queue).toContainText('Refund pending confirmation — no cash payout');
  await context.setOffline(false);
  await page.goto('/sync');
  await page.getByRole('button',{name:'Retry queued work now'}).click();
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('0',{timeout:15000});
  await page.goto('/returns');
  await expect(page.locator('section').filter({has:page.getByRole('heading',{name:'This till’s return queue'})})).toContainText('Confirmed: ₹10.00 cash');
  const returnRow=page.locator('section').filter({has:page.getByRole('heading',{name:'Recent returns'})}).locator('tbody tr').first();
  await expect(returnRow).toContainText('₹10.00');
  await expect(returnRow).toContainText('₹10.00 cash');

  await page.goto('/sales-history');
  const afterReturn=page.locator('section[aria-label="Day reconciliation"]');
  await expect(afterReturn.locator('tr').filter({hasText:'Sale returns'})).toContainText('₹10.00');
  await expect(afterReturn.locator('tr').filter({hasText:'Net sales'})).toContainText('₹0.00');
  await expect(afterReturn.locator('table').nth(1).locator('tbody td').first()).toHaveText('₹0.00');

  // Model a stale replica: another till has already returned the whole line,
  // but this till still believes it is available. Server rejection must retain
  // the document as a conflict and undo only its provisional stock projection.
  await context.setOffline(true);
  await page.evaluate(async()=>{
    const name=(await indexedDB.databases()).find(db=>db.name?.startsWith('dsb-pro-sync-'))!.name!;
    await new Promise<void>((resolve,reject)=>{
      const request=indexedDB.open(name);request.onerror=()=>reject(request.error);
      request.onsuccess=()=>{const db=request.result,tx=db.transaction('returnSources','readwrite'),cursor=tx.objectStore('returnSources').openCursor();
        cursor.onsuccess=()=>{const row=cursor.result;if(!row)return;if(row.value.return_type==='SALE')row.update({...row.value,lines:row.value.lines.map((line:Record<string,unknown>)=>({...line,returned_qty:0}))});row.continue();};
        tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);
      };
    });
  });
  await page.goto('/returns');
  await expect(page.getByLabel('Source document').locator('option')).toHaveCount(2);
  await page.getByLabel('Source document').selectOption({index:1});
  await page.getByLabel('Return quantity for POS E2E Item').fill('1');
  await page.getByRole('button',{name:'Post return'}).click();
  await expect(page.getByRole('status')).toContainText('Refund pending confirmation');
  await context.setOffline(false);
  await expect(page.locator('section').filter({has:page.getByRole('heading',{name:'This till’s return queue'})})).toContainText('Rejected: sale return quantity exceeds sold quantity');
  await page.goto('/sync');
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('0');
  await page.goto('/inventory');
  await page.getByLabel('Peek item').selectOption({label:'POS E2E Item'});
  await expect(page.locator('[aria-label="item peek"]')).toContainText('Stock 5 piece');
  // Exercise the actual counter void path, not just the sync helper. Lose the
  // response after commit, restart offline, then replay and save reversed stock.
  let heldPull=false;let releasePull!:()=>void;
  const pullGate=new Promise<void>(resolve=>{releasePull=resolve;});
  await page.route('**/rest/v1/rpc/phase5_sync_pull',async route=>{
    if(!heldPull){heldPull=true;await pullGate;}await route.continue();
  });
  await page.goto('/returns');
  await expect.poll(()=>heldPull).toBe(true);
  let lostVoid=false;
  await page.route('**/rest/v1/rpc/phase65_sync_void_return',async route=>{
    if(!lostVoid){const response=await route.fetch();expect(response.ok()).toBe(true);lostVoid=true;await context.setOffline(true);await route.abort('failed');}
    else await route.continue();
  });
  page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'Void',exact:true}).first().click();
  await expect(page.getByText('Void confirmation pending — stock is unconfirmed.',{exact:false})).toBeVisible();
  releasePull();
  await expect.poll(()=>lostVoid).toBe(true);
  await expect(page.getByRole('alert')).toContainText('Void confirmation pending');
  await page.reload();
  const pendingVoid=await page.evaluate(async()=>{
    const name=(await indexedDB.databases()).find(db=>db.name?.startsWith('dsb-pro-sync-'))!.name!;
    return new Promise<boolean>((resolve,reject)=>{const request=indexedDB.open(name);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction('meta','readonly'),get=tx.objectStore('meta').get('pendingReturnVoid');get.onsuccess=()=>{resolve(!!get.result);db.close();};};});
  });
  expect(pendingVoid).toBe(true);
  await context.setOffline(false);await page.goto('/sync');
  await page.getByRole('button',{name:'Retry queued work now'}).click();
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('0',{timeout:15000});
  await context.setOffline(true);await page.goto('/returns');
  await expect(page.locator('section').filter({has:page.getByRole('heading',{name:'This till’s return queue'})})).toContainText('Voided — refund and stock reversed');
  const reversedStock=await page.evaluate(async()=>{
    const name=(await indexedDB.databases()).find(db=>db.name?.startsWith('dsb-pro-sync-'))!.name!;
    return new Promise<{stock:number;pending:boolean}>((resolve,reject)=>{const request=indexedDB.open(name);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction(['stock','meta'],'readonly'),stocks=tx.objectStore('stock').getAll(),pending=tx.objectStore('meta').get('pendingReturnVoid');tx.oncomplete=()=>{resolve({stock:stocks.result[0].available,pending:!!pending.result});db.close();};};});
  });
  expect(reversedStock).toEqual({stock:4,pending:false});
});
