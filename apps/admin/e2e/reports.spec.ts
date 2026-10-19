import { stockTask, addItemForm, reviewPayment, fillBillItem } from './design-helpers';
import { test, expect } from '@playwright/test';

const PASSWORD = 'TestOnly-2026!pw';
function uniqueEmail() {
  return `reports-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}
async function createOwnerShop(page: import('@playwright/test').Page) {
  await page.goto('/signup');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Phase 6 Reports Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/Overview/)).toBeVisible();
}

test('Phase 6 reports and recovery surface loads and invariant check passes', async ({ page }) => {
  await createOwnerShop(page);
  // D4a: healthy diagnostics can collapse; attention states open automatically.
  const healthSummary = page.locator('.health-summary');
  // Wait for all health requests before deciding whether a click should open it.
  await expect(healthSummary.locator('summary').first()).not.toContainText('Checking…');
  if ((await healthSummary.getAttribute('open')) === null)
    await healthSummary.locator('summary').first().click();
  await expect(healthSummary).toHaveAttribute('open', '');
  // The health panel lists every server check and when it ran.
  await expect(page.getByTestId('invariants-status')).toContainText(
    /PASS · checked .* · \d+ checks/,
  );
  await page.getByText('View financial checks', { exact: true }).click();
  await expect(page.getByRole('list', { name: 'Invariant checks' })).toContainText(
    'Opening settlements: 0',
  );
  await page.getByRole('link', { name: 'Reports & recovery' }).click();
  await expect(page.getByRole('heading', { name: 'Reports & recovery' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Daily entry' })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText('Invariant check: PASS')).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page
    .getByRole('navigation', { name: 'Report categories' })
    .getByRole('button', { name: 'Recovery', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save full device backup ZIP' }).click();
  const backup = await downloadPromise;
  expect(backup.suggestedFilename()).toMatch(/^dsb-pro-full-device-backup-\d{4}-\d{2}-\d{2}\.zip$/);
  await expect(
    page.getByRole('status').filter({ hasText: 'one PDF per invoice' }).first(),
  ).toBeVisible();
});

test('the missing reports show real low stock, item-wise sales, purchase register and customer aging data', async ({
  page,
}) => {
  test.setTimeout(60000);
  await createOwnerShop(page);
  await page.goto('/inventory');
  await addItemForm(page);
  await page.getByPlaceholder('Item name').fill('Reports E2E Item');
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created Reports E2E Item' }).first(),
  ).toBeVisible();
  await stockTask(page, 'Items');
  await page.getByLabel('Item details').selectOption({ label: 'Reports E2E Item' });

  // The reorder threshold has never been settable from the UI before this.
  await page.getByLabel('Reorder threshold').fill('5');
  await page.getByRole('button', { name: 'Save reorder threshold' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Reorder threshold saved' }).first(),
  ).toBeVisible();

  const priceForm = page.getByRole('button', { name: 'Set price' }).locator('xpath=..');
  await priceForm.locator('input[name="price"]').fill('10');
  await page.getByRole('button', { name: 'Set price' }).click();

  await stockTask(page, 'Purchases');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase' }) });
  await purchase.locator('input[name="billNo"]').fill('RPT-BILL-1');
  await fillBillItem(purchase, 1, 'Reports E2E Item', '10', '5');
  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  await expect(page.getByRole('status')).toContainText(
    'Purchase posted (1 item) and stock updated',
  );

  // Sell 8 of the 10 in stock: on_hand becomes 2, at or below the 5 threshold.
  await page.goto('/pos');
  await page.getByLabel('Find product').fill('Reports E2E Item');
  await expect(page.getByLabel('Item').locator('option')).toHaveCount(2);
  await page.getByLabel('Item').selectOption({ index: 1 });
  await page.getByLabel('Quantity').fill('8');
  await page.getByRole('button', { name: 'Add line' }).click();
  await reviewPayment(page);
  await page.getByLabel('Amount ₹').first().fill('80');
  await reviewPayment(page);
  await page.getByRole('button', { name: 'Finalize sale' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Sale finalized' }).first(),
  ).toBeVisible();

  // A credit sale to a real customer, left unpaid, feeds customer aging.
  await page.getByLabel('Find product').fill('Reports E2E Item');
  await page.getByLabel('Item').selectOption({ index: 1 });
  await page.getByLabel('Quantity').fill('1');
  await page.getByRole('button', { name: 'Add line' }).click();
  await reviewPayment(page);
  await page.getByText('Add a new customer', { exact: true }).click();
  await page.getByLabel('Quick customer').fill('Aging E2E Customer');
  await page.getByRole('button', { name: 'Create & select' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Aging E2E Customer created' }).first(),
  ).toBeVisible();
  await reviewPayment(page);
  await page.getByRole('button', { name: 'Finalize sale' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Sale finalized' }).first(),
  ).toBeVisible();

  await page.goto('/reports');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText('Invariant check: PASS')).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Report categories' })
    .getByRole('button', { name: 'Stock', exact: true })
    .click();
  const lowStock = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Low stock / reorder' }) });
  await expect(lowStock).toContainText('Reports E2E Item');
  await expect(lowStock.locator('tbody tr')).toHaveCount(1);

  await page
    .getByRole('navigation', { name: 'Report categories' })
    .getByRole('button', { name: 'Sales', exact: true })
    .click();
  const itemSales = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Item-wise sales' }) });
  const salesRow = itemSales.locator('tr').filter({ hasText: 'Reports E2E Item' });
  await expect(salesRow).toContainText('9'); // 8 + 1, both sales in the default From..To range
  await expect(salesRow).toContainText('₹90.00');

  await page
    .getByRole('navigation', { name: 'Report categories' })
    .getByRole('button', { name: 'Purchases', exact: true })
    .click();
  const purchaseRegister = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Purchase register' }) });
  await expect(purchaseRegister).toContainText('RPT-BILL-1');
  await expect(purchaseRegister).toContainText('₹50.00');
  await expect(purchaseRegister).toContainText('POSTED');

  await page
    .getByRole('navigation', { name: 'Report categories' })
    .getByRole('button', { name: 'Outstanding', exact: true })
    .click();
  const aging = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Customer outstanding (as of the To date)' }),
  });
  await expect(aging).toContainText('Aging E2E Customer');
  // 0 days, open bills and net balance all equal the unpaid ₹10.00 bill (D1-lite as-of report).
  await expect(aging.locator('tr').filter({ hasText: 'Aging E2E Customer' })).toContainText(
    '₹10.00',
  );
  // The supplier report loads through PostgREST too (the purchase had no supplier, so no rows).
  const supplierAging = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Supplier outstanding (as of the To date)' }),
  });
  await expect(supplierAging).toContainText('No balances.');
});
