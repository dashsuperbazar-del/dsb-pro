import { test, expect, type Page } from '@playwright/test';
import { addItemForm, stockTask, fillBillItem } from './design-helpers';
// D3 design evidence: Search (empty, grouped results, no results), Inventory, Suppliers, Purchases,
// Reports, Settings and More at phone and desktop size, light and dark. Screenshots only; the
// assertions are page-load waits. Set DESIGN_SHOTS_DIR to collect the PNGs in one folder.
const viewports = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1366, height: 768 },
] as const;
const PASSWORD = 'TestOnly-2026!pw';

// Extra items so the search shows "Show more" (default page is 10).
async function createPlainItem(page: Page, name: string) {
  await page.goto('/inventory');
  await addItemForm(page);
  await page.getByPlaceholder('Item name').fill(name);
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: `Created ${name}` })
      .first(),
  ).toBeVisible();
}
async function createItem(page: Page, name: string, price: string) {
  await page.goto('/inventory');
  await addItemForm(page);
  await page.getByPlaceholder('Item name').fill(name);
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Created' }).first()).toBeVisible();
  await page.getByLabel('Item details').selectOption({ label: name });
  const form = page.getByRole('button', { name: 'Set price' }).locator('xpath=..');
  await form.locator('input[name="price"]').fill(price);
  await page.getByRole('button', { name: 'Set price' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Price history updated' }).first(),
  ).toBeVisible();
}

test('design screenshots: D3 screens, phone + desktop, light + dark', async ({ page }, info) => {
  test.setTimeout(420000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/signup');
  await page.getByLabel('Email').fill(`d3-${Date.now()}-${Math.random()}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Dash Super Bazar');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await createItem(page, 'Basmati rice 1kg', '120');
  await createItem(page, 'Sugar 5kg', '230');
  for (let n = 1; n <= 12; n++) await createPlainItem(page, `Basmati pack ${n}`);
  await stockTask(page, 'Suppliers');
  await page.getByPlaceholder('Supplier name', { exact: true }).fill('Basmati Traders');
  await page.getByRole('button', { name: 'Create supplier', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created supplier' }).first(),
  ).toBeVisible();
  await page.goto('/purchases?new=1');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase', exact: true }) })
    .last();
  await expect(purchase).toHaveAttribute('data-purchase-ready', 'true');
  await purchase.locator('input[name="billNo"]').fill('D3-BILL');
  await purchase.locator('select[name="partyId"]').selectOption({ label: 'Basmati Traders' });
  await fillBillItem(purchase, 1, 'Basmati rice 1kg', '24', '95');
  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Purchase posted' }).first(),
  ).toBeVisible();
  await page.goto('/customers');
  await page
    .locator('summary')
    .filter({ hasText: /^Add customer$/ })
    .click();
  await page.getByLabel('Name').fill('Basmati Stores');
  await page.getByRole('button', { name: 'Create customer' }).click();
  await expect(page.getByText(/Customer owes/)).toBeVisible();

  const dir = process.env.DESIGN_SHOTS_DIR;
  const shot = async (name: string) => {
    await page.waitForTimeout(400);
    const file = `d3-${name}.png`;
    await page.screenshot({ path: dir ? `${dir}/${file}` : info.outputPath(file), fullPage: true });
  };
  for (const vp of viewports)
    for (const theme of ['light', 'dark'] as const) {
      const tag = `${theme}-${vp.name}`;
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.evaluate((t) => localStorage.setItem('dsb-pro:appearance', t), theme);
      await page.goto('/search');
      await expect(page.getByRole('heading', { name: 'Search' })).toBeVisible();
      await expect(page.getByText('Loading…')).toHaveCount(0);
      await shot(`01-search-empty-${tag}`);
      await page.getByRole('searchbox').fill('basmati');
      await expect(page.getByRole('region', { name: 'Items' })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Show \d+ more/ })).toBeVisible();
      await expect(page.getByText('Searching bills and invoices…')).toHaveCount(0);
      await shot(`02-search-results-${tag}`);
      for (const t of await page.locator('.result-group .home-row-toggle').all())
        if ((await t.getAttribute('aria-expanded')) !== 'true') await t.click();
      await page.mouse.move(0, 0);
      await shot(`02b-search-all-open-${tag}`);
      await page.getByRole('searchbox').fill('zzzzzz');
      await expect(page.getByText('No matches.')).toBeVisible();
      await shot(`03-search-none-${tag}`);
      await page.goto('/inventory');
      await expect(page.getByRole('heading', { name: 'Inventory & purchases' })).toBeVisible();
      await page.waitForTimeout(800);
      await shot(`04-inventory-${tag}`);
      await stockTask(page, 'Items');
      await page.getByLabel('Item details').selectOption({ label: 'Basmati rice 1kg' });
      await shot(`05-inventory-detail-${tag}`);
      await stockTask(page, 'Suppliers');
      await page.waitForTimeout(600);
      await shot(`06-suppliers-${tag}`);
      await page.goto('/purchases');
      await expect(page.getByText('D3-BILL').first()).toBeVisible();
      await shot(`07-purchases-${tag}`);
      await page.goto('/customers');
      await expect(page.getByRole('heading', { name: 'Customers & ledger' })).toBeVisible();
      await shot(`08-customers-${tag}`);
      await page.goto('/reports');
      await expect(page.getByRole('heading', { name: 'Reports & recovery' })).toBeVisible();
      await shot(`09-reports-${tag}`);
      await page.goto('/settings');
      await expect(page.getByRole('heading', { name: 'Shop profile' })).toBeVisible();
      await shot(`10-settings-${tag}`);
      await page.goto('/more');
      await page.waitForTimeout(500);
      await shot(`11-more-${tag}`);
      for (const [n, path, heading] of [
        ['12-sales-history', '/sales-history', 'Sales history'],
        ['13-team', '/team', 'Team'],
        ['14-devices', '/devices', 'Devices'],
        ['15-sync', '/sync', 'Sync & offline'],
        ['16-audit', '/audit-log', 'Audit log'],
      ] as const) {
        await page.goto(path);
        await expect(
          page.getByRole('heading', { name: heading, exact: true }).first(),
        ).toBeVisible();
        await shot(`${n}-${tag}`);
      }
      await page.goto('/inventory');
      await addItemForm(page);
      await shot(`17-add-item-${tag}`);
    }
});
