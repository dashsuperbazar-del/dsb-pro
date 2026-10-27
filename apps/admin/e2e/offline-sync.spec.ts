import { stockTask, addItemForm, reviewPayment, fillBillItem } from './design-helpers';
import { test, expect } from '@playwright/test';
import { addByTap } from './pos-shop-setup';

const PASSWORD = 'TestOnly-2026!pw';
function uniqueEmail() {
  return `offline-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

async function createOwnerShop(page: import('@playwright/test').Page) {
  await page.goto('/signup');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Offline Chaos Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/Overview/)).toBeVisible();
}

async function seedOfflineItem(page: import('@playwright/test').Page) {
  await page.goto('/inventory');
  await addItemForm(page);
  await page.getByPlaceholder('Item name').fill('Offline E2E Item');
  await page.getByPlaceholder('SKU', { exact: true }).fill(`OFF-${Date.now()}`);
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created Offline E2E Item' }).first(),
  ).toBeVisible();
  await stockTask(page, 'Items');
  await page.getByLabel('Item details').selectOption({ label: 'Offline E2E Item' });
  const priceForm = page.getByRole('button', { name: 'Set price' }).locator('xpath=..');
  await priceForm.locator('input[name="price"]').fill('10');
  await page.getByRole('button', { name: 'Set price' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Price history updated' }).first(),
  ).toBeVisible();
  await stockTask(page, 'Purchases');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase' }) });
  await fillBillItem(purchase, 1, 'Offline E2E Item', '3', '5');
  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  await expect(page.getByRole('status')).toContainText(
    'Purchase posted (1 item) and stock updated',
  );
  await page.waitForTimeout(1200);
  await page.goto('/sync');
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('0');
}

async function addOnePaidLine(page: import('@playwright/test').Page) {
  await addByTap(page, 'Offline E2E Item', '1');
  await expect(
    page.locator('section').filter({ has: page.getByRole('heading', { name: 'Current bill' }) }),
  ).toContainText('Offline E2E Item');
  await reviewPayment(page);
  await page.getByLabel('Amount ₹').first().fill('10');
}

test('chaos: airplane mode + app restart + logical one-hour outage preserves and later syncs sales', async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  await createOwnerShop(page);
  await seedOfflineItem(page);
  await page.goto('/pos');
  await expect(page.getByRole('heading', { name: 'Sales POS' })).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error('service worker did not claim the current page')),
          5000,
        );
        navigator.serviceWorker.addEventListener(
          'controllerchange',
          () => {
            window.clearTimeout(timeout);
            resolve();
          },
          { once: true },
        );
      });
    }
    const keys = await caches.keys();
    if (!keys.some((key) => key.startsWith('dsb-pro-shell-')))
      throw new Error('offline app-shell cache was not created');
  });

  // Begin a real bill while online, then lose the backend before finalization.
  await addOnePaidLine(page);
  await context.setOffline(true);
  await reviewPayment(page);
  await page.getByRole('button', { name: 'Finalize sale' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Saved locally as T-' }).first(),
  ).toBeVisible();
  await expect(page.locator('section[aria-label="Local offline sales"]')).toContainText('waiting');
  // D3: the saved-sales row is collapsed by default; open it first.
  await page.locator('section[aria-label="Local offline sales"] .home-row-toggle').click();
  await page.getByRole('button', { name: 'Print provisional' }).first().click();
  await expect(page.locator('[aria-label="provisional offline receipt"]')).toContainText(
    'PROVISIONAL — PENDING SYNC',
  );
  // D2a: offline, the receipt still names the shop from the cached profile (never "DSB Store").
  await expect(page.locator('[aria-label="provisional offline receipt"] h1')).toHaveText(
    'Offline Chaos Shop',
  );

  // Kill/reload the SPA while still offline. The service worker must boot the
  // app shell and IndexedDB must retain both the outbox and cached shop data.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Sales POS' })).toBeVisible();
  await expect(page.locator('section[aria-label="Local offline sales"]')).toContainText('waiting');

  // Simulate that the backend has remained unavailable for one hour. Sync
  // retries may run, but the first queued bill must remain durable.
  // Age the durable records instead of moving only the browser clock. Moving
  // the browser one hour ahead while the test Supabase server stays put creates
  // artificial JWT clock skew and tests clock corruption, not a one-hour
  // backend outage.
  await page.evaluate(async () => {
    const infos = await indexedDB.databases();
    const name = infos.map((x) => x.name).find((x) => x?.startsWith('dsb-pro-sync-'));
    if (!name) throw new Error('sync database was not created');
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(['outbox', 'offlineSales'], 'readwrite');
        const ageStore = (storeName: string) => {
          const store = tx.objectStore(storeName);
          const cursor = store.openCursor();
          cursor.onerror = () => reject(cursor.error);
          cursor.onsuccess = () => {
            const current = cursor.result;
            if (!current) return;
            current.update({
              ...current.value,
              createdAt: current.value.createdAt - 60 * 60 * 1000,
            });
            current.continue();
          };
        };
        ageStore('outbox');
        ageStore('offlineSales');
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('failed to age offline records'));
      };
    });
  });
  await addOnePaidLine(page);
  await reviewPayment(page);
  await page.getByRole('button', { name: 'Finalize sale' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Saved locally as T-' }).first(),
  ).toBeVisible();

  // Navigate through the running SPA while still offline. This is the real
  // PWA user path; it must not depend on a new network navigation.
  await page.getByRole('link', { name: 'Sync & offline' }).click();
  await expect(page.getByRole('heading', { name: 'Sync & offline' })).toBeVisible();
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('2');
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('2');

  // Network returns: ordered outbox drains, official numbering replaces the
  // two provisional identities, and no financial event is duplicated.
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Retry queued work now' }).click();
  try {
    await expect(page.getByTestId('sync-outbox-count')).toHaveText('0', { timeout: 15000 });
  } catch (error) {
    console.log(
      'SYNC HEALTH ON RECOVERY FAILURE:\n' +
        (await page.locator('section[aria-label="Sync health"]').innerText()),
    );
    throw error;
  }
  await expect(page.getByTestId('sync-queued-sales')).toHaveText('0');
  const rows = page.locator('section[aria-label="Offline sales"] tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('SYNCED');
  await expect(rows.nth(1)).toContainText('SYNCED');

  await page.goto('/sales-history');
  const reconciliation = page.locator('section[aria-label="Day reconciliation"]');
  await expect(
    reconciliation.locator('tr').filter({ hasText: 'Finalized invoices' }),
  ).toContainText('2');
  await expect(reconciliation.locator('tr').filter({ hasText: 'Sales total' })).toContainText(
    '₹20.00',
  );

  await page.goto('/inventory');
  await stockTask(page, 'Items');
  await page.getByLabel('Item details').selectOption({ label: 'Offline E2E Item' });
  await expect(page.locator('[aria-label="item peek"]')).toContainText('Stock 1 piece');
});
