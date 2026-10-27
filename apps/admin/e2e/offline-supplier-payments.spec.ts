import { test, expect, type Page } from '@playwright/test';
import { swReady } from './sw-ready';
import { addItemForm, fillBillItem, stockTask } from './design-helpers';

// Offline supplier payments (mig 0074): saved on the device with the supplier/bill versions, applied on
// reconnect only if unchanged; a bill changed elsewhere meanwhile is refused with the full form; a double tap
// never records twice; the supplier's balance changes only after the server confirms.

const PASSWORD = 'TestOnly-2026!pw';

async function createOwnerShop(page: Page) {
  await page.goto('/signup');
  await page
    .getByLabel('Email')
    .fill(`offline-pay-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Offline Pay Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/Overview/)).toBeVisible();
}

const section = (page: Page, heading: string) =>
  page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: heading, exact: true }) })
    .last();
const panel = (page: Page) => page.getByTestId('pay-supplier');
const rows = (page: Page, status: string) =>
  page.locator(`[data-testid="offline-supplier-payment"][data-status="${status}"]`);

async function postBill(page: Page, billNo: string, qty: string) {
  await page.goto('/purchases?new=1');
  const post = section(page, 'Post purchase');
  await expect(post.locator('input[name="date"]')).not.toHaveValue('');
  await post.locator('select[name="partyId"]').selectOption({ label: 'Pay Supplier Co' });
  await post.locator('input[name="billNo"]').fill(billNo);
  await fillBillItem(post, 1, 'Pay Rice', qty, '10');
  await post.getByRole('button', { name: 'Post purchase', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Purchase posted (1 item)' }).first(),
  ).toBeVisible();
}
async function syncAll(page: Page) {
  await page.goto('/sync');
  await page.getByRole('button', { name: 'Retry queued work now' }).click();
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('0', { timeout: 20000 });
}
async function openSuppliersOnline(page: Page) {
  await page.goto('/suppliers');
  // Online: the saved copy is refreshed (plain note, no "offline"/"could not refresh" warning).
  await expect(page.getByTestId('pay-copy-note')).toContainText(
    'Supplier list saved on this device',
  );
  return panel(page);
}
async function fillPayment(
  page: Page,
  amount: string,
  bill: { label: string; amount: string } | null,
) {
  const pay = panel(page);
  await pay.getByLabel('Supplier to pay').selectOption({ index: 1 });
  await pay.getByLabel('Amount to pay').fill(amount);
  if (bill) await pay.getByLabel(new RegExp(`Assign to bill ${bill.label}`)).fill(bill.amount);
  await pay.getByRole('button', { name: 'Check and save', exact: true }).click();
}

test('offline supplier payment: saved on the device, applied on reconnect; stale bill refused; no duplicate', async ({
  page,
  context,
}) => {
  test.setTimeout(240000);
  page.on('dialog', (d) => void d.accept());
  await createOwnerShop(page);
  await page.goto('/inventory');
  await stockTask(page, 'Suppliers');
  await page.getByPlaceholder('Supplier name').fill('Pay Supplier Co');
  await page.getByRole('button', { name: 'Create supplier' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created supplier Pay Supplier Co' }).first(),
  ).toBeVisible();
  await addItemForm(page);
  await page.getByPlaceholder('Item name').fill('Pay Rice');
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created Pay Rice' }).first(),
  ).toBeVisible();
  await postBill(page, 'PS-1', '10'); // 100.00
  await postBill(page, 'PS-2', '5'); //   50.00
  await page.goto('/sync');
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('0');

  // 1. Online load saves the copy; then the device goes offline.
  let pay = await openSuppliersOnline(page);
  await expect(pay.getByLabel('Supplier to pay')).toContainText('owed ₹150.00');
  await swReady(page);
  await context.setOffline(true);
  await page.goto('/suppliers');
  await expect(page.getByTestId('pay-copy-note')).toContainText('You are offline');
  await expect(page.getByTestId('pay-copy-note')).toContainText('saved on this device');
  pay = panel(page);
  await expect(pay.getByLabel('Supplier to pay')).toContainText('Pay Supplier Co — owed ₹150.00');

  // 2. A payment saved offline: review says it is not in the balance yet; the double tap saves once.
  await fillPayment(page, '60', { label: 'PS-1', amount: '60' });
  const review = pay.getByTestId('pay-review');
  await expect(review).toContainText('Saved on this device, not yet in the supplier’s balance.');
  await expect(review).toContainText('PS-1 ₹60.00');
  await review.getByRole('button', { name: 'Save on this device', exact: true }).dblclick();
  await expect(rows(page, 'QUEUED')).toHaveCount(1);
  await expect(rows(page, 'QUEUED').first()).toContainText('Saved on this device — will sync');
  await expect(rows(page, 'QUEUED').first()).toContainText('₹60.00');
  // The device balance did NOT change.
  await expect(pay.getByLabel('Supplier to pay')).toContainText('owed ₹150.00');

  // 3. The second payment sees the first: 90.01 is more than the 90.00 still to pay; 90.00 is fine.
  await fillPayment(page, '90.01', null);
  await expect(pay.locator('#pay-amount-error')).toContainText(
    'more than is owed to Pay Supplier Co',
  );
  await pay.getByLabel('Amount to pay').fill('40');
  await pay.getByLabel(/Assign to bill PS-1/).fill('40');
  await pay.getByRole('button', { name: 'Check and save', exact: true }).click();
  await pay.getByRole('button', { name: 'Save on this device', exact: true }).click();
  await expect(rows(page, 'QUEUED')).toHaveCount(2);

  // 4. Reconnect: both apply in order, once each; the balance changes only now.
  await context.setOffline(false);
  await syncAll(page);
  pay = await openSuppliersOnline(page);
  await expect(pay.getByLabel('Supplier to pay')).toContainText('owed ₹50.00');
  await expect(rows(page, 'SYNCED')).toHaveCount(2);
  await expect(rows(page, 'QUEUED')).toHaveCount(0);

  // 5. Stale bill: the device saved a payment for PS-2 (₹50.00 left), then PS-2 was voided elsewhere.
  await page.reload();
  pay = panel(page);
  await expect(page.getByTestId('pay-copy-note')).toContainText(
    'Supplier list saved on this device',
  );
  const other = await context.newPage();
  other.on('dialog', (d) => void d.accept());
  await other.goto('/purchases');
  await other.getByRole('button', { name: /Pay Supplier Co.*PS-2/ }).click();
  const detail = other.getByLabel('Purchase detail');
  await detail.getByLabel('Reason for voiding').fill('wrong supplier');
  await detail.getByRole('button', { name: 'Void bill', exact: true }).click();
  await expect(other.getByRole('status').filter({ hasText: 'Bill voided' }).first()).toBeVisible();
  await other.close();
  await swReady(page);
  await context.setOffline(true);
  await fillPayment(page, '10', { label: 'PS-2', amount: '10' });
  await pay.getByRole('button', { name: 'Save on this device', exact: true }).click();
  await expect(rows(page, 'QUEUED')).toHaveCount(1);
  await context.setOffline(false);
  await syncAll(page);
  await page.goto('/suppliers');
  const refused = rows(page, 'REJECTED');
  await expect(refused).toHaveCount(1);
  await expect(refused).toContainText('Refused by the server — not recorded');
  await expect(refused).toContainText('changed after you saved it');
  await expect(refused).toContainText('Nothing was recorded');
  await expect(refused).toContainText('PS-2 ₹10.00');
  await refused.getByRole('button', { name: 'Redo this payment' }).click();
  await expect(panel(page).getByLabel('Amount to pay')).toHaveValue('10');
  // Nothing was moved to another bill or recorded: PS-1 is fully paid, PS-2 is void, so nothing is owed.
  await expect(panel(page).getByLabel('Supplier to pay')).toContainText('owed ₹0.00');
});
