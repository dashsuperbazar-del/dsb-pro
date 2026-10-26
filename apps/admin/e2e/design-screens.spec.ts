import { test, expect, type Page } from '@playwright/test';
import { addItemForm, stockTask, fillBillItem } from './design-helpers';
// D1 design evidence: the main screens at phone and desktop size, light and dark. Screenshots only;
// every assertion here is a page-load wait, not a behaviour check (those live in the other specs).
// Set DESIGN_SHOTS_DIR to collect the PNGs in one folder (default: the test output folder).
const viewports = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1366, height: 768 },
] as const;
const screens: { name: string; path: string; ready: (page: Page) => Promise<void> }[] = [
  {
    name: '01-home',
    path: '/',
    ready: (p) => expect(p.getByRole('heading', { name: 'Overview' })).toBeVisible(),
  },
  {
    name: '02-pos',
    path: '/pos',
    ready: (p) => expect(p.getByRole('heading', { name: 'Sales POS', exact: true })).toBeVisible(),
  },
  {
    name: '03-purchase-entry',
    path: '/purchases?new=1',
    ready: (p) => expect(p.getByRole('heading', { name: 'Post purchase' })).toBeVisible(),
  },
  {
    name: '04-purchases-list',
    path: '/purchases',
    ready: (p) => expect(p.getByText('DESIGN-1').first()).toBeVisible(),
  },
  {
    name: '05-inventory',
    path: '/inventory',
    ready: (p) => expect(p.getByRole('heading', { name: 'Inventory & purchases' })).toBeVisible(),
  },
  {
    name: '06-reports',
    path: '/reports',
    ready: (p) => expect(p.getByRole('heading', { name: 'Reports & recovery' })).toBeVisible(),
  },
  {
    name: '07-settings',
    path: '/settings',
    ready: (p) => expect(p.getByRole('heading', { name: 'Shop profile' })).toBeVisible(),
  },
];
test('design screenshots: main screens, phone + desktop, light + dark', async ({ page }, info) => {
  test.setTimeout(240000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/signup');
  await page.getByLabel('Email').fill(`d1-${Date.now()}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill('TestOnly-2026!pw');
  await page.getByLabel('Confirm password').fill('TestOnly-2026!pw');
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
  await stockTask(page, 'Purchases');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase' }) });
  await purchase.locator('input[name="billNo"]').fill('DESIGN-1');
  await purchase.locator('select[name="partyId"]').selectOption({ label: 'Sharma Traders' });
  await fillBillItem(purchase, 1, 'Basmati rice 1kg', '24', '95');
  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Purchase posted' }).first(),
  ).toBeVisible();
  const dir = process.env.DESIGN_SHOTS_DIR;
  for (const vp of viewports)
    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.evaluate((t) => localStorage.setItem('dsb-pro:appearance', t), theme);
      for (const s of screens) {
        await page.goto(s.path);
        await s.ready(page);
        if (
          s.name === '02-pos' &&
          !(await page.locator('.pos-cart').textContent())?.includes('Basmati')
        ) {
          await page
            .getByLabel('Item', { exact: true })
            .selectOption({ label: 'Basmati rice 1kg' });
          await page.getByLabel('Quantity', { exact: true }).fill('2');
          await page.getByRole('button', { name: 'Add item', exact: true }).click();
          await expect(page.locator('.pos-cart')).toContainText('Basmati rice 1kg');
        }
        await page.waitForTimeout(400);
        const file = `d1-${s.name}-${theme}-${vp.name}.png`;
        await page.screenshot({ path: dir ? `${dir}/${file}` : info.outputPath(file) });
        const toggles = page.locator('.home-row-toggle');
        if (s.name === '01-home' && (await toggles.count())) {
          for (const t of await toggles.all()) await t.click();
          await page.mouse.move(0, 0);
          await page
            .locator('.home-row')
            .first()
            .evaluate((n) => n.scrollIntoView());
          await page.evaluate(() => window.scrollBy(0, -140));
          await page.waitForTimeout(200);
          const open = `d1-01b-home-expanded-${theme}-${vp.name}.png`;
          await page.screenshot({ path: dir ? `${dir}/${open}` : info.outputPath(open) });
          for (const t of await toggles.all()) await t.click();
        }
      }
    }
});
