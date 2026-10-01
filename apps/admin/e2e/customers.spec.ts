import { test, expect } from '@playwright/test';

const PASSWORD = 'TestOnly-2026!pw';
function uniqueEmail() {
  return `customers-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}
async function createOwnerShop(page: import('@playwright/test').Page) {
  await page.goto('/signup');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Customer Ledger Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/DSB Pro — Admin/)).toBeVisible();
}

test('owner can open customer ledger and allocation workflow', async ({ page }) => {
  await createOwnerShop(page);
  await page.getByRole('link', { name: 'Customers & ledger' }).click();
  await expect(page.getByRole('heading', { name: 'Customers & ledger' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Customer master' })).toBeVisible();
  await page.getByLabel('Name').fill('Ledger Customer');
  await page.getByRole('button', { name: 'Create customer' }).click();
  await expect(page.getByText(/Balance ₹0.00/)).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Receive payment / allocate invoices' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Customer ledger' })).toBeVisible();
});

test('a receipt whose answer is lost after commit is reconciled, never recorded twice', async ({
  page,
}) => {
  await createOwnerShop(page);
  await page.getByRole('link', { name: 'Customers & ledger' }).click();
  await page.getByLabel('Name').fill('Receipt Customer');
  await page.getByRole('button', { name: 'Create customer' }).click();
  await expect(page.getByText(/Balance ₹0.00/)).toBeVisible();
  let calls = 0;
  await page.route('**/rpc/record_customer_payment_v2', async (route) => {
    if (calls++ === 0) {
      await route.fetch(); // the server commits ...
      await route.abort('connectionreset'); // ... but the answer is lost
    } else await route.continue();
  });
  await page.getByLabel('Amount ₹').fill('25');
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByRole('alert', { name: 'Unresolved receipts' })).toContainText('UNKNOWN');
  // A second receipt cannot be started while the first is unresolved.
  await expect(page.getByRole('button', { name: 'Record payment' })).toBeDisabled();
  await page.getByRole('button', { name: 'Check status' }).click();
  await expect(page.getByText('Receipt confirmed by the server.')).toBeVisible();
  await expect(page.getByText(/Balance -₹25.00|Balance ₹-25.00/)).toBeVisible();
  expect(calls).toBe(1);
});
