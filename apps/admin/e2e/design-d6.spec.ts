import { test, expect, type Page } from '@playwright/test';
import { setupPosShop, addToCart, toPayment } from './pos-shop-setup';
// D6 evidence: Sales history, Sync (online + offline queued), Reports, Expenses, Customers, Audit log at
// phone and desktop size, light and dark. Screenshots only (no assertions about the new UI, so the same
// spec can be run on the previous build for the "before" set). Set DESIGN_SHOTS_DIR to collect the PNGs.
const dir = process.env.DESIGN_SHOTS_DIR;
const themes = (dir ? ['light', 'dark'] : ['light']) as ('light' | 'dark')[];
const sizes = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1366, height: 768 },
] as const;

async function sell(page: Page, qty: string, pay: string, customer?: string) {
  await page.goto('/pos');
  await expect(page.getByLabel('Item', { exact: true })).toBeEnabled();
  await addToCart(page, qty);
  await toPayment(page);
  if (customer) {
    const select = page.locator('#pos-payment select').first();
    const value = await select.evaluate(
      (el, name) =>
        [...(el as HTMLSelectElement).options].find((o) => o.text.startsWith(name))?.value ?? '',
      customer,
    );
    await select.selectOption(value);
  }
  await page.locator('#pos-payment input[type="number"]').first().fill(pay);
  await page.getByRole('button', { name: 'Finalize sale' }).click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: /Sale finalized|Saved locally/ })
      .first(),
  ).toBeVisible();
}

test('design screenshots: D6 screens', async ({ page, context }, info) => {
  test.setTimeout(600000);
  await setupPosShop(page, 'd6');
  // A customer for the credit sale.
  await page.goto('/pos');
  await expect(page.getByLabel('Item', { exact: true })).toBeEnabled();
  await addToCart(page, '1');
  await toPayment(page);
  await page.getByText('Add a new customer').click();
  await page.getByPlaceholder('Name', { exact: true }).fill('Ravi Kumar');
  await page.getByRole('button', { name: 'Create & select' }).click();
  await expect(page.getByText('Customer Ravi Kumar created.').first()).toBeVisible();
  await page.locator('#pos-payment input[type="number"]').first().fill('500');
  await page.getByRole('button', { name: 'Finalize sale' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Sale finalized' }).first(),
  ).toBeVisible();
  await sell(page, '2', '2400');
  await sell(page, '3', '3600');
  // An expense.
  await page.goto('/expenses');
  await page.getByLabel('Category').fill('Rent');
  await page.getByLabel('Amount ₹').fill('12500');
  await page.getByRole('button', { name: 'Post expense' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Expense posted' })).toBeVisible();

  const shoot = async (name: string, tag: string) => {
    await page.waitForTimeout(500);
    const file = `${name}-${tag}.png`;
    await page.screenshot({
      path: dir ? `${dir}/${file}` : info.outputPath(file),
      fullPage: true,
    });
  };
  const online = [
    ['01-sales-history', '/sales-history'],
    ['03-sync-online', '/sync'],
    ['05-reports', '/reports'],
    ['06-expenses', '/expenses'],
    ['07-customers', '/customers'],
    ['08-audit', '/audit-log'],
  ] as const;
  for (const theme of themes)
    for (const size of sizes) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.evaluate((t) => localStorage.setItem('dsb-pro:appearance', t), theme);
      await page.emulateMedia({ colorScheme: theme });
      for (const [name, path] of online) {
        await page.goto(path);
        await page.waitForTimeout(800);
        if (name === '05-reports') {
          await page.getByRole('button', { name: 'Refresh', exact: true }).click();
          await page.waitForTimeout(800);
        }
        await shoot(name, `${theme}-${size.name}`);
      }
    }
  // Offline: one sale saved on the device.
  await page.goto('/pos');
  await expect(page.getByLabel('Item', { exact: true })).toBeEnabled();
  await context.setOffline(true);
  await sell(page, '1', '1200');
  for (const theme of themes)
    for (const size of sizes) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.evaluate((t) => localStorage.setItem('dsb-pro:appearance', t), theme);
      await page.emulateMedia({ colorScheme: theme });
      if (!page.url().includes('/sync'))
        await page.getByRole('link', { name: 'Sync & offline' }).click();
      await page.waitForTimeout(800);
      await shoot('04-sync-offline-queued', `${theme}-${size.name}`);
    }
  await context.setOffline(false);
});
