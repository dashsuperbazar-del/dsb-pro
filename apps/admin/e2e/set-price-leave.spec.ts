import { stockTask, addItemForm } from './design-helpers';
import { test, expect, type Page } from '@playwright/test';

// A confirmed "Set price" tap must not be lost when the user leaves the page before the answer arrives.
const PASSWORD = 'TestOnly-2026!pw';
async function createOwnerShop(page: Page) {
  await page.goto('/signup');
  await page
    .getByLabel('Email')
    .fill(`price-leave-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Price Leave Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/Overview/)).toBeVisible();
}

test('Set price then leaving the page at once still saves the price and its audit row', async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  await createOwnerShop(page);
  await page.goto('/inventory');
  const name = `Leave Tea ${Math.floor(Math.random() * 1e6)}`;
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
  await stockTask(page, 'Items');
  await page.getByLabel('Item details').selectOption({ label: name });

  // A slow connection, two ways: page.route holds an ordinary fetch inside the browser for 2 s (how the
  // write used to be lost: the page was left before it was sent), and emulated latency keeps any request,
  // including the keepalive write (which page.route cannot see), unanswered until after the page is gone.
  await context.route('**/rest/v1/rpc/set_item_price', async (route) => {
    await new Promise((r) => setTimeout(r, 2000));
    await route.continue().catch(() => undefined);
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 2500,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  const priceForm = page.getByRole('button', { name: 'Set price' }).locator('xpath=..');
  await priceForm.locator('input[name="price"]').fill('42');
  await page.getByRole('button', { name: 'Set price' }).click();
  await page.waitForTimeout(300);
  await page.goto('/more'); // full page load: before the fix the request was cancelled here
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });

  await page.getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: 'retail price set to ₹42.00' });
  await expect(async () => {
    await page.reload();
    await page.getByLabel('Event type').selectOption({ label: 'Sale price changes' });
    await expect(row).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15000 });
  await expect(row).toContainText(name);

  // Back on Inventory the price is current and the device does not report it as unsure.
  await page.goto('/inventory');
  await stockTask(page, 'Items');
  await page.getByLabel('Item details').selectOption({ label: name });
  await expect(page.getByText('₹42.00').first()).toBeVisible();
  await expect(page.getByText(/Price (may not be|not) saved/)).toHaveCount(0);
});

async function createPricedItem(page: Page, prefix: string) {
  await page.goto('/inventory');
  const name = `${prefix} ${Math.floor(Math.random() * 1e6)}`;
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
  return name;
}
async function openItem(page: Page, name: string) {
  await stockTask(page, 'Items');
  await page.getByLabel('Item details').selectOption({ label: name });
}
async function setPrice(page: Page, rupees: string) {
  const priceForm = page.getByRole('button', { name: 'Set price' }).locator('xpath=..');
  await priceForm.locator('input[name="price"]').fill(rupees);
  await page.getByRole('button', { name: 'Set price' }).click();
}
// Makes the next set_item_price calls of this page fail as given (the write never reaches the server).
async function failPriceWrites(page: Page, how: 'network' | 'refused') {
  await page.evaluate((mode) => {
    const w = window as unknown as { __realFetch?: typeof fetch };
    w.__realFetch ??= window.fetch;
    const real = w.__realFetch;
    window.fetch = (input, init) => {
      const href =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!href.includes('/rpc/set_item_price')) return real(input, init);
      if (mode === 'network') return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve(
        new Response(JSON.stringify({ message: 'not permitted', code: '42501' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
  }, how);
}
const pendingCount = (page: Page) =>
  page.evaluate(
    () => (JSON.parse(localStorage.getItem('dsb.pendingPrices.v1') ?? '[]') as unknown[]).length,
  );

test('Retry never silently overwrites a newer price set in another tab', async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  await createOwnerShop(page);
  const name = await createPricedItem(page, 'Stale Tea');
  await openItem(page, name);
  await failPriceWrites(page, 'network');
  await setPrice(page, '42');
  await expect.poll(() => pendingCount(page)).toBe(1);

  // Next visit: the unsure write is offered for Retry (no price was set meanwhile).
  await page.reload();
  const banner = page.getByRole('alert').filter({ hasText: /Price (may not be|not) saved/ });
  await expect(banner).toContainText(name);
  await expect(banner.getByRole('button', { name: 'Retry price' })).toBeVisible();

  // A second tab sets a newer price before Retry is tapped.
  const tab2 = await context.newPage();
  await tab2.goto('/inventory');
  await openItem(tab2, name);
  await setPrice(tab2, '120');
  await expect(tab2.getByRole('status').filter({ hasText: 'Price history updated' })).toBeVisible();

  await banner.getByRole('button', { name: 'Retry price' }).click();
  await expect(banner).toContainText('Now ₹120.00 — set elsewhere');
  await expect(banner.getByRole('button', { name: 'Replace with ₹42.00' })).toBeVisible();
  // Nothing was written: the other tab's price is still current.
  await tab2.reload();
  await openItem(tab2, name);
  await expect(tab2.getByText('₹120.00').first()).toBeVisible();
  await tab2.close();

  // An explicit Replace writes it (same client id).
  await banner.getByRole('button', { name: 'Replace with ₹42.00' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Price saved:' })).toBeVisible();
  await expect(banner).toHaveCount(0);
  expect(await pendingCount(page)).toBe(0);
});

test('a refused Set price shown on screen is forgotten and never resurfaces', async ({ page }) => {
  test.setTimeout(60000);
  await createOwnerShop(page);
  const name = await createPricedItem(page, 'Refused Tea');
  await openItem(page, name);
  await failPriceWrites(page, 'refused');
  await setPrice(page, '42');
  await expect(page.getByText(/not permitted/i).first()).toBeVisible();
  expect(await pendingCount(page)).toBe(0);
  await page.reload();
  await openItem(page, name);
  await expect(page.getByText(/Price (may not be|not) saved/)).toHaveCount(0);
});
