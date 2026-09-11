import { test, expect } from '@playwright/test';

const PASSWORD='TestOnly-2026!pw';
function uniqueEmail(){return `reports-${Date.now()}-${Math.floor(Math.random()*1e6)}@example.com`;}
async function createOwnerShop(page:import('@playwright/test').Page){
  await page.goto('/signup');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password',{exact:true}).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button',{name:'Sign up'}).click();
  await expect(page.getByRole('heading',{name:'Welcome'})).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Phase 6 Reports Shop');
  await page.getByRole('button',{name:'Create your shop'}).click();
  await expect(page.getByText(/DSB Pro — Admin/)).toBeVisible();
}

test('Phase 6 reports and recovery surface loads and invariant check passes',async({page})=>{
  await createOwnerShop(page);
  await page.getByRole('link',{name:'Reports & recovery'}).click();
  await expect(page.getByRole('heading',{name:'Reports & recovery'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Post expense'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Physical stock count'})).toBeVisible();
  await page.getByRole('button',{name:'Refresh'}).click();
  await expect(page.getByText('Invariant check: PASS')).toBeVisible();
  const downloadPromise=page.waitForEvent('download');
  await page.getByRole('button',{name:'Save full device backup ZIP'}).click();
  const backup=await downloadPromise;
  expect(backup.suggestedFilename()).toMatch(/^dsb-pro-full-device-backup-\d{4}-\d{2}-\d{2}\.zip$/);
  await expect(page.getByRole('status')).toContainText('one PDF per invoice');
});
