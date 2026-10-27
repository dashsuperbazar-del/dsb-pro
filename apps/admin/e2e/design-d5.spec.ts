import { test, expect, type Page } from '@playwright/test';
import { fillBillItem, stockTask } from './design-helpers';
import { setupPosShop } from './pos-shop-setup';
// D5 design evidence: Purchases + Suppliers at phone and desktop size, light and dark. Screenshots only;
// the assertions are page-load waits. Set DESIGN_SHOTS_DIR to collect the PNGs in one folder. The same
// spec runs against the build before D5 (steps for controls that did not exist are skipped).
const viewports = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1366, height: 768 },
] as const;
const PASSWORD = 'TestOnly-2026!pw';
const purchaseSection = (page: Page) =>
  page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase', exact: true }) })
    .last();

test('design screenshots: D5 Purchases + Suppliers', async ({ page }, info) => {
  test.setTimeout(420000);
  const dir = process.env.DESIGN_SHOTS_DIR;
  const shot = async (name: string) => {
    await page.waitForTimeout(500);
    const file = `${name}.png`;
    await page.screenshot({ path: dir ? `${dir}/${file}` : info.outputPath(file), fullPage: true });
  };
  async function each(fn: (tag: string) => Promise<void>) {
    for (const vp of viewports)
      for (const theme of ['light', 'dark'] as const) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.evaluate((t) => localStorage.setItem('dsb-pro:appearance', t), theme);
        await fn(`${theme}-${vp.name}`);
      }
  }
  // A new shop with nothing in it: the empty Suppliers screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/signup');
  await page.getByLabel('Email').fill(`d5-${Date.now()}-${Math.random()}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Dash Super Bazar');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await each(async (tag) => {
    await page.goto('/suppliers');
    await expect(page.getByRole('heading', { name: 'Suppliers & payments' })).toBeVisible();
    await expect(page.getByText('Find supplier')).toBeVisible();
    await page.waitForTimeout(800);
    await shot(`suppliers-empty-${tag}`);
  });
  // The same shop gets an item, a supplier and two credit bills.
  await page.goto('/inventory');
  await setupPosShopFrom(page);
  await page.goto('/purchases?new=1');
  let purchase = purchaseSection(page);
  await expect(purchase).toHaveAttribute('data-purchase-ready', 'true');
  await purchase.locator('input[name="billNo"]').fill('D5-SECOND');
  await purchase.locator('select[name="partyId"]').selectOption({ label: 'Sharma Traders' });
  await fillBillItem(purchase, 1, 'Basmati rice 1kg', '10', '960');
  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Purchase posted' }).first(),
  ).toBeVisible();
  await each(async (tag) => {
    await page.goto('/purchases');
    await expect(page.getByText('D5-SECOND').first()).toBeVisible();
    await page.waitForTimeout(800);
    await shot(`purchases-list-${tag}`);
    const filter = page.locator('.home-row-toggle').filter({ hasText: /^Filter/ });
    if (await filter.count()) {
      if ((await filter.getAttribute('aria-expanded')) !== 'true') await filter.click();
      await shot(`purchases-list-filters-open-${tag}`);
      await filter.click();
    }
    await page.getByRole('button', { name: /D5-SECOND/ }).click();
    await expect(page.getByLabel('Purchase detail')).toContainText('D5-SECOND');
    await expect(page.getByTestId('settlement-badge')).toBeVisible();
    await shot(`purchase-detail-${tag}`);
  });
  await each(async (tag) => {
    await page.goto('/suppliers');
    await expect(page.getByRole('button', { name: /Sharma Traders/ }).first()).toBeVisible();
    await page.waitForTimeout(800);
    await shot(`suppliers-data-${tag}`);
    await page.getByRole('button', { name: 'Sharma Traders', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Open bills' })).toBeVisible();
    await page.waitForTimeout(800);
    await shot(`supplier-detail-${tag}`);
  });
  // A purchase whose answer was lost: pending state.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/purchases?new=1');
  purchase = purchaseSection(page);
  await expect(purchase).toHaveAttribute('data-purchase-ready', 'true');
  await purchase.locator('input[name="billNo"]').fill('D5-PENDING');
  await purchase.locator('select[name="partyId"]').selectOption({ label: 'Sharma Traders' });
  await fillBillItem(purchase, 1, 'Basmati rice 1kg', '3', '1000');
  await page.route('**/rpc/post_purchase_v2', async (route) => {
    await route.abort('connectionreset');
  });
  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  await expect(purchase.getByRole('alert').first()).toContainText('may already be saved');
  await each(async (tag) => {
    await page.goto('/purchases?new=1');
    await expect(page.getByRole('button', { name: /Retry same purchase/ })).toBeVisible();
    await page.waitForTimeout(800);
    await shot(`purchase-pending-top-${tag}`);
    await page
      .getByRole('button', { name: 'Review pending purchase' })
      .first()
      .click()
      .catch(() => {});
    await page.waitForTimeout(900);
    await page.screenshot({
      path: dir ? `${dir}/purchase-pending-review-${tag}.png` : info.outputPath(`pr-${tag}.png`),
    });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(400);
    await page.screenshot({
      path: dir ? `${dir}/purchase-pending-bottom-${tag}.png` : info.outputPath(`pb-${tag}.png`),
    });
  });
  void stockTask;
});

// setupPosShop signs up a brand-new owner; this shop already exists, so only add the item + first bill.
async function setupPosShopFrom(page: Page) {
  const { addItemForm } = await import('./design-helpers');
  await addItemForm(page);
  await page.getByPlaceholder('Item name').fill('Basmati rice 1kg');
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Created' }).first()).toBeVisible();
  await stockTask(page, 'Suppliers');
  await page.getByPlaceholder('Supplier name', { exact: true }).fill('Sharma Traders');
  await page.getByRole('button', { name: 'Create supplier', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created supplier' }).first(),
  ).toBeVisible();
  await page.goto('/purchases?new=1');
  const purchase = purchaseSection(page);
  await expect(purchase).toHaveAttribute('data-purchase-ready', 'true');
  await purchase.locator('input[name="billNo"]').fill('D5-FIRST');
  await purchase.locator('select[name="partyId"]').selectOption({ label: 'Sharma Traders' });
  await fillBillItem(purchase, 1, 'Basmati rice 1kg', '40', '950');
  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Purchase posted' }).first(),
  ).toBeVisible();
  void setupPosShop;
}
