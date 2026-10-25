import { addItemForm, fillBillItem, reviewPayment, stockTask } from './design-helpers';
import { test, expect } from '@playwright/test';

// 0067 remarks: pending remarks on a purchase bill and a sale invoice (add, settle, reopen, history), the
// Pending badge and filter on both lists, and the Home tile.
const PASSWORD = 'TestOnly-2026!pw';

test('remarks on a purchase bill and a sale invoice: add, settle, reopen, badges, filters, Home tile', async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.goto('/signup');
  await page
    .getByLabel('Email')
    .fill(`remarks-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Remarks Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/Overview/)).toBeVisible();

  await page.goto('/inventory');
  await addItemForm(page);
  await page.getByPlaceholder('Item name').fill('Remark Rice');
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created Remark Rice' }).first(),
  ).toBeVisible();
  await stockTask(page, 'Items');
  await page.getByLabel('Item details').selectOption({ label: 'Remark Rice' });
  const priceForm = page.getByRole('button', { name: 'Set price' }).locator('xpath=..');
  await priceForm.locator('input[name="price"]').fill('10');
  await page.getByRole('button', { name: 'Set price' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Price history updated' }).first(),
  ).toBeVisible();

  // Purchase bill from a new supplier.
  await page.goto('/purchases?new=1');
  const post = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase', exact: true }) })
    .last();
  await expect(post.locator('input[name="date"]')).not.toHaveValue('');
  const supplier = page
    .getByRole('button', { name: 'Create & select supplier' })
    .locator('xpath=..');
  await page.getByText('Add a supplier', { exact: true }).click();
  await supplier.getByPlaceholder('New supplier name').fill('Remark Supplier');
  await supplier.getByRole('button', { name: 'Create & select supplier' }).click();
  await expect(post.locator('select[name="partyId"]')).toHaveValue(/.+/);
  await post.locator('input[name="billNo"]').fill('REM-1');
  await fillBillItem(post, 1, 'Remark Rice', '5', '10');
  await post.getByRole('button', { name: 'Post purchase', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Purchase posted (1 item)' }).first(),
  ).toBeVisible();

  // Add a remark on the bill.
  await page.goto('/purchases');
  await page.getByRole('button', { name: /Remark Supplier.*REM-1/ }).click();
  const detail = page.getByLabel('Purchase detail');
  const box = detail.getByLabel('Pending remarks');
  await expect(box.getByText('No pending items noted on this bill.')).toBeVisible();
  await box.getByLabel('New remark').fill('2 items still to come <b>next trip</b>');
  await box.getByRole('button', { name: 'Add remark' }).click();
  const remark = box.getByTestId('remark');
  await expect(remark).toContainText('2 items still to come <b>next trip</b>');
  await expect(remark).toContainText('Pending');
  await expect(remark.locator('b')).toHaveCount(0);

  // Pending badge and filter on the list.
  await page.goto('/purchases');
  await expect(page.getByTestId('list-pending')).toHaveCount(1);
  await page.getByLabel('Status').selectOption('pending');
  await expect(page.getByRole('button', { name: /REM-1/ })).toBeVisible();

  // Home tile lists it and opens the bill.
  await page.goto('/');
  const tile = page.getByLabel('Pending items');
  await expect(tile.getByTestId('open-remark')).toContainText('REM-1');
  // D1: the Home tile is a collapsed row; expand it first (layout only).
  await tile.getByRole('button', { name: /^Pending items/ }).click();
  await tile.getByRole('link', { name: /REM-1/ }).click();
  await expect(page.getByLabel('Purchase detail')).toBeVisible();

  // Settle, then reopen (owner), with history.
  const box2 = page.getByLabel('Purchase detail').getByLabel('Pending remarks');
  await box2.getByRole('button', { name: 'Mark settled' }).click();
  await expect(box2.getByText('Settled (1)')).toBeVisible();
  await box2.getByText('Settled (1)').click();
  await box2.getByRole('button', { name: 'Reopen' }).click();
  await expect(box2.getByTestId('remark')).toHaveAttribute('data-status', 'OPEN');
  await box2.getByRole('button', { name: 'History' }).click();
  await expect(box2.getByLabel('Remark history').locator('li')).toHaveCount(3);

  // Sale invoice: sell one and remark on it.
  await page.goto('/pos');
  await page.getByLabel('Find product').fill('Remark Rice');
  await expect(page.getByLabel('Item').locator('option')).toHaveCount(2);
  await page.getByLabel('Item').selectOption({ index: 1 });
  await page.getByLabel('Quantity').fill('1');
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  await reviewPayment(page);
  await page.getByLabel('Amount ₹').first().fill('10');
  await reviewPayment(page);
  await page.getByRole('button', { name: 'Finalize sale' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Sale finalized' }).first(),
  ).toBeVisible();

  await page.goto('/sales-history');
  await page.getByRole('button', { name: 'View' }).first().click();
  const sale = page.getByLabel('Invoice detail').getByLabel('Pending remarks');
  await sale.getByLabel('New remark').fill('Customer collects 1 item tomorrow');
  await sale.getByRole('button', { name: 'Add remark' }).click();
  await expect(sale.getByTestId('remark')).toContainText('Customer collects 1 item tomorrow');
  await expect(page.getByTestId('sale-pending')).toHaveCount(1);
  await page.getByLabel('Only invoices with pending items').check();
  await expect(page.getByTestId('sale-pending')).toHaveCount(1);
  await sale.getByRole('button', { name: 'Mark settled' }).click();
  await expect(sale.getByText('Settled (1)')).toBeVisible();
  await expect(page.getByTestId('sale-pending')).toHaveCount(0);
});
