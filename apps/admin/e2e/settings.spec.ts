import { test, expect } from '@playwright/test';

const PASSWORD='TestOnly-2026!pw';
function uniqueEmail(){return `settings-${Date.now()}-${Math.floor(Math.random()*1e6)}@example.com`;}
async function createOwnerShop(page:import('@playwright/test').Page){
  await page.goto('/signup');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password',{exact:true}).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button',{name:'Sign up'}).click();
  await expect(page.getByRole('heading',{name:'Welcome'})).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Settings Screen Shop');
  await page.getByRole('button',{name:'Create your shop'}).click();
  await expect(page.getByText(/DSB Pro — Admin/)).toBeVisible();
}

test('owner can edit shop profile and it survives a reload, and the invoice prefix reaches a real sale',async({page})=>{
  await createOwnerShop(page);
  await page.getByRole('link',{name:'Settings'}).click();
  await expect(page.getByRole('heading',{name:'Settings'})).toBeVisible();
  await expect(page.getByLabel('Shop name')).toHaveValue('Settings Screen Shop');
  await expect(page.getByLabel('Printer width')).toHaveValue('80mm');
  await expect(page.getByLabel('Allow selling below zero stock')).not.toBeChecked();

  await page.getByLabel('Shop name').fill('Renamed Corner Store');
  await page.getByLabel('Address').fill('12 Market Road');
  await page.getByLabel('GSTIN').fill('27ABCDE1234F1Z5');
  await page.getByLabel('Invoice prefix').fill('RCS');
  await page.getByLabel('Printer width').selectOption('58mm');
  await page.getByLabel('Fiscal year starts').selectOption('4');
  await page.getByLabel('Allow selling below zero stock').check();
  await page.getByRole('button',{name:'Save shop profile'}).click();
  await expect(page.getByRole('status')).toContainText('Shop settings saved');

  await page.reload();
  await expect(page.getByLabel('Shop name')).toHaveValue('Renamed Corner Store');
  await expect(page.getByLabel('Address')).toHaveValue('12 Market Road');
  await expect(page.getByLabel('GSTIN')).toHaveValue('27ABCDE1234F1Z5');
  await expect(page.getByLabel('Invoice prefix')).toHaveValue('RCS');
  await expect(page.getByLabel('Printer width')).toHaveValue('58mm');
  await expect(page.getByLabel('Allow selling below zero stock')).toBeChecked();

  // The renamed shop's own invoice prefix must show up on a real posted sale's doc number.
  await page.goto('/inventory');
  await page.getByPlaceholder('Item name').fill('Settings E2E Item');
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button',{name:'Create item'}).click();
  await expect(page.getByRole('status')).toContainText('Created Settings E2E Item');
  await page.getByLabel('Peek item').selectOption({label:'Settings E2E Item'});
  const priceForm=page.getByRole('button',{name:'Set price'}).locator('xpath=..');
  await priceForm.locator('input[name="price"]').fill('10');
  await page.getByRole('button',{name:'Set price'}).click();
  const purchase=page.locator('section').filter({has:page.getByRole('heading',{name:'Post purchase'})});
  await purchase.locator('select[name="itemId"]').selectOption({label:'Settings E2E Item'});
  await purchase.locator('input[name="qty"]').fill('5');
  await purchase.locator('input[name="price"]').fill('5');
  await purchase.getByRole('button',{name:'Add line'}).click();
  await purchase.getByRole('button',{name:'Post purchase'}).click();
  await expect(page.getByRole('status')).toContainText('Purchase posted (1 line) and stock updated');
  await page.goto('/pos');
  await page.getByLabel('Find product').fill('Settings E2E Item');
  await expect(page.getByLabel('Item').locator('option')).toHaveCount(2);
  await page.getByLabel('Item').selectOption({index:1});
  // Only 5 are in stock. Sell 6 to prove the override set above actually
  // reaches post_sale(), not just that the checkbox itself saves.
  await page.getByLabel('Quantity').fill('6');
  await page.getByRole('button',{name:'Add line'}).click();
  await page.getByLabel('Amount ₹').first().fill('60');
  await page.getByRole('button',{name:'Finalize sale'}).click();
  await expect(page.getByRole('status')).toContainText(/Sale finalized.*RCS-/);
  await page.goto('/inventory');
  await page.getByLabel('Peek item').selectOption({label:'Settings E2E Item'});
  await expect(page.getByLabel('item peek')).toContainText('Stock -1 piece');
});
