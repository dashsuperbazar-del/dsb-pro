import { test, expect } from '@playwright/test';

const PASSWORD='TestOnly-2026!pw';
function uniqueEmail(){ return `legacy-import-${Date.now()}-${Math.floor(Math.random()*1e6)}@example.com`; }

async function createOwnerShop(page:import('@playwright/test').Page){
  await page.goto('/signup');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password',{exact:true}).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button',{name:'Sign up'}).click();
  await expect(page.getByRole('heading',{name:'Welcome'})).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Legacy Import Shop');
  await page.getByRole('button',{name:'Create your shop'}).click();
  await expect(page.getByText(/DSB Pro — Admin/)).toBeVisible();
}

test('owner can import a legacy DSB backup into an empty shop and sell imported stock',async({page})=>{
  await createOwnerShop(page);
  await page.getByRole('link',{name:'Inventory & purchases'}).click();

  const backup={
    version:3,
    exportedAt:'2026-09-08T17:07:18.601Z',
    parties:[{id:'P1',name:'Legacy Supplier',phone:'111'}],
    customers:[{id:'C0',name:'Walk-in Customer'},{id:'C1',name:'Santosh',phone:'222'}],
    items:[{
      id:'I1',name:'Imported Biscuit',unit1:'Ctn',unit2:'Pcs',unit3:'',conv1:12,conv2:1,gst:0,
      retail:10,wholesale:100,wholesaleQty:12,wholesaleSale:108,stock:1,priceUnit:'2',isActive:true,
    }],
  };
  await page.getByLabel('Choose DSB backup JSON').setInputFiles({
    name:'DSB_backup_test.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup)),
  });
  await expect(page.getByText(/Ready: 1 items · 1 suppliers · 1 customers/)).toBeVisible();

  page.once('dialog',d=>d.accept());
  await page.getByRole('button',{name:'Import checked backup'}).click();
  await expect(page.getByRole('status')).toContainText('Import complete: 1 items, 1 suppliers, 1 customers');

  await page.getByLabel('Peek item').selectOption({label:'Imported Biscuit'});
  await expect(page.getByLabel('item peek')).toContainText('Stock 12 Pcs');

  await page.goto('/pos');
  await page.getByLabel('Item').selectOption({label:'Imported Biscuit'});
  await page.getByLabel('Quantity').fill('1');
  await page.getByRole('button',{name:'Add line'}).click();
  await expect(page.getByRole('cell',{name:/Imported Biscuit/})).toBeVisible();
  await page.getByLabel('Amount ₹').first().fill('10');
  await page.getByRole('button',{name:'Finalize sale'}).click();
  await expect(page.getByRole('status')).toContainText('Sale finalized');
});
