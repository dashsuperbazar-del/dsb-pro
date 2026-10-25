import { test, expect, type Page } from '@playwright/test';
import { addItemForm, fillBillItem, stockTask } from './design-helpers';

// Offline purchases (docs/OFFLINE_PURCHASES_PLAN.md): bills saved without a connection survive a restart,
// post exactly once when the connection returns (credit and cash), upload their photo once, and a bill the
// server refuses stays visible as refused with its form kept for correction.

const PASSWORD = 'TestOnly-2026!pw';

async function createOwnerShop(page: Page) {
  await page.goto('/signup');
  await page
    .getByLabel('Email')
    .fill(`offline-purchase-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Offline Purchase Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/Overview/)).toBeVisible();
}

async function waitForServiceWorker(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve, reject) => {
        const t = window.setTimeout(() => reject(new Error('service worker did not claim')), 5000);
        navigator.serviceWorker.addEventListener(
          'controllerchange',
          () => {
            window.clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });
  });
}

const purchaseSection = (page: Page) =>
  page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase', exact: true }) })
    .last();
const pending = (page: Page) => page.getByLabel('Purchases saved on this device');
const saveButton = (page: Page) =>
  purchaseSection(page).getByRole('button', {
    name: 'Save on this device (syncs later)',
    exact: true,
  });

async function saveOfflineBill(
  page: Page,
  billNo: string,
  qty: string,
  rate: string,
  pay: 'Credit' | 'Cash',
) {
  const purchase = purchaseSection(page);
  await purchase.locator('select[name="partyId"]').selectOption({ label: 'Offline Supplier' });
  await purchase.locator('input[name="billNo"]').fill(billNo);
  await fillBillItem(purchase, 1, 'Offline Rice', qty, rate);
  if (pay === 'Cash')
    await purchase
      .getByRole('group', { name: 'Payment type' })
      .getByRole('button', { name: 'Cash', exact: true })
      .click();
  await saveButton(page).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Saved on this device — will sync' }).first(),
  ).toBeVisible();
}

test('offline purchases: saved without a connection, kept over a restart, posted once each on reconnect', async ({
  page,
  context,
}) => {
  test.setTimeout(120000);
  await createOwnerShop(page);
  await page.goto('/inventory');
  await stockTask(page, 'Suppliers');
  await page.getByPlaceholder('Supplier name').fill('Offline Supplier');
  await page.getByRole('button', { name: 'Create supplier' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created supplier Offline Supplier' }).first(),
  ).toBeVisible();
  await addItemForm(page);
  await page.getByPlaceholder('Item name').fill('Offline Rice');
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created Offline Rice' }).first(),
  ).toBeVisible();

  // One online visit to Purchases saves the supplier list and the catalog on this device.
  await page.goto('/purchases?new=1');
  await waitForServiceWorker(page);
  await expect(purchaseSection(page).locator('input[name="date"]')).not.toHaveValue('');
  await page.goto('/sync');
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('0');
  await page.goto('/purchases?new=1');
  // Explicit ready signal (catalog, suppliers and the bill form loaded), not just a filled date.
  await expect(purchaseSection(page)).toHaveAttribute('data-purchase-ready', 'true');

  // Stored photo objects (path of each upload the server accepted). An attempt cut off by the network and
  // retried to the same path is still one object; two paths would be a second copy.
  let attempts = 0;
  const stored = new Set<string>();
  await page.route('**/storage/v1/object/bill-documents/**', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts++;
    const response = await route.fetch().catch(() => null);
    if (!response) return route.abort().catch(() => undefined); // cut off: the app retries it
    if (response.ok()) stored.add(new URL(route.request().url()).pathname);
    return route.fulfill({ response }).catch(() => undefined);
  });
  // A refusal from the server for one bill (deterministic stand-in for e.g. a supplier archived elsewhere).
  await page.route('**/rest/v1/rpc/post_purchase_v2', (route) => {
    if ((route.request().postData() ?? '').includes('OFF-R1'))
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'P0001', message: 'party not in tenant' }),
      });
    return route.continue();
  });

  await context.setOffline(true);
  await expect(purchaseSection(page).getByTestId('offline-post')).toContainText('syncs when you');
  // A new item cannot be created offline.
  const image = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 400;
    c.height = 600;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 400, 600);
    ctx.fillStyle = '#111';
    ctx.font = '24px sans-serif';
    ctx.fillText('OFFLINE PAPER BILL', 30, 60);
    return c.toDataURL('image/png').split(',')[1];
  });
  // Credit bill with a photo kept on the device.
  {
    const purchase = purchaseSection(page);
    await purchase.locator('.bill-details-toggle').click();
    await expect(purchase.locator('select[name="partyId"]')).toBeEnabled();
    // The picker is refused (silently) while the form is still settling; pick again only if no photo
    // was added, so the bill never carries two copies.
    await expect(async () => {
      if (!(await purchase.getByTestId('bill-photo-1').count()))
        await purchase.getByLabel('Choose bill image', { exact: true }).setInputFiles({
          name: 'offline-bill.png',
          mimeType: 'image/png',
          buffer: Buffer.from(image, 'base64'),
        });
      await expect(purchase.getByTestId('bill-photo-1')).toHaveCount(1, { timeout: 1500 });
    }).toPass({ timeout: 15000 });
    await expect(purchase.getByTestId('bill-photo-2')).toHaveCount(0);
    await expect(purchase.getByLabel('Bill attachment')).toContainText(
      'Kept on this device; uploads when the bill syncs',
    );
  }
  await saveOfflineBill(page, 'OFF-C1', '3', '5', 'Credit');
  await saveOfflineBill(page, 'OFF-K1', '2', '10', 'Cash');
  await saveOfflineBill(page, 'OFF-R1', '1', '7', 'Credit');
  expect(attempts).toBe(0);
  await expect(pending(page).getByTestId('offline-purchase')).toHaveCount(3);

  // Restart while offline: the bills are still on the device, nothing was sent.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(pending(page).getByTestId('offline-purchase')).toHaveCount(3);
  await expect(pending(page)).toContainText('3 not synced yet');
  await expect(
    pending(page).locator('[data-status="QUEUED"]').filter({ hasText: 'OFF-C1' }),
  ).toContainText('+3 piece Offline Rice');

  // Back online: the queue drains in order. Exactly one bill each; the refused one stays visible.
  await context.setOffline(false);
  await page.goto('/sync');
  await page.getByRole('button', { name: 'Retry queued work now' }).click();
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('0', { timeout: 20000 });
  // Sync again: a second cycle sends nothing more.
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('0');
  expect(stored.size).toBe(1);

  await page.goto('/purchases?new=1');
  await expect(pending(page).locator('[data-status="SYNCED"]')).toHaveCount(2);
  const refused = pending(page).locator('[data-status="REJECTED"]');
  await expect(refused).toHaveCount(1);
  await expect(refused).toContainText('OFF-R1');
  await expect(refused).toContainText('party not in tenant');
  await refused.getByRole('button', { name: 'Correct this bill', exact: true }).click();
  await expect(pending(page)).toContainText('The refused bill is now a draft');
  await page.getByText('Saved purchase drafts', { exact: true }).click();
  await expect(page.locator('.context-actions').filter({ hasText: 'OFF-R1' })).toHaveCount(1);

  await page.getByRole('link', { name: 'Bill list', exact: true }).click();
  await expect(page.getByRole('button', { name: /Offline Supplier.*OFF-C1/ })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /Offline Supplier.*OFF-K1/ })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /OFF-R1/ })).toHaveCount(0);

  // Stock: 3 + 2 (the refused bill added nothing).
  await page.goto('/inventory');
  await stockTask(page, 'Items');
  await page.getByLabel('Item details').selectOption({ label: 'Offline Rice' });
  await expect(page.getByLabel('item peek')).toContainText('Stock 5 piece');

  // Supplier balance: the credit bill is open (₹15); the cash bill was paid with it.
  await page.goto('/');
  await page.getByRole('link', { name: 'Suppliers & payments' }).click();
  await page.getByLabel('Supplier', { exact: true }).selectOption({ label: 'Offline Supplier' });
  const openBills = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Open bills', includeHidden: true }) });
  const credit = openBills.locator('tbody tr').filter({ hasText: 'OFF-C1' });
  const cash = openBills.locator('tbody tr').filter({ hasText: 'OFF-K1' });
  await expect(credit).toHaveCount(1);
  await expect(cash).toHaveCount(1);
  // Credit: nothing paid, ₹15 outstanding. Cash: ₹20 paid with the bill (one payment), nothing outstanding.
  await expect(credit.locator('td').nth(4)).toHaveText('₹0.00');
  await expect(credit.locator('td').nth(5)).toHaveText('₹15.00');
  await expect(cash.locator('td').nth(4)).toHaveText('₹20.00');
  await expect(cash.locator('td').nth(5)).toHaveText('₹0.00');
});

test('offline purchases: a connection lost while Purchases is loading falls back to the saved supplier list', async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  await createOwnerShop(page);
  await page.goto('/inventory');
  await stockTask(page, 'Suppliers');
  await page.getByPlaceholder('Supplier name').fill('Offline Supplier');
  await page.getByRole('button', { name: 'Create supplier' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created supplier Offline Supplier' }).first(),
  ).toBeVisible();
  // One online visit saves the supplier list and the catalog on this device.
  await page.goto('/purchases?new=1');
  await waitForServiceWorker(page);
  await expect(purchaseSection(page)).toHaveAttribute('data-purchase-ready', 'true');
  await expect(purchaseSection(page)).toHaveAttribute('data-suppliers-saved', 'true');
  await page.goto('/sync');
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('0');

  // A slow connection: the supplier read is still on its way when the device goes offline.
  await page.route('**/rest/v1/parties?*', async (route) => {
    await new Promise((r) => setTimeout(r, 3000));
    await route.continue().catch(() => undefined);
  });
  await page.goto('/purchases?new=1');
  const purchase = purchaseSection(page);
  await expect(purchase.getByTestId('supplier-source')).toHaveText('Loading suppliers and items…');
  await context.setOffline(true);
  await expect(purchase).toHaveAttribute('data-purchase-ready', 'true');
  await expect(purchase.getByTestId('supplier-source')).toHaveText(
    'Offline: using the supplier list saved on this device (1 supplier).',
  );
  // The interrupted online load is not reported as an error: the device copy replaced it.
  await expect(page.getByRole('alert').filter({ hasText: /fetch|TypeError/i })).toHaveCount(0);
  await purchase.locator('.bill-details-toggle').click();
  await expect(purchase.locator('select[name="partyId"]')).toBeEnabled();
  await purchase.locator('select[name="partyId"]').selectOption({ label: 'Offline Supplier' });
});
