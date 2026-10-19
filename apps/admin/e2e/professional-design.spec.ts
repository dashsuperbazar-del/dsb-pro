import { test, expect } from '@playwright/test';
import { addItemForm, reviewPayment, stockTask, fillBillItem } from './design-helpers';
test('professional phone workspace preserves drafts across task views and has reachable controls', async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/signup');
  await page.getByLabel('Email').fill(`design-${Date.now()}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill('TestOnly-2026!pw');
  await page.getByLabel('Confirm password').fill('TestOnly-2026!pw');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Design preview shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  async function capture(name: string, resetScroll = true) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const healthPanel = page.locator('.health-summary');
    await expect(healthPanel.locator('summary').first()).not.toContainText('Checking…');
    if ((await healthPanel.getAttribute('open')) !== null)
      await healthPanel.locator('summary').first().click();
    if (resetScroll) await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: false });
  }
  await expect(page.getByRole('region', { name: 'Day book today' })).toContainText('₹0.00');
  const health = page.locator('.health-summary');
  await expect(health.locator('summary').first()).not.toContainText('Checking…');
  if ((await health.getAttribute('open')) !== null) await health.locator('summary').first().click();
  await capture('01-home-phone');
  const nav = page.getByRole('navigation', { name: 'Quick navigation' });
  await page.goto('/inventory');
  await addItemForm(page);
  await page.getByPlaceholder('Item name').fill('Daily rice');
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created Daily rice' }).first(),
  ).toBeVisible();
  await page.getByLabel('Item details').selectOption({ label: 'Daily rice' });
  const price = page.getByRole('button', { name: 'Set price' }).locator('xpath=..');
  await price.locator('input[name="price"]').fill('20');
  await page.getByRole('button', { name: 'Set price' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Price history updated' }).first(),
  ).toBeVisible();
  await stockTask(page, 'Suppliers');
  await page.getByPlaceholder('Supplier name', { exact: true }).fill('Daily Traders');
  await page.getByRole('button', { name: 'Create supplier', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created supplier Daily Traders' }).first(),
  ).toBeVisible();
  await stockTask(page, 'Purchases');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase' }) });
  await purchase.locator('input[name="billNo"]').fill('PREVIEW-1');
  await purchase.locator('select[name="partyId"]').selectOption({ label: 'Daily Traders' });
  await fillBillItem(purchase, 1, 'Daily rice', '12', '10');
  await stockTask(page, 'Items');
  await stockTask(page, 'Purchases');
  await expect(purchase.getByLabel('Item 1 quantity', { exact: true })).toHaveValue('12');
  await expect(purchase.getByLabel('Item 1 rate ₹', { exact: true })).toHaveValue('10');
  await capture('02-purchase-phone');
  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Purchase posted' }).first(),
  ).toBeVisible();
  await nav.getByRole('link', { name: 'Sales', exact: true }).click();
  await page.getByLabel('Item', { exact: true }).selectOption({ label: 'Daily rice' });
  await page.getByLabel('Quantity', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Add line' }).click();
  await expect(page.locator('.pos-cart')).toContainText('₹40.00');
  await capture('03-billing-phone');
  await reviewPayment(page);
  const amount = page.getByLabel('Amount ₹').first();
  await amount.fill('40');
  await amount.evaluate((node) => node.setAttribute('data-draft-node', 'retained'));
  await page.getByRole('button', { name: '← Back to items' }).click();
  await expect(page.locator('.pos-cart')).toContainText('₹40.00');
  await reviewPayment(page);
  await expect(amount).toHaveValue('40');
  await expect(amount).toHaveAttribute('data-draft-node', 'retained');
  await capture('04-checkout-phone');
  await page.getByRole('button', { name: 'Finalize sale' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Sale finalized' }).first(),
  ).toBeVisible();
  await nav.getByRole('link', { name: 'Ledger', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Suppliers & payments' })).toBeVisible();
  await page.getByLabel('Supplier', { exact: true }).selectOption({ label: 'Daily Traders' });
  const tasks = page.getByRole('navigation', { name: 'Supplier tasks' });
  await expect(page.getByRole('heading', { name: 'Open bills', exact: true })).toBeVisible();
  await expect(
    page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Open bills', exact: true }) }),
  ).toContainText('PREVIEW-1');
  await capture('05-parties-phone');
  await tasks.getByRole('button', { name: 'Record payment', exact: true }).click();
  await page.getByLabel('Amount paid ₹').fill('30');
  await page.getByLabel('Allocate to PREVIEW-1').fill('30');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByLabel('Confirm payment')).toBeVisible();
  await page.getByLabel('Confirm payment').scrollIntoViewIfNeeded();
  await capture('05b-supplier-payment-phone', false);
  await page.getByRole('button', { name: 'Confirm and record', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'confirmed by the server' }).first(),
  ).toBeVisible();
  await page.goto('/inventory');
  await expect(page.getByRole('button', { name: /Daily rice/ }).first()).toBeVisible();
  await capture('06-stock-phone');
  await page
    .getByRole('button', { name: /Daily rice/ })
    .first()
    .click();
  await expect(page.getByLabel('Item details')).toHaveValue(/.+/);
  await expect(page.getByRole('heading', { name: 'Item setup', exact: true })).toBeInViewport();
  await page.getByRole('button', { name: 'New item', exact: true }).click();
  await expect(page.getByPlaceholder('Item name', { exact: true })).toBeVisible();
  await nav.getByRole('link', { name: 'More', exact: true }).click();
  await capture('07-more-phone');
  await page.getByLabel('Appearance').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.getByLabel('Appearance')).toHaveValue('dark');
  await capture('08-dark-phone');
  await page.getByLabel('Appearance').selectOption('light');
  await page.getByRole('link', { name: 'Reports & recovery', exact: true }).click();
  for (const date of ['From', 'To'])
    expect(
      (await page.getByLabel(date, { exact: true }).boundingBox())!.width,
    ).toBeGreaterThanOrEqual(160);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Invariant check: PASS' }).first(),
  ).toBeVisible();
  await capture('09-reports-phone');
  await page.goto('/sync');
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('0');
  await capture('10-sync-phone');
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Day book today' })).toContainText('₹40.00');
  await capture('01-home-phone');
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await capture('11-home-desktop');
});
