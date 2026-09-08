import { test, expect } from '@playwright/test';

const PASSWORD='TestOnly-2026!pw';
function uniqueEmail(){return `customers-${Date.now()}-${Math.floor(Math.random()*1e6)}@example.com`;}
async function createOwnerShop(page:import('@playwright/test').Page){
  await page.goto('/signup');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password',{exact:true}).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button',{name:'Sign up'}).click();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Customer Ledger Shop');
  await page.getByRole('button',{name:'Create your shop'}).click();
  await expect(page.getByText(/DSB Pro — Admin/)).toBeVisible();
}

test('owner can open customer ledger and allocation workflow',async({page})=>{
  await createOwnerShop(page);
  await page.getByRole('link',{name:'Customers & ledger'}).click();
  await expect(page.getByRole('heading',{name:'Customers & ledger'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Customer master'})).toBeVisible();
  await page.getByLabel('Name').fill('Ledger Customer');
  await page.getByRole('button',{name:'Create customer'}).click();
  await expect(page.getByText(/Balance ₹0.00/)).toBeVisible();
  await expect(page.getByRole('heading',{name:'Receive payment / allocate invoices'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Customer ledger'})).toBeVisible();
});
