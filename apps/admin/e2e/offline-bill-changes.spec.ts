import { test, expect, type Page } from '@playwright/test';
import { addItemForm, fillBillItem, stockTask } from './design-helpers';

// Offline bill edit / void (mig 0072): saved on the device with the bill's version, applied on reconnect only
// if the bill is unchanged; a bill changed elsewhere meanwhile is refused and shown with the full form.

const PASSWORD = 'TestOnly-2026!pw';

async function createOwnerShop(page: Page) {
  await page.goto('/signup');
  await page
    .getByLabel('Email')
    .fill(`offline-change-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Offline Change Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/Overview/)).toBeVisible();
}

const section = (page: Page, heading: string) =>
  page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: heading, exact: true }) })
    .last();
const pending = (page: Page) => page.getByLabel('Purchases saved on this device');

async function postBill(page: Page, billNo: string, qty: string) {
  await page.goto('/purchases?new=1');
  const post = section(page, 'Post purchase');
  await expect(post.locator('input[name="date"]')).not.toHaveValue('');
  await post.locator('select[name="partyId"]').selectOption({ label: 'Change Supplier' });
  await post.locator('input[name="billNo"]').fill(billNo);
  await fillBillItem(post, 1, 'Change Rice', qty, '10');
  await post.getByRole('button', { name: 'Post purchase', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Purchase posted (1 item)' }).first(),
  ).toBeVisible();
}
async function openBill(page: Page, billNo: string) {
  await page.goto('/purchases');
  await page.getByRole('button', { name: new RegExp(`Change Supplier.*${billNo}`) }).click();
  return page.getByLabel('Purchase detail');
}
async function openEdit(page: Page, billNo: string) {
  const detail = await openBill(page, billNo);
  await detail.getByTestId('edit-bill').click();
  const edit = section(page, 'Edit bill');
  await expect(edit.getByLabel('Item 1 quantity', { exact: true })).not.toHaveValue('');
  // The version is read with the bill; give it a moment before the connection drops.
  await page.waitForLoadState('networkidle');
  return edit;
}
async function syncAll(page: Page) {
  await page.goto('/sync');
  await page.getByRole('button', { name: 'Retry queued work now' }).click();
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('0', { timeout: 20000 });
}
async function stock(page: Page) {
  await page.goto('/inventory');
  await stockTask(page, 'Items');
  await page.getByLabel('Item details').selectOption({ label: 'Change Rice' });
  return page.getByLabel('item peek');
}

test('offline bill edit and void: applied on reconnect when unchanged; a bill changed elsewhere is refused with its form', async ({
  page,
  context,
}) => {
  test.setTimeout(180000);
  page.on('dialog', (d) => void d.accept());
  await createOwnerShop(page);
  await page.goto('/inventory');
  await stockTask(page, 'Suppliers');
  await page.getByPlaceholder('Supplier name').fill('Change Supplier');
  await page.getByRole('button', { name: 'Create supplier' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created supplier Change Supplier' }).first(),
  ).toBeVisible();
  await addItemForm(page);
  await page.getByPlaceholder('Item name').fill('Change Rice');
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created Change Rice' }).first(),
  ).toBeVisible();
  await postBill(page, 'ED-1', '2');
  await postBill(page, 'VO-1', '3');
  await postBill(page, 'ST-1', '4');
  await expect(await stock(page)).toContainText('Stock 9 piece');
  await page.goto('/sync');
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('0');

  // 1. Edit opened online, saved offline, kept over a restart, applied on reconnect.
  const edit = await openEdit(page, 'ED-1');
  await context.setOffline(true);
  await edit.getByLabel('Item 1 quantity', { exact: true }).fill('5');
  await edit
    .getByRole('button', { name: 'Save edit on this device (syncs later)', exact: true })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Edit saved on this device — will sync' }).first(),
  ).toBeVisible();
  await page.goto('/purchases?new=1');
  const queuedEdit = pending(page).locator(
    '[data-testid="offline-bill-change"][data-status="QUEUED"]',
  );
  await expect(queuedEdit).toContainText('bill ED-1');
  await expect(queuedEdit).toContainText('5 piece Change Rice');
  await context.setOffline(false);
  await syncAll(page);
  await expect(await stock(page)).toContainText('Stock 12 piece');

  // 2. Void opened online, saved offline, applied on reconnect.
  const detail = await openBill(page, 'VO-1');
  await page.waitForLoadState('networkidle');
  await context.setOffline(true);
  await detail.getByLabel('Reason for voiding').fill('entered twice');
  await detail.getByRole('button', { name: 'Void bill', exact: true }).click();
  await expect(detail.getByText('Void saved on this device — will sync')).toBeVisible();
  await context.setOffline(false);
  await syncAll(page);
  await expect(await stock(page)).toContainText('Stock 9 piece');

  // 3. Stale: the edit form was read, then the bill was voided online elsewhere; the offline edit is refused.
  const staleEdit = await openEdit(page, 'ST-1');
  const other = await context.newPage();
  other.on('dialog', (d) => void d.accept());
  const otherDetail = await openBill(other, 'ST-1');
  await otherDetail.getByLabel('Reason for voiding').fill('wrong supplier');
  await otherDetail.getByRole('button', { name: 'Void bill', exact: true }).click();
  await expect(other.getByRole('status').filter({ hasText: 'Bill voided' }).first()).toBeVisible();
  await other.close();
  await context.setOffline(true);
  await staleEdit.getByLabel('Item 1 quantity', { exact: true }).fill('8');
  await staleEdit
    .getByRole('button', { name: 'Save edit on this device (syncs later)', exact: true })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Edit saved on this device — will sync' }).first(),
  ).toBeVisible();
  await context.setOffline(false);
  await syncAll(page);
  await page.goto('/purchases?new=1');
  const refused = pending(page).locator(
    '[data-testid="offline-bill-change"][data-status="REJECTED"]',
  );
  await expect(refused).toContainText('bill ST-1');
  await expect(refused).toContainText('changed after the edit was saved');
  await expect(refused).toContainText('8 piece Change Rice');
  await expect(refused.getByRole('link', { name: 'Redo this edit' })).toBeVisible();
  // ST-1 was voided online (4 off); the refused edit changed nothing.
  await expect(await stock(page)).toContainText('Stock 5 piece');
});
