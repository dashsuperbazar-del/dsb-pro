import { test, expect } from '@playwright/test';
import { addItemForm } from './design-helpers';
test('DSB purchase detail, repeat and contextual payment use the same financial records', async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/signup');
  await page.getByLabel('Email').fill(`purchase-workflow-${Date.now()}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill('TestOnly-2026!pw');
  await page.getByLabel('Confirm password').fill('TestOnly-2026!pw');
  await page.getByRole('button', { name: 'Sign up', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Purchase workflow shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.goto('/inventory');
  await addItemForm(page);
  await page.getByPlaceholder('Item name', { exact: true }).fill('Daily oil');
  await page.getByPlaceholder('Big unit (e.g. case)').fill('jar');
  await page.getByRole('button', { name: 'Create item', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Created Daily oil' })).toContainText(
    'Created Daily oil',
  );
  await page.goto('/purchases?new=1');
  const supplier = page
    .getByRole('button', { name: 'Create & select supplier' })
    .locator('xpath=..');
  await page.getByText('Add a supplier', { exact: true }).click();
  await supplier.getByPlaceholder('New supplier name').fill('Daily Supplier');
  await supplier.getByRole('button', { name: 'Create & select supplier' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Created supplier' })).toContainText(
    'Created supplier',
  );
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase', exact: true }) })
    .last();
  const currentBusinessDate = await purchase.locator('input[name="date"]').inputValue();
  const olderDate = new Date(currentBusinessDate + 'T12:00:00Z');
  olderDate.setUTCDate(olderDate.getUTCDate() - 1);
  await purchase.locator('input[name="date"]').fill(olderDate.toISOString().slice(0, 10));
  await purchase.locator('input[name="billNo"]').fill('DSB-1');
  await expect(purchase.locator('select[name="partyId"]')).toHaveValue(/.+/);
  await purchase.getByLabel('Purchase item', { exact: true }).selectOption({ label: 'Daily oil' });
  await purchase.locator('input[name="qty"]').fill('2');
  await purchase.locator('input[name="price"]').fill('120');
  await purchase.getByRole('button', { name: 'Add line', exact: true }).click();
  await purchase.getByRole('button', { name: 'Post purchase', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Purchase posted' })).toContainText(
    'Purchase posted',
  );
  await page.getByRole('link', { name: 'Bill list', exact: true }).click();
  await page.getByRole('button', { name: /Daily Supplier.*DSB-1/ }).click();
  const detail = page.getByLabel('Purchase detail');
  await expect(detail).toContainText('Daily oil');
  await expect(detail).toContainText('Due ₹240.00');
  async function capture(name: string) {
    const health = page.locator('.health-summary');
    await expect(health.locator(':scope > summary')).not.toContainText('Checking…');
    if ((await health.getAttribute('open')) !== null)
      await health.locator(':scope > summary').click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(name + '.png'), fullPage: true });
  }
  await capture('12-purchases-phone');
  await detail.getByRole('link', { name: 'Repeat into new draft' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Draft repeated from DSB-1' }),
  ).toContainText('Draft repeated from DSB-1');
  await expect(purchase.locator('input[name="billNo"]')).toHaveValue('');
  await expect(purchase.locator('input[name="date"]')).toHaveValue(currentBusinessDate);
  await expect(purchase).toContainText('Daily oil');
  await purchase.locator('input[name="billNo"]').fill('DSB-2');
  await capture('13-repeat-purchase-phone');
  await purchase.getByRole('button', { name: 'Post purchase', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Purchase posted' })).toContainText(
    'Purchase posted',
  );
  await page.getByRole('link', { name: 'Bill list', exact: true }).click();
  // Repeating the same source again after posting must create a fresh, unposted draft.
  await page.getByRole('button', { name: /Daily Supplier.*DSB-1/ }).click();
  await detail.getByRole('link', { name: 'Repeat into new draft' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Draft repeated from DSB-1' }),
  ).toContainText('Draft repeated from DSB-1');
  await expect(purchase.getByLabel('Purchase cart')).toContainText('₹240.00');
  await page.getByRole('link', { name: 'Bill list', exact: true }).click();
  await page.getByRole('button', { name: /Daily Supplier.*DSB-2/ }).click();
  await detail.getByRole('link', { name: 'Record payment', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Suppliers & payments' })).toBeVisible();
  await expect(page.getByLabel('Amount paid ₹')).toHaveValue('240.00');
  await expect(page.getByLabel('Allocate to DSB-2')).toHaveValue('240.00');
  await page.getByLabel('Amount paid ₹').fill('100');
  await page.getByRole('button', { name: 'Auto · oldest first' }).click();
  await expect(page.getByLabel('Allocate to DSB-1')).toHaveValue('100.00');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm and record', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'confirmed by the server' }),
  ).toContainText('confirmed by the server');
  await expect(
    page.getByRole('heading', { name: 'Summary', exact: true }).locator('..'),
  ).toContainText('₹380.00');
  await capture('14-context-payment-phone');
  await page.goto('/purchases');
  await page.getByRole('button', { name: /Daily Supplier.*DSB-1/ }).click();
  await expect(page.getByLabel('Purchase detail')).toContainText('Due ₹140.00');
  await page.goto('/inventory');
  await expect(page.getByRole('button', { name: /Daily oil/ }).first()).toContainText('4');
});
