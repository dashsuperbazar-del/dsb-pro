import { test, expect, type Page } from '@playwright/test';
import { swReady } from './sw-ready';
import { fillBillItem, stockTask } from './design-helpers';

// Offline new items (mig 0071): an item created in a bill card while offline is saved on the device under
// a device id, synced BEFORE the bill that uses it, and the bill posts exactly once against it. An item the
// server refuses stays visible and its bill is refused too (never posted against a wrong item).

const PASSWORD = 'TestOnly-2026!pw';

async function createOwnerShop(page: Page) {
  await page.goto('/signup');
  await page
    .getByLabel('Email')
    .fill(`offline-item-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Offline Item Shop');
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

async function createInCard(page: Page, name: string, unit: string) {
  const purchase = purchaseSection(page);
  await purchase.getByLabel('Item 1 name', { exact: true }).fill(name);
  await purchase.getByRole('button', { name: `+ Create “${name}”` }).click();
  const form = purchase
    .getByRole('region', { name: 'Item 1', exact: true })
    .getByRole('group', { name: 'New item for item 1' });
  await form.getByLabel('Item 1 big unit').fill(unit);
  await form.getByRole('button', { name: 'Save item' }).click();
  await expect(form).toHaveCount(0);
}

async function saveBill(page: Page, billNo: string, qty: string, rate: string) {
  const purchase = purchaseSection(page);
  await purchase.locator('select[name="partyId"]').selectOption({ label: 'Item Supplier' });
  await purchase.locator('input[name="billNo"]').fill(billNo);
  await purchase.getByLabel('Item 1 quantity', { exact: true }).fill(qty);
  await purchase.getByLabel('Item 1 rate ₹', { exact: true }).fill(rate);
  await purchase
    .getByRole('button', { name: 'Save on this device (syncs later)', exact: true })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Saved on this device — will sync' }).first(),
  ).toBeVisible();
}

test('offline new items: created on the device, synced before their bill, posted once; a refused item holds its bill', async ({
  page,
  context,
}) => {
  test.setTimeout(120000);
  await createOwnerShop(page);
  await page.goto('/inventory');
  await stockTask(page, 'Suppliers');
  await page.getByPlaceholder('Supplier name').fill('Item Supplier');
  await page.getByRole('button', { name: 'Create supplier' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created supplier Item Supplier' }).first(),
  ).toBeVisible();

  await page.goto('/purchases?new=1');
  await waitForServiceWorker(page);
  await expect(purchaseSection(page).locator('input[name="date"]')).not.toHaveValue('');
  await page.goto('/sync');
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('0');
  await page.goto('/purchases?new=1');
  await expect(purchaseSection(page).locator('input[name="date"]')).not.toHaveValue('');

  // The server refuses one item (deterministic stand-in for "same name, other units" made elsewhere).
  let creates = 0;
  await page.route('**/rest/v1/rpc/create_item_v2', (route) => {
    creates++;
    if ((route.request().postData() ?? '').includes('Offline Bad Dal'))
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'P0001',
          message:
            'DSB_ITEM_NAME_TAKEN: an item called Offline Bad Dal already exists with different units; pick that item or use another name',
        }),
      });
    return route.continue();
  });
  const bills: string[] = [];
  await page.route('**/rest/v1/rpc/post_purchase_v2', (route) => {
    bills.push(route.request().postData() ?? '');
    return route.continue();
  });

  await swReady(page);

  await context.setOffline(true);
  await expect(purchaseSection(page).getByTestId('offline-post')).toContainText('syncs when you');
  await createInCard(page, 'Offline New Atta', 'bag');
  await saveBill(page, 'NEW-1', '4', '30');
  await createInCard(page, 'Offline Bad Dal', 'kg');
  await saveBill(page, 'BAD-1', '2', '50');
  expect(creates).toBe(0);
  await expect(pending(page).getByTestId('offline-item')).toHaveCount(2);
  await expect(
    pending(page).locator('[data-testid="offline-item"][data-status="QUEUED"]'),
  ).toHaveCount(2);

  // Restart offline: items and bills stay on the device; the new item is still offered in a card.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(pending(page).getByTestId('offline-purchase')).toHaveCount(2);
  await expect(pending(page).getByTestId('offline-item')).toHaveCount(2);
  await fillBillItem(purchaseSection(page), 1, 'Offline New Atta', '1', '30');

  // Back online: item first, then its bill. The refused item holds its bill (never posted).
  await context.setOffline(false);
  await page.goto('/sync');
  await page.getByRole('button', { name: 'Retry queued work now' }).click();
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('0', { timeout: 20000 });
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('0');
  // A send whose answer was lost is resent under the same ids (idempotent); the server state below is
  // what counts: one item, one bill.
  expect(creates).toBeGreaterThanOrEqual(2);
  expect(bills.filter((b) => b.includes('NEW-1')).length).toBeGreaterThanOrEqual(1);
  expect(bills.filter((b) => b.includes('BAD-1'))).toHaveLength(0);

  await page.goto('/purchases?new=1');
  await expect(
    pending(page).locator('[data-testid="offline-item"][data-status="SYNCED"]'),
  ).toContainText('Offline New Atta');
  const badItem = pending(page).locator('[data-testid="offline-item"][data-status="REJECTED"]');
  await expect(badItem).toContainText('already exists with different units');
  await expect(
    pending(page).locator('[data-testid="offline-purchase"][data-status="SYNCED"]'),
  ).toContainText('NEW-1');
  const badBill = pending(page).locator('[data-testid="offline-purchase"][data-status="REJECTED"]');
  await expect(badBill).toContainText('BAD-1');
  await expect(badBill).toContainText('Offline Bad Dal');
  await expect(
    badBill.getByRole('button', { name: 'Correct this bill', exact: true }),
  ).toBeVisible();

  await page.getByRole('link', { name: 'Bill list', exact: true }).click();
  await expect(page.getByRole('button', { name: /Item Supplier.*NEW-1/ })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /BAD-1/ })).toHaveCount(0);

  // Stock and catalog: the new item exists once on the server with the bill's quantity; the refused one never.
  await page.goto('/inventory');
  await stockTask(page, 'Items');
  await page.getByLabel('Item details').selectOption({ label: 'Offline New Atta' });
  await expect(page.getByLabel('item peek')).toContainText('Stock 4 bag');
  await expect(
    page.getByLabel('Item details').locator('option', { hasText: 'Offline Bad Dal' }),
  ).toHaveCount(0);
});
