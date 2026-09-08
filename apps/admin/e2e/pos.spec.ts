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

test('real browser money path posts stock then finalizes a paid sale',async({page})=>{
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
  await purchase.getByRole('button',{name:'Post purchase'}).click();
  await expect(page.getByRole('status')).toContainText('Purchase posted and stock updated');

  await page.goto('/pos');
  await page.getByLabel('Item').selectOption({label:'POS E2E Item'});
  await page.getByLabel('Quantity').fill('1');
  await page.getByRole('button',{name:'Add line'}).click();
  await expect(page.getByRole('cell',{name:/POS E2E Item/})).toBeVisible();
  await page.getByLabel('Amount ₹').first().fill('10');
  await page.getByRole('button',{name:'Finalize sale'}).click();
  await expect(page.getByRole('status')).toContainText('Sale finalized');
  await expect(page.locator('table').last()).toContainText('₹10.00');
});
