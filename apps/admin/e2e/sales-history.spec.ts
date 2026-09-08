import { test, expect } from '@playwright/test';

const PASSWORD='TestOnly-2026!pw';
function uniqueEmail(){return `history-${Date.now()}-${Math.floor(Math.random()*1e6)}@example.com`;}
async function createOwnerShop(page:import('@playwright/test').Page){
  await page.goto('/signup');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password',{exact:true}).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button',{name:'Sign up'}).click();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Sales History Shop');
  await page.getByRole('button',{name:'Create your shop'}).click();
  await expect(page.getByText(/DSB Pro — Admin/)).toBeVisible();
}

test('sales history exposes print/void surface and language scaffold',async({page})=>{
  await createOwnerShop(page);
  await page.getByRole('link',{name:'Sales history'}).click();
  await expect(page.getByRole('heading',{name:'Sales history'})).toBeVisible();
  await expect(page.getByLabel('Language')).toBeVisible();
  await page.getByLabel('Language').selectOption('hi');
  await expect(page.getByRole('heading',{name:'बिक्री इतिहास'})).toBeVisible();
});
