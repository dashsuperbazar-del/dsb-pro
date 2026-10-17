import { stockTask, addItemForm } from './design-helpers';
import { test, expect } from '@playwright/test';

const PASSWORD = 'TestOnly-2026!pw';
function uniqueEmail() {
  return `purchases-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}
async function createOwnerShop(page: import('@playwright/test').Page) {
  await page.goto('/signup');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Multi-line Purchase Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/Overview/)).toBeVisible();
}
async function createItem(page: import('@playwright/test').Page, name: string) {
  await addItemForm(page);
  await page.getByPlaceholder('Item name').fill(name);
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(page.getByRole('status')).toContainText(`Created ${name}`);
}

test('a single supplier bill can carry more than one purchase line', async ({ page }) => {
  await createOwnerShop(page);
  await page.goto('/inventory');
  await createItem(page, 'Purchase Line Item A');
  await createItem(page, 'Purchase Line Item B');

  await stockTask(page, 'Purchases');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase' }) });
  await expect(purchase.getByRole('button', { name: 'Post purchase' })).toBeDisabled();

  await purchase.locator('select[name="itemId"]').selectOption({ label: 'Purchase Line Item A' });
  await purchase.locator('input[name="qty"]').fill('4');
  await purchase.locator('input[name="price"]').fill('10');
  await purchase.getByRole('button', { name: 'Add line' }).click();
  await expect(purchase.locator('table tbody tr')).toHaveCount(1);
  // The item picker resets after each add, so a second line can target a different item.
  await purchase.locator('select[name="itemId"]').selectOption({ label: 'Purchase Line Item B' });
  await purchase.locator('input[name="qty"]').fill('6');
  await purchase.locator('input[name="price"]').fill('5');
  await purchase.getByRole('button', { name: 'Add line' }).click();
  await expect(purchase.locator('table tbody tr')).toHaveCount(2);
  await expect(purchase).toContainText('Lines total: ₹70.00');

  // A line can be dropped before posting without disturbing the other line's total.
  await purchase.getByRole('button', { name: 'Remove purchase line 1' }).click();
  await expect(purchase.locator('table tbody tr')).toHaveCount(1);
  await expect(purchase).toContainText('Lines total: ₹30.00');

  // Re-add the first line so the posted bill genuinely carries both items.
  await purchase.locator('select[name="itemId"]').selectOption({ label: 'Purchase Line Item A' });
  await purchase.locator('input[name="qty"]').fill('4');
  await purchase.locator('input[name="price"]').fill('10');
  await purchase.getByRole('button', { name: 'Add line' }).click();
  await expect(purchase.locator('table tbody tr')).toHaveCount(2);
  await expect(purchase).toContainText('Lines total: ₹70.00');

  await purchase.locator('input[name="billNo"]').fill('MULTI-1');
  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  await expect(page.getByRole('status')).toContainText(
    'Purchase posted (2 lines) and stock updated',
  );
  await expect(purchase.locator('table tbody tr')).toHaveCount(0);

  await stockTask(page, 'Items');
  await page.getByLabel('Item details').selectOption({ label: 'Purchase Line Item A' });
  await expect(page.getByLabel('item peek')).toContainText('Stock 4 piece');
  await stockTask(page, 'Items');
  await page.getByLabel('Item details').selectOption({ label: 'Purchase Line Item B' });
  await expect(page.getByLabel('item peek')).toContainText('Stock 6 piece');
});

test('a purchase whose answer is lost is retried as the same bill, never posted twice', async ({
  page,
}) => {
  await createOwnerShop(page);
  await page.goto('/inventory');
  await createItem(page, 'Retry Item');
  await stockTask(page, 'Purchases');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase' }) });
  await purchase.locator('select[name="itemId"]').selectOption({ label: 'Retry Item' });
  await purchase.locator('input[name="qty"]').fill('3');
  await purchase.locator('input[name="price"]').fill('10');
  await purchase.getByRole('button', { name: 'Add line' }).click();
  let calls = 0;
  await page.route('**/rpc/post_purchase', async (route) => {
    if (calls++ === 0) {
      await route.fetch(); // committed on the server ...
      await route.abort('connectionreset'); // ... answer lost
    } else await route.continue();
  });
  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  await expect(purchase.getByRole('alert')).toContainText('may already be saved');
  await expect(purchase.locator('input[name="qty"]')).toBeDisabled();
  // A reload keeps the frozen request: the screen still offers only the safe retry.
  await page.reload();
  await expect(purchase.getByRole('button', { name: 'Retry same purchase' })).toBeVisible();
  await purchase.getByRole('button', { name: 'Retry same purchase' }).click();
  await expect(page.getByRole('status')).toContainText('Purchase posted (1 line)');
  await stockTask(page, 'Items');
  await page.getByLabel('Item details').selectOption({ label: 'Retry Item' });
  await expect(page.getByLabel('item peek')).toContainText('Stock 3 piece');
  expect(calls).toBe(2);
});

test('a purchase line can be entered as a line total; an inexact total is shown, never silently rounded', async ({
  page,
}) => {
  await createOwnerShop(page);
  await page.goto('/inventory');
  await createItem(page, 'Total Cost Item A');
  await createItem(page, 'Total Cost Item B');

  await stockTask(page, 'Purchases');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase' }) });

  // Exact: Rs 100.00 for 4 pieces is Rs 25.00 each.
  await purchase.locator('select[name="itemId"]').selectOption({ label: 'Total Cost Item A' });
  await purchase.getByLabel('Cost entry mode').selectOption('total');
  await purchase.locator('input[name="qty"]').fill('4');
  await purchase.locator('input[name="price"]').fill('100');
  await expect(purchase.getByTestId('cost-derivation')).toContainText('₹25.00 per unit');
  await purchase.getByRole('button', { name: 'Add line' }).click();
  await expect(purchase.locator('table tbody tr')).toHaveCount(1);
  await expect(purchase).toContainText('Lines total: ₹100.00');

  // Inexact: Rs 100.00 for 3 pieces cannot be stored; the app says by how much and waits for a choice.
  await purchase.locator('select[name="itemId"]').selectOption({ label: 'Total Cost Item B' });
  await purchase.getByLabel('Cost entry mode').selectOption('total');
  await purchase.locator('input[name="qty"]').fill('3');
  await purchase.locator('input[name="price"]').fill('100');
  await expect(purchase.getByTestId('cost-derivation')).toContainText('₹0.01 less');
  await purchase.getByRole('button', { name: 'Add line' }).click();
  await expect(purchase.locator('table tbody tr')).toHaveCount(1);
  await purchase.getByRole('button', { name: /Use ₹33\.33 per unit/ }).click();
  await expect(purchase.locator('input[name="price"]')).toHaveValue('33.33');
  await purchase.getByRole('button', { name: 'Add line' }).click();
  await expect(purchase.locator('table tbody tr')).toHaveCount(2);
  await expect(purchase).toContainText('Lines total: ₹199.99');
});
