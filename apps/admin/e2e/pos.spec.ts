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
  await expect(page.getByRole('heading',{name:'Customer payment / advance'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Finalize sale'})).toBeDisabled();
});
