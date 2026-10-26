import { stockTask, addItemForm, reviewPayment, fillBillItem } from './design-helpers';
import { test, expect } from '@playwright/test';
import { addByTap } from './pos-shop-setup';

const PASSWORD = 'TestOnly-2026!pw';
function uniqueEmail() {
  return `history-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}
async function createOwnerShop(page: import('@playwright/test').Page) {
  await page.goto('/signup');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Sales History Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/Overview/)).toBeVisible();
}

test('a voided sale is hidden by default, shown with Show voided, and never deleted', async ({
  page,
}) => {
  test.setTimeout(90000);
  await createOwnerShop(page);
  await page.goto('/inventory');
  await addItemForm(page);
  await page.getByPlaceholder('Item name').fill('Hide Void Item');
  await page.getByPlaceholder('SKU', { exact: true }).fill(`HV-${Date.now()}`);
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created Hide Void Item' }).first(),
  ).toBeVisible();
  await stockTask(page, 'Items');
  await page.getByLabel('Item details').selectOption({ label: 'Hide Void Item' });
  const priceForm = page.getByRole('button', { name: 'Set price' }).locator('xpath=..');
  await priceForm.locator('input[name="price"]').fill('10');
  await page.getByRole('button', { name: 'Set price' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Price history updated' }).first(),
  ).toBeVisible();
  await stockTask(page, 'Purchases');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase' }) });
  await fillBillItem(purchase, 1, 'Hide Void Item', '5', '5');
  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  await expect(page.getByRole('status')).toContainText(
    'Purchase posted (1 item) and stock updated',
  );

  await page.goto('/pos');
  await addByTap(page, 'Hide Void Item', '1');
  await reviewPayment(page);
  await page.getByLabel('Amount ₹').first().fill('10');
  await reviewPayment(page);
  await page.getByRole('button', { name: 'Finalize sale' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Sale finalized' }).first(),
  ).toBeVisible();

  await page.goto('/sales-history');
  const list = page.locator('section.card.no-print').filter({ hasText: 'Show voided' });
  await expect(list.getByRole('cell', { name: 'FINALIZED' })).toHaveCount(1);
  page.once('dialog', (d) => void d.accept());
  await list.getByRole('button', { name: 'Void sale' }).click();
  await expect(page.getByText(/voided\./).first()).toBeVisible();
  await expect(list.getByRole('cell', { name: 'VOID' })).toHaveCount(0);
  await expect(page.getByTestId('sales-list-count')).toContainText(
    'Showing 0 of 1 loaded items. 1 voided item hidden.',
  );
  await list.getByLabel('Show voided').check();
  await expect(list.getByRole('cell', { name: 'VOID' })).toHaveCount(1);
  await expect(page.getByTestId('sales-list-count')).toHaveText('Showing 1 of 1 loaded items.');
  await page.reload();
  await expect(list.getByLabel('Show voided')).toBeChecked();
  await expect(list.getByRole('button', { name: 'View' })).toBeVisible();
});

test('sales history exposes print/void surface and language scaffold', async ({ page }) => {
  await createOwnerShop(page);
  await page.getByRole('link', { name: 'Sales history' }).click();
  await expect(page.getByRole('heading', { name: 'Sales history' })).toBeVisible();
  await expect(page.getByLabel('Language')).toBeVisible();
  await page.getByLabel('Language').selectOption('hi');
  await expect(page.getByRole('heading', { name: 'बिक्री इतिहास' })).toBeVisible();
});
