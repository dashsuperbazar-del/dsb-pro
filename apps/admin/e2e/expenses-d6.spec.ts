import { test, expect } from '@playwright/test';
import { setupPosShop } from './pos-shop-setup';
// D6: Expenses shows a money-first total and a collapsible "Recent expenses" read from the expenses
// table (RLS: own shop, POST_EXPENSES / VIEW_REPORTS). A failed read leaves only the list out.

test('recent expenses lists a just-posted expense; a failed read leaves the list out', async ({
  page,
}) => {
  test.setTimeout(180000);
  await setupPosShop(page, 'd6ex');
  await page.goto('/expenses');
  await page.getByLabel('Category').fill('Rent');
  await page.getByLabel('Description').fill('October shop rent');
  await page.getByLabel('Amount ₹').fill('12500');
  await page.getByRole('button', { name: 'Post expense' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Expense posted' })).toBeVisible();
  await expect(page.getByTestId('expenses-today-total')).toHaveText('₹12,500.00');
  const recent = page.getByRole('region', { name: 'Expenses today' });
  const toggle = recent.getByRole('button', { name: /Recent expenses/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(recent.getByRole('list', { name: 'Latest expenses' })).toContainText(
    'October shop rent',
  );
  await expect(recent.getByRole('list', { name: 'Latest expenses' })).toContainText('₹12,500.00');

  // The expenses table read fails: no list, but the total, the row and the form still work.
  await page.route('**/rest/v1/expenses*', (route) => route.abort());
  await page.reload();
  await expect(page.getByTestId('expenses-today-total')).toHaveText('₹12,500.00');
  const again = page.getByRole('region', { name: 'Expenses today' });
  await again.getByRole('button', { name: /Recent expenses/ }).click();
  await expect(again.getByRole('list', { name: 'Latest expenses' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Post expense' })).toBeEnabled();
  await expect(page.getByLabel('Category')).toBeVisible();
});
