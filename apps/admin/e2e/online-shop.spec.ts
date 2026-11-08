import { test, expect, type Page } from '@playwright/test';
import { addItemForm } from './design-helpers';
// SF0: the owner sets up the online shop (OFF by default) and publishes an item. Nothing is public yet.
const PASSWORD = 'TestOnly-2026!pw';

async function createOwnerShop(page: Page) {
  await page.goto('/signup');
  await page
    .getByLabel('Email')
    .fill(`sf0-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Dash Super Bazar');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/Overview/)).toBeVisible();
}

test('owner saves online shop settings with delivery and publishes an item', async ({ page }) => {
  test.setTimeout(60000);
  await createOwnerShop(page);
  await page.goto('/inventory');
  await addItemForm(page);
  await page.getByPlaceholder('Item name').fill('SF0 Rice');
  await page.getByPlaceholder('Big unit (e.g. case)').fill('kg');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created SF0 Rice' }).first(),
  ).toBeVisible();

  await page.goto('/online-shop');
  await expect(page.getByRole('heading', { name: 'Online shop' })).toBeVisible();
  await expect(page.getByLabel('Shop is open online')).not.toBeChecked();
  await page.getByLabel('Shop name online').fill('Dash Super Bazar');
  await page.getByLabel('We deliver').check();
  await page.getByLabel('Delivery fee ₹').fill('30');
  await page.getByLabel('Minimum order ₹').fill('200');
  await page.getByLabel(/Delivery time slots/).fill('9-11 am\n5-7 pm');
  await page.getByRole('button', { name: 'Save online shop settings' }).click();
  await expect(page.getByText('Online shop settings saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Web address name')).toHaveValue('dash-super-bazar');
  await expect(page.getByLabel('Delivery fee ₹')).toHaveValue('30.00');

  const first = page.getByTestId('online-items').getByRole('checkbox').first();
  await expect(first).toBeVisible();
  await first.check();
  await page.getByRole('button', { name: /^Save 1 item change$/ }).click();
  await expect(page.getByText('1 item updated.')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('online-items').getByRole('checkbox').first()).toBeChecked();
});
