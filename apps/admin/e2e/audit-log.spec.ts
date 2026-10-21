import { stockTask, addItemForm } from './design-helpers';
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'TestOnly-2026!pw';
async function createOwnerShop(page: Page) {
  await page.goto('/signup');
  await page
    .getByLabel('Email')
    .fill(`audit-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Audit Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/Overview/)).toBeVisible();
}

test('owner sees price changes in the read-only audit log, filtered, with markup shown as text', async ({
  page,
}) => {
  test.setTimeout(60000);
  await createOwnerShop(page);
  await page.goto('/inventory');
  const name = 'Audit <b>Tea</b>';
  await addItemForm(page);
  await page.getByPlaceholder('Item name').fill(name);
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: `Created ${name}` })
      .first(),
  ).toBeVisible();
  await stockTask(page, 'Items');
  await page.getByLabel('Item details').selectOption({ label: name });
  const priceForm = page.getByRole('button', { name: 'Set price' }).locator('xpath=..');
  await priceForm.locator('input[name="price"]').fill('42');
  await page.getByRole('button', { name: 'Set price' }).click();

  await page.goto('/more');
  await page.getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  await page.getByLabel('Event type').selectOption({ label: 'Sale price changes' });
  const row = page.getByRole('row').filter({ hasText: 'retail price set to ₹42.00' });
  await expect(row).toBeVisible();
  await expect(row).toContainText(name);
  expect(await page.locator('table b').count()).toBe(0);
  // A type with no events says so; the log offers no way to change anything.
  await page.getByLabel('Event type').selectOption({ label: 'Sale voids' });
  await expect(page.getByText('No events match.')).toBeVisible();
  await expect(page.getByRole('button', { name: /void|delete|edit/i })).toHaveCount(0);
  await page.getByLabel('Event type').selectOption({ label: 'All events' });
  await page.getByLabel('From').fill('2999-01-01');
  await expect(page.getByText('No events match.')).toBeVisible();
});
