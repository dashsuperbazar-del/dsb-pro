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
