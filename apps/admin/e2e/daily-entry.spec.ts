import { addItemForm, openAllScreens } from './design-helpers';
import { test, expect } from '@playwright/test';

const PASSWORD = 'TestOnly-2026!pw';
function uniqueEmail() {
  return `daily-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}
async function createOwnerShop(page: import('@playwright/test').Page) {
  await page.goto('/signup');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Daily Entry Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/Overview/)).toBeVisible();
}

test('expenses, stock adjust and the day book tile work as daily-entry screens', async ({
  page,
}) => {
  await createOwnerShop(page);
  await expect(page.getByRole('region', { name: 'Day book today' })).toContainText('Expenses');

  await openAllScreens(page);
  await page.getByRole('link', { name: 'Expenses', exact: true }).first().click();
  await page.getByLabel('Category').fill('Tea & snacks');
  await page.getByLabel('Amount ₹').fill('45.50');
  await page.getByRole('button', { name: 'Post expense' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Expense posted.' }).first(),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Expenses today' })).toContainText('45.50');

  await page.goto('/inventory');
  await addItemForm(page);
  await page.getByPlaceholder('Item name').fill('Count Item');
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created Count Item' }).first(),
  ).toBeVisible();
  await page.goto('/stock-adjust');
  await page.getByLabel('Item').selectOption({ label: 'Count Item' });
  await expect(page.getByLabel('expected stock')).toContainText('Expected 0');
  await page.getByLabel('Counted quantity (smallest unit)').fill('7');
  await page.getByLabel('Reason').selectOption('found extra');
  await page.getByRole('button', { name: 'Post stock count' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Stock adjusted' }).first(),
  ).toBeVisible();
  await expect(page.getByLabel('expected stock')).toContainText('Expected 7');

  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Day book today' })).toContainText('45.50');
});

test('phone-width screens get a bottom navigation bar', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await createOwnerShop(page);
  const nav = page.getByRole('navigation', { name: 'Quick navigation' });
  await expect(nav).toBeVisible();
  await nav.getByRole('link', { name: 'More' }).click();
  await openAllScreens(page);
  await page.getByRole('link', { name: 'Expenses', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Expenses', exact: true })).toBeVisible();
});

test('an expense whose answer is lost is retried as the same expense, never posted twice', async ({
  page,
}) => {
  await createOwnerShop(page);
  await page.goto('/expenses');
  // Install fault injection only after the bootstrap date request has settled.
  await expect(page.getByLabel('Date', { exact: true })).toHaveValue(/\d{4}-\d{2}-\d{2}/);
  let calls = 0;
  await page.route('**/rpc/post_expense', async (route) => {
    if (calls++ === 0) {
      await route.fetch();
      await route.abort('connectionreset');
    } else await route.continue();
  });
  await page.getByLabel('Category').fill('Rent');
  await page.getByLabel('Amount ₹').fill('1000');
  await page.getByRole('button', { name: 'Post expense' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Not confirmed' }).first()).toBeVisible();
  await expect(page.getByLabel('Amount ₹')).toBeDisabled();
  await page.getByRole('button', { name: 'Retry same expense' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Expense posted.' }).first(),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Expenses today' })).toContainText('1,000.00');
  expect(calls).toBe(2);
});

test('a pending expense survives a reload; a definitive rejection unlocks the form', async ({
  page,
}) => {
  await createOwnerShop(page);
  await page.goto('/expenses');
  await page.getByLabel('Category').fill('Rent');
  await page.getByLabel('Amount ₹').fill('0');
  await page.getByRole('button', { name: 'Post expense' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Not posted' }).first()).toBeVisible();
  await expect(page.getByLabel('Amount ₹')).toBeEnabled();

  let calls = 0;
  await page.route('**/rpc/post_expense', async (route) => {
    if (calls++ === 0) {
      await route.fetch();
      await route.abort('connectionreset');
    } else await route.continue();
  });
  await page.getByLabel('Amount ₹').fill('250');
  await page.getByRole('button', { name: 'Post expense' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Not confirmed' }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry same expense' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry same expense' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Expense posted.' }).first(),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Expenses today' })).toContainText('250.00');
});
