import { test, expect, type Page } from '@playwright/test';
import { addItemForm, stockTask, fillBillItem } from './design-helpers';
// D2 counter screens: POS (empty, cart, payment) and purchase bill entry (empty, filled, offline
// queued) at phone and desktop size, light and dark. Screenshots go to DESIGN_SHOTS_DIR (default:
// the test output folder). The one behaviour check: on a phone the purchase total/Post bar is fully
// above the fixed bottom nav, at the top of the page and after scrolling.
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

async function setup(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/signup');
  await page.getByLabel('Email').fill(`d2-${Date.now()}-${Math.random()}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Dash Super Bazar');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.goto('/inventory');
  await addItemForm(page);
  await page.getByPlaceholder('Item name').fill('Basmati rice 1kg');
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Created' }).first()).toBeVisible();
  await page.getByLabel('Item details').selectOption({ label: 'Basmati rice 1kg' });
  const price = page.getByRole('button', { name: 'Set price' }).locator('xpath=..');
  await price.locator('input[name="price"]').fill('120');
  await page.getByRole('button', { name: 'Set price' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Price history updated' }).first(),
  ).toBeVisible();
  await stockTask(page, 'Suppliers');
  await page.getByPlaceholder('Supplier name', { exact: true }).fill('Sharma Traders');
  await page.getByRole('button', { name: 'Create supplier', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created supplier' }).first(),
  ).toBeVisible();
  // Stock for the POS cart.
  await page.goto('/purchases?new=1');
  const purchase = purchaseSection(page);
  await expect(purchase).toHaveAttribute('data-purchase-ready', 'true');
  await purchase.locator('input[name="billNo"]').fill('D2-STOCK');
  await purchase.locator('select[name="partyId"]').selectOption({ label: 'Sharma Traders' });
  await fillBillItem(purchase, 1, 'Basmati rice 1kg', '24', '95');
  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Purchase posted' }).first(),
  ).toBeVisible();
}

async function barClearsNav(page: Page) {
  const nav = await page.locator('.bottom-nav').boundingBox();
  const bar = await purchaseSection(page).locator('.bill-bar').boundingBox();
  expect(nav && bar).toBeTruthy();
  // Fully on screen and fully above the nav (1px tolerance for sub-pixel rounding).
  expect(bar!.y).toBeGreaterThanOrEqual(0);
  expect(bar!.y + bar!.height).toBeLessThanOrEqual(nav!.y + 1);
}

test('purchase entry on a phone: the total/Post bar is always fully above the bottom nav', async ({
  page,
}) => {
  test.setTimeout(120000);
  await setup(page);
  await page.goto('/purchases?new=1');
  const purchase = purchaseSection(page);
  await expect(purchase).toHaveAttribute('data-purchase-ready', 'true');
  await page.evaluate(() => window.scrollTo(0, 0));
  await barClearsNav(page);
  await purchase.locator('select[name="partyId"]').selectOption({ label: 'Sharma Traders' });
  await fillBillItem(purchase, 1, 'Basmati rice 1kg', '2', '95');
  await page.evaluate(() => window.scrollTo(0, 0));
  await barClearsNav(page);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await barClearsNav(page);
  await expect(purchase.getByRole('button', { name: 'Post purchase' })).toBeInViewport({
    ratio: 1,
  });
});

test('design screenshots: counter screens, phone + desktop, light + dark', async ({
  page,
  context,
}, info) => {
  test.setTimeout(300000);
  await setup(page);
  const dir = process.env.DESIGN_SHOTS_DIR;
  const shot = async (name: string) => {
    await page.waitForTimeout(300);
    const file = `d2-${name}.png`;
    await page.screenshot({ path: dir ? `${dir}/${file}` : info.outputPath(file) });
  };
  let round = 0;
  for (const vp of viewports)
    for (const theme of ['light', 'dark'] as const) {
      round++; // a different total each round: the same supplier + total would ask "possible duplicate"
      const tag = `${theme}-${vp.name}`;
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.evaluate((t) => localStorage.setItem('dsb-pro:appearance', t), theme);
      // POS: empty, cart, payment.
      await page.goto('/pos');
      await expect(page.getByRole('heading', { name: 'Sales POS', exact: true })).toBeVisible();
      await expect(page.getByLabel('Item', { exact: true })).toBeEnabled();
      if ((await page.locator('.pos-cart').textContent())?.includes('Basmati')) {
        await page.evaluate(() => localStorage.clear());
        await page.evaluate((t) => localStorage.setItem('dsb-pro:appearance', t), theme);
        await page.reload();
      }
      await shot(`01-pos-empty-${tag}`);
      await page.getByLabel('Item', { exact: true }).selectOption({ label: 'Basmati rice 1kg' });
      await page.getByLabel('Quantity', { exact: true }).fill('2');
      await page.getByRole('button', { name: 'Add item', exact: true }).click();
      await expect(page.locator('.pos-cart')).toContainText('Basmati rice 1kg');
      await shot(`02-pos-cart-${tag}`);
      if (!(await page.locator('#pos-payment').isVisible()))
        await page.getByRole('button', { name: 'Review payment →', exact: true }).click();
      await expect(page.locator('#pos-payment')).toBeVisible();
      await page.locator('#pos-payment').scrollIntoViewIfNeeded();
      await shot(`03-pos-payment-${tag}`);
      // Purchase entry: empty, filled, offline queued.
      await page.goto('/purchases?new=1');
      const purchase = purchaseSection(page);
      await expect(purchase).toHaveAttribute('data-purchase-ready', 'true');
      await shot(`04-purchase-empty-${tag}`);
      await purchase.locator('select[name="partyId"]').selectOption({ label: 'Sharma Traders' });
      await purchase.locator('input[name="billNo"]').fill(`D2-${tag}`);
      await fillBillItem(purchase, 1, 'Basmati rice 1kg', String(10 + round), '95');
      await page.evaluate(() => window.scrollTo(0, 0));
      await shot(`05-purchase-filled-${tag}`);
      await context.setOffline(true);
      await expect(purchase.getByTestId('offline-post')).toBeVisible();
      await purchase
        .getByRole('button', { name: 'Save on this device (syncs later)', exact: true })
        .click();
      await expect(
        page.getByRole('status').filter({ hasText: 'Saved on this device — will sync' }).first(),
      ).toBeVisible();
      await page.evaluate(() => window.scrollTo(0, 0));
      await shot(`06-purchase-offline-queued-${tag}`);
      await context.setOffline(false);
      await page.goto('/sync');
      await page.getByRole('button', { name: 'Sync now' }).click();
      await expect(page.getByTestId('sync-outbox-count')).toHaveText('0');
    }
});
