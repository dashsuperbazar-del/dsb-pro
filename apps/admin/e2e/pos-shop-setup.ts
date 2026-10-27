import { expect, type Page } from '@playwright/test';
import { addItemForm, stockTask, fillBillItem } from './design-helpers';
// A fresh owner + shop with one item (Basmati rice 1kg, ₹1,200 retail, 40 in stock) and a supplier, ready
// for POS sales. Used by the D4 POS specs.
const PASSWORD = 'TestOnly-2026!pw';
const purchaseSection = (page: Page) =>
  page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase', exact: true }) })
    .last();

export async function setupPosShop(page: Page, tag = 'pos') {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/signup');
  await page.getByLabel('Email').fill(`${tag}-${Date.now()}-${Math.random()}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Dash Super Bazar');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.goto('/inventory');
  await addItemForm(page);
  await page.getByPlaceholder('Item name').fill('Basmati rice 1kg');
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Created' }).first()).toBeVisible();
  await page.getByLabel('Item details').selectOption({ label: 'Basmati rice 1kg' });
  const price = page.getByRole('button', { name: 'Set price' }).locator('xpath=..');
  await price.locator('input[name="price"]').fill('1200');
  await page.getByRole('button', { name: 'Set price' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Price history updated' }).first(),
  ).toBeVisible();
  await stockTask(page, 'Suppliers');
  await page.getByPlaceholder('Supplier name', { exact: true }).fill('Sharma Traders');
  await page.getByRole('button', { name: 'Create supplier', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created supplier' }).first(),
  ).toBeVisible();
  await page.goto('/purchases?new=1');
  const purchase = purchaseSection(page);
  await expect(purchase).toHaveAttribute('data-purchase-ready', 'true');
  await purchase.locator('input[name="billNo"]').fill('D4-STOCK');
  await purchase.locator('select[name="partyId"]').selectOption({ label: 'Sharma Traders' });
  await fillBillItem(purchase, 1, 'Basmati rice 1kg', '40', '950');
  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Purchase posted' }).first(),
  ).toBeVisible();
}

export async function addToCart(page: Page, qty: string) {
  await addByTap(page, 'Basmati rice 1kg', qty);
}

/** D4b: add an item the way the owner does now - search, then tap its row (qty 1); a bigger qty is typed in the cart. */
export async function addByTap(page: Page, name: string, qty = '1') {
  await page.getByLabel('Find product').fill(name);
  await page.getByRole('button', { name: `Add ${name}`, exact: true }).click();
  // The line appears, or (no list price) the owner is asked for a price / a cashier is told.
  await expect(
    page.locator('.pos-cart, .price-prompt, [role="alert"]').filter({ hasText: name }).first(),
  ).toBeVisible();
  if (qty !== '1') await page.getByLabel(`Cart qty for ${name}`).first().fill(qty);
}
export async function toPayment(page: Page) {
  if (!(await page.locator('#pos-payment').isVisible()))
    await page.getByRole('button', { name: 'Review payment →', exact: true }).click();
  await expect(page.locator('#pos-payment')).toBeVisible();
}
