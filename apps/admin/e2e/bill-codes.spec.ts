import { stockTask, addItemForm, fillBillItem, reviewPayment } from './design-helpers';
import { test, expect } from '@playwright/test';

const PASSWORD = 'TestOnly-2026!pw';
const CODE = /[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}/;
function uniqueEmail() {
  return `billcode-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}
async function createOwnerShop(page: import('@playwright/test').Page) {
  await page.goto('/signup');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Bill Code Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/Overview/)).toBeVisible();
}

test('a purchase bill and a sale invoice get a bill code that search, copy and the receipt use', async ({
  page,
  context,
}) => {
  test.setTimeout(120000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await createOwnerShop(page);
  await page.goto('/inventory');
  await addItemForm(page);
  await page.getByPlaceholder('Item name').fill('Code Item');
  await page.getByPlaceholder('SKU', { exact: true }).fill(`CODE-${Date.now()}`);
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created Code Item' }).first(),
  ).toBeVisible();
  await stockTask(page, 'Items');
  await page.getByLabel('Item details').selectOption({ label: 'Code Item' });
  const priceForm = page.getByRole('button', { name: 'Set price' }).locator('xpath=..');
  await priceForm.locator('input[name="price"]').fill('10');
  await page.getByRole('button', { name: 'Set price' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Price history updated' }).first(),
  ).toBeVisible();

  // A purchase bill with no supplier bill no.
  await stockTask(page, 'Purchases');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase' }) });
  await fillBillItem(purchase, 1, 'Code Item', '5', '5');
  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  await expect(page.getByRole('status')).toContainText(
    'Purchase posted (1 item) and stock updated',
  );

  // The list names the bill by its code (not a raw id) and the bill view shows it with tap-to-copy.
  await page.goto('/purchases');
  const row = page.locator('main button').filter({ hasText: CODE }).first();
  await expect(row).toBeVisible();
  const purchaseCode = (await row.textContent())!.match(CODE)![0];
  await row.click();
  const chip = page.getByTestId('bill-code');
  await expect(chip).toContainText(purchaseCode);
  await chip.getByRole('button').click();
  await expect(chip).toContainText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(purchaseCode);
  await page.getByRole('button', { name: 'Close detail' }).click();

  // Bill-list search: lower case, no dash, from 4 characters; 3 characters is not a code search.
  const search = page.getByLabel('Search loaded bills');
  await search.fill(purchaseCode.replace('-', '').toLowerCase());
  await expect(page.locator('main button').filter({ hasText: purchaseCode })).toHaveCount(1);
  await search.fill('ZZZZ-ZZZZ');
  await expect(page.locator('main button').filter({ hasText: CODE })).toHaveCount(0);
  await search.fill('');

  // A sale
  await page.goto('/pos');
  await page.getByLabel('Find product').fill('Code Item');
  await expect(page.getByLabel('Item').locator('option')).toHaveCount(2);
  await page.getByLabel('Item').selectOption({ index: 1 });
  await page.getByLabel('Quantity').fill('1');
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  await reviewPayment(page);
  await page.getByLabel('Amount ₹').first().fill('10');
  await reviewPayment(page);
  await page.getByRole('button', { name: 'Finalize sale' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Sale finalized' }).first(),
  ).toBeVisible();

  await page.goto('/sales-history');
  const saleRow = page.locator('tbody tr').filter({ hasText: CODE }).first();
  await expect(saleRow).toBeVisible();
  const saleCode = (await saleRow.textContent())!.match(CODE)![0];
  expect(saleCode).not.toBe(purchaseCode);
  await page.getByLabel('Find an invoice').fill(saleCode.toLowerCase().replace('-', ''));
  await expect(page.locator('tbody tr').filter({ hasText: saleCode })).toHaveCount(1);
  await page.getByLabel('Find an invoice').fill('NOPE-9999');
  await expect(page.locator('tbody tr').filter({ hasText: CODE })).toHaveCount(0);
  await page.getByLabel('Find an invoice').fill('');
  await saleRow.getByRole('button', { name: 'View' }).click();
  await expect(page.locator('section[aria-label="Invoice detail"]')).toContainText(saleCode);
  await expect(page.getByTestId('bill-code')).toContainText(saleCode);
  await saleRow.getByRole('button', { name: /Print thermal|thermal/i }).click();
  await expect(page.getByLabel('invoice receipt')).toContainText(`Bill code ${saleCode}`);

  // Global search finds either document by a part of its code, in any case, across the dash.
  await page.goto('/search');
  const global = page.getByRole('searchbox');
  await global.fill(purchaseCode.slice(2, 7).toLowerCase());
  const purchases = page.getByRole('region', { name: 'Purchase bills' });
  await expect(purchases).toContainText(purchaseCode);
  await global.fill(saleCode.replace('-', ' '));
  const sales = page.getByRole('region', { name: 'Sale invoices' });
  await expect(sales).toContainText(saleCode);
  await global.fill('QQQ');
  await expect(page.getByRole('region', { name: 'Sale invoices' })).toHaveCount(0);
});
