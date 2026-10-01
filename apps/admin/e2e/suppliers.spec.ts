import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'TestOnly-2026!pw';
const email = () => `suppliers-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

async function ownerWithBill(page: Page) {
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email());
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Supplier Pay Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/DSB Pro — Admin/)).toBeVisible();
  await page.getByRole('link', { name: 'Inventory & purchases' }).click();
  await page.getByPlaceholder('Supplier name').fill('Acme Traders');
  await page.getByRole('button', { name: 'Create supplier' }).click();
  await expect(page.getByRole('status')).toContainText('Created supplier Acme Traders');
  await page.getByPlaceholder('Item name').fill('Rice bag');
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(page.getByRole('status')).toContainText('Created Rice bag');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase' }) });
  await purchase.locator('select[name="partyId"]').selectOption({ label: 'Acme Traders' });
  await purchase.locator('select[name="itemId"]').selectOption({ label: 'Rice bag' });
  await purchase.locator('input[name="qty"]').fill('10');
  await purchase.locator('input[name="price"]').fill('10');
  await purchase.getByRole('button', { name: 'Add line' }).click();
  await purchase.locator('input[name="billNo"]').fill('ACME-1');
  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  await expect(page.getByRole('status')).toContainText('Purchase posted');
  await page.goto('/');
  await page.getByRole('link', { name: 'Suppliers & payments' }).click();
  await page.getByLabel('Supplier').selectOption({ label: 'Acme Traders' });
}
const bills = (page: Page) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: 'Open bills' }) });
const history = (page: Page) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: 'Payment history' }) });

async function record(page: Page, amount: string, toBill?: string) {
  if (toBill) await page.getByLabel('Allocate to ACME-1').fill(toBill);
  await page.getByLabel('Amount paid ₹').fill(amount);
  await page.getByRole('button', { name: 'Review' }).click();
  await expect(page.getByLabel('Confirm payment')).toContainText('already made');
  await page.getByRole('button', { name: 'Confirm and record' }).click();
}

test('partial bill + advance, allocate the advance, release the match, void', async ({ page }) => {
  await ownerWithBill(page);
  await expect(bills(page).locator('tbody tr')).toContainText('₹100.00');

  await record(page, '100', '40');
  await expect(page.getByRole('status')).toContainText('confirmed by the server');
  await expect(bills(page).locator('tbody tr')).toContainText('₹60.00');
  const row = history(page).locator('tbody tr').first();
  await expect(row).toContainText('₹100.00');
  await expect(row).toContainText('₹60.00'); // advance left

  const answers = ['ACME-1', '60'];
  page.on(
    'dialog',
    (d) => void d.accept(d.type() === 'prompt' ? (answers.shift() ?? 'test reason') : undefined),
  );
  await row.getByRole('button', { name: 'Allocate advance' }).click();
  await expect(page.getByRole('status')).toContainText('confirmed by the server');
  await expect(bills(page).locator('tbody tr').first().locator('td').nth(5)).toHaveText('₹0.00');

  await history(page).locator('tbody tr').first().getByRole('button', { name: 'Bills' }).click();
  await history(page).getByRole('button', { name: 'Release' }).first().click();
  await expect(page.getByRole('status')).toContainText('confirmed by the server');
  await expect(history(page).locator('tbody tr').first()).toContainText('POSTED'); // cash stays recorded

  await history(page).locator('tbody tr').first().getByRole('button', { name: 'Void' }).click();
  await expect(page.getByRole('status')).toContainText('confirmed by the server');
  await expect(history(page).locator('tbody tr').first()).toContainText('VOID');
  await expect(bills(page).locator('tbody tr').first().locator('td').nth(5)).toHaveText('₹100.00');
});

test('a response lost after commit is reconciled by request id, never recorded twice', async ({
  page,
}) => {
  await ownerWithBill(page);
  let dropped = 0;
  await page.route('**/rpc/record_supplier_payment', async (route) => {
    if (dropped++ === 0) {
      await route.fetch(); // the server commits ...
      await route.abort('connectionreset'); // ... but the answer never arrives
    } else await route.continue();
  });
  await record(page, '30');
  await expect(page.getByRole('alert').first()).toContainText('Do NOT record this payment again');
  const pending = page.getByRole('alert', { name: 'Unresolved payments' });
  await expect(pending).toContainText('UNKNOWN');
  await expect(page.getByRole('button', { name: 'Review' })).toHaveCount(0); // blocked until resolved

  await page.reload();
  await page.getByLabel('Supplier').selectOption({ label: 'Acme Traders' });
  await page.getByRole('button', { name: 'Check status' }).click();
  await expect(page.getByRole('status')).toContainText('confirmed by the server');
  await expect(history(page).locator('tbody tr')).toHaveCount(1);
  expect(dropped).toBe(1);
});

test('offline before dispatch keeps the request and sends it exactly once later', async ({
  page,
  context,
}) => {
  await ownerWithBill(page);
  let calls = 0;
  await page.route('**/rpc/record_supplier_payment', async (route) => {
    calls++;
    if (calls === 1) await route.abort('internetdisconnected');
    else await route.continue();
  });
  await record(page, '25');
  await expect(page.getByRole('alert', { name: 'Unresolved payments' })).toContainText('UNKNOWN');
  await page.getByRole('button', { name: 'Check status' }).click(); // NOT_FOUND → same id resent
  await expect(page.getByRole('status')).toContainText('confirmed by the server');
  await expect(history(page).locator('tbody tr')).toHaveCount(1);
  expect(calls).toBe(2);
  await context.clearCookies();
});
