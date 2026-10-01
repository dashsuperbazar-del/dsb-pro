// R1 shadow-run kit: the compare page shows the day's totals, balances and stock, and exports CSV.
import { test, expect } from '@playwright/test';

const PASSWORD = 'TestOnly-2026!pw';
const email = () => `compare-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

test('compare page shows day totals, supplier balance and stock, and exports CSV', async ({
  page,
}) => {
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email());
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Compare Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/DSB Pro — Admin/)).toBeVisible();

  await page.getByRole('link', { name: 'Inventory & purchases' }).click();
  await page.getByPlaceholder('Supplier name').fill('Compare Traders');
  await page.getByRole('button', { name: 'Create supplier' }).click();
  await expect(page.getByRole('status')).toContainText('Created supplier Compare Traders');
  await page.getByPlaceholder('Item name').fill('Compare Item');
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(page.getByRole('status')).toContainText('Created Compare Item');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase' }) });
  await purchase.locator('select[name="partyId"]').selectOption({ label: 'Compare Traders' });
  await purchase.locator('select[name="itemId"]').selectOption({ label: 'Compare Item' });
  await purchase.locator('input[name="qty"]').fill('12');
  await purchase.locator('input[name="price"]').fill('10');
  await purchase.getByRole('button', { name: 'Add line' }).click();
  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  await expect(page.getByRole('status')).toContainText('Purchase posted');

  await page.goto('/expenses');
  await page.getByLabel('Category').fill('Rent');
  await page.getByLabel('Amount ₹').fill('75');
  await page.getByRole('button', { name: 'Post expense' }).click();
  await expect(page.getByRole('status')).toContainText('Expense posted.');

  await page.goto('/reports');
  await page.getByRole('link', { name: 'Compare with old DSB' }).click();
  const day = page.getByRole('region', { name: 'Day totals' });
  await expect(day.locator('tr').filter({ hasText: 'Purchases' })).toContainText('₹120.00');
  await expect(day.locator('tr').filter({ hasText: 'Expenses' })).toContainText('₹75.00');
  const suppliers = page.getByRole('region', { name: 'Supplier balances' });
  await expect(suppliers.locator('tr').filter({ hasText: 'Compare Traders' })).toContainText(
    '₹120.00',
  );
  const stock = page.getByRole('region', { name: 'Item stock' });
  await expect(stock.locator('tr').filter({ hasText: 'Compare Item' })).toContainText('12');

  const download = page.waitForEvent('download');
  await suppliers.getByRole('button', { name: 'CSV' }).click();
  const file = await download;
  const text = await (await file.createReadStream()).toArray();
  expect(Buffer.concat(text).toString()).toContain('Compare Traders,120.00,120.00,0.00,0.00,0.00');
});
