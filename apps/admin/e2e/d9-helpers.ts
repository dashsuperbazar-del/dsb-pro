import { expect, type BrowserContext, type Page } from '@playwright/test';
import { swReady } from './sw-ready';
import { addItemForm, stockTask } from './design-helpers';

// Shared by d9-sync-review.spec.ts: owner shop, a refused offline item create that holds a queued bill.

export const PASSWORD = 'TestOnly-2026!pw';
export const NAME_TAKEN =
  'DSB_ITEM_NAME_TAKEN: an item called Camel match box already exists with different units; pick that item or use another name';

export async function createOwnerShop(page: Page) {
  await page.goto('/signup');
  await page
    .getByLabel('Email')
    .fill(`d9-sync-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('D9 Sync Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/Overview/)).toBeVisible();
}

export async function waitForServiceWorker(page: Page) {
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

export const purchaseSection = (page: Page) =>
  page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase', exact: true }) })
    .last();

export async function createInCard(page: Page, name: string, unit: string) {
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

export async function saveBill(page: Page, billNo: string, qty: string, rate: string) {
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

export type Seen = { bills: string[]; creates: string[] };

/** Owner shop + a refused offline item create ("box") that holds one queued bill. Ends on /sync. */
export async function seedRefusedItem(page: Page, context: BrowserContext): Promise<Seen> {
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

  const seen: Seen = { bills: [], creates: [] };
  await page.route('**/rest/v1/rpc/create_item_v2', (route) => {
    const body = route.request().postData() ?? '';
    seen.creates.push(body);
    if (body.includes('"name":"Camel match box"') && body.includes('"unit1":"box"'))
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'P0001', message: NAME_TAKEN }),
      });
    return route.continue();
  });
  await page.route('**/rest/v1/rpc/post_purchase_v2', (route) => {
    seen.bills.push(route.request().postData() ?? '');
    return route.continue();
  });
  await swReady(page);
  await context.setOffline(true);
  await expect(purchaseSection(page).getByTestId('offline-post')).toContainText('syncs when you');
  await createInCard(page, 'Camel match box', 'box');
  await saveBill(page, 'BAD-12', '2', '50');
  await context.setOffline(false);
  await page.goto('/sync');
  await page.getByRole('button', { name: 'Retry queued work now' }).click();
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('0', { timeout: 20000 });
  return seen;
}

/** The shop's own item with the same name and other units (what the server clash is about). */
export async function createExistingItem(page: Page) {
  await page.goto('/inventory');
  await addItemForm(page);
  await page.getByPlaceholder('Item name').fill('Camel match box');
  await page.getByPlaceholder('Big unit (e.g. case)').fill('pcs');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created Camel match box' }).first(),
  ).toBeVisible();
  await page.goto('/sync');
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('0');
}

export const cards = (page: Page) => page.getByTestId('review-card');

export async function seedLocalConflict(page: Page, target: string, clientId: string) {
  await page.evaluate(
    async ({ target, clientId }) => {
      const dbs = await indexedDB.databases();
      for (const info of dbs) {
        if (!info.name) continue;
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open(info.name!);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        if (db.objectStoreNames.contains('conflicts') && db.objectStoreNames.contains('outbox')) {
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('conflicts', 'readwrite');
            tx.objectStore('conflicts').add({
              createdAt: Date.now(),
              status: 'OPEN',
              kind: 'financial-rejection',
              target,
              clientId,
              reason: 'DSB_PAYLOAD_MISMATCH: seeded for the test',
              payload: null,
              serverRef: null,
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
        }
        db.close();
      }
    },
    { target, clientId },
  );
}
