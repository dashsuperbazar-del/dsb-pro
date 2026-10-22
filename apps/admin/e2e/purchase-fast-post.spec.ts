import { stockTask, addItemForm, fillBillItem } from './design-helpers';
import { test, expect } from '@playwright/test';

// A confirmed bill frees the form at once; the stock reload that follows may be slow and finishes later.
const PASSWORD = 'TestOnly-2026!pw';
function uniqueEmail() {
  return `fastpost-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

test('Post is free and the bill is announced while the stock reload is still held back; stock is right once it ends', async ({
  page,
}) => {
  await page.goto('/signup');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Fast Post Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/Overview/)).toBeVisible();
  await page.goto('/inventory');
  await addItemForm(page);
  await page.getByPlaceholder('Item name').fill('Fast Item');
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created Fast Item' }).first(),
  ).toBeVisible();

  await stockTask(page, 'Purchases');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase' }) });
  await fillBillItem(purchase, 1, 'Fast Item', '4', '10');

  // Hold back the stock reload that follows the post (the bill post itself is not delayed).
  let holding = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let heldReads = 0;
  await page.route(/\/rest\/v1\/stock_current/, async (route) => {
    if (holding && route.request().method() === 'GET') {
      heldReads++;
      await gate;
    }
    await route.continue();
  });
  holding = true;
  await purchase.getByRole('button', { name: 'Post purchase' }).click();

  const status = page.getByRole('status').filter({ hasText: 'Purchase posted' });
  await expect(status).toContainText('Purchase posted (1 item). Updating stock…');
  await expect.poll(() => heldReads).toBeGreaterThan(0);
  await expect(status).not.toContainText('and stock updated');
  // The form is free: it is cleared, not stuck on "Posting…", and the next bill can be started and posted.
  await expect(purchase.getByRole('button', { name: 'Posting…' })).toHaveCount(0);
  await expect(purchase.getByLabel('Item 1 name', { exact: true })).toHaveValue('');
  await fillBillItem(purchase, 1, 'Fast Item', '1', '10');
  await expect(purchase.getByRole('button', { name: 'Post purchase' })).toBeEnabled();

  release();
  await expect(status).toContainText('Purchase posted (1 item) and stock updated.');
  await expect(status).not.toContainText('Updating stock');

  await stockTask(page, 'Items');
  await page.getByLabel('Item details').selectOption({ label: 'Fast Item' });
  await expect(page.getByLabel('item peek')).toContainText('Stock 4 piece');
});
