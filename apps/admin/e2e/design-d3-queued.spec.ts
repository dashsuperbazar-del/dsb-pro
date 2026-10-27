import { test, expect, type Page } from '@playwright/test';
import { swReady } from './sw-ready';
import { addItemForm, fillBillItem, stockTask } from './design-helpers';
// D3 evidence: purchase entry with one bill queued offline, "Saved on this device" row collapsed and
// expanded, phone size, light and dark. Set DESIGN_SHOTS_DIR to collect the PNGs.
const PASSWORD = 'TestOnly-2026!pw';
const purchaseSection = (page: Page) =>
  page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase', exact: true }) })
    .last();

test('design screenshots: queued bill row, collapsed + expanded', async ({
  page,
  context,
}, info) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/signup');
  await page.getByLabel('Email').fill(`d3q-${Date.now()}-${Math.random()}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Dash Super Bazar');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.goto('/inventory');
  await stockTask(page, 'Suppliers');
  await page.getByPlaceholder('Supplier name').fill('Sharma Traders');
  await page.getByRole('button', { name: 'Create supplier' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created supplier' }).first(),
  ).toBeVisible();
  await addItemForm(page);
  await page.getByPlaceholder('Item name').fill('Basmati rice 1kg');
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Created' }).first()).toBeVisible();
  await page.goto('/purchases?new=1');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect(purchaseSection(page)).toHaveAttribute('data-purchase-ready', 'true');
  await page.goto('/sync');
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('0');
  await page.goto('/purchases?new=1');
  await expect(purchaseSection(page)).toHaveAttribute('data-purchase-ready', 'true');
  await swReady(page);
  await context.setOffline(true);
  const purchase = purchaseSection(page);
  await purchase.locator('select[name="partyId"]').selectOption({ label: 'Sharma Traders' });
  await purchase.locator('input[name="billNo"]').fill('Q-1045');
  await fillBillItem(purchase, 1, 'Basmati rice 1kg', '11', '95');
  await purchase
    .getByRole('button', { name: 'Save on this device (syncs later)', exact: true })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Saved on this device — will sync' }).first(),
  ).toBeVisible();
  const dir = process.env.DESIGN_SHOTS_DIR;
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => localStorage.setItem('dsb-pro:appearance', t), theme);
    await page.emulateMedia({ colorScheme: theme });
    await page.reload();
    await expect(page.getByLabel('Purchases saved on this device')).toBeVisible();
    const toggle = page.getByLabel('Purchases saved on this device').locator('.home-row-toggle');
    if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click();
    for (const state of ['collapsed', 'expanded'] as const) {
      if (state === 'expanded') await toggle.click();
      await page.waitForTimeout(400);
      const file = `d3-18-queued-bill-${state}-${theme}-phone.png`;
      await page.screenshot({
        path: dir ? `${dir}/${file}` : info.outputPath(file),
        fullPage: true,
      });
    }
  }
});
