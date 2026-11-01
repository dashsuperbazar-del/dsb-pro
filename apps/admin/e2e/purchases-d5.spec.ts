import { test, expect } from '@playwright/test';
import { fillBillItem } from './design-helpers';
import { setupPosShop } from './pos-shop-setup';
import { swReady } from './sw-ready';
// D5: Purchases + Suppliers presentation. The pending-purchase review, the collapsed Filter row, the
// Owed chip, the Void menu and the supplier empty state. No money behaviour is exercised beyond a retry
// that must still post exactly once.
const PASSWORD = 'TestOnly-2026!pw';

test('pending purchase: Review brings the block into view, shows the bill and the retry states the amount', async ({
  page,
}) => {
  test.setTimeout(180000);
  await setupPosShop(page, 'd5-pending');
  await page.goto('/purchases?new=1');
  await swReady(page);
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase', exact: true }) })
    .last();
  await expect(purchase).toHaveAttribute('data-purchase-ready', 'true');
  await purchase.locator('input[name="billNo"]').fill('D5-PEND');
  await purchase.locator('select[name="partyId"]').selectOption({ label: 'Sharma Traders' });
  await fillBillItem(purchase, 1, 'Basmati rice 1kg', '3', '1000');
  let calls = 0;
  await page.route('**/rpc/post_purchase_v2', async (route) => {
    if (calls++ === 0) {
      await route.fetch(); // committed on the server ...
      await route.abort('connectionreset'); // ... the answer is lost
    } else await route.continue();
  });
  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  const block = page.locator('#pending-purchase');
  await expect(block).toContainText('may already be saved');
  // The bill is named: supplier, bill number, items and total. Nothing is clipped by the sticky bar.
  await expect(block).toContainText('Sharma Traders');
  await expect(block).toContainText('D5-PEND');
  await expect(block).toContainText('₹3,000.00');
  const retry = page.getByRole('button', { name: 'Retry same purchase · ₹3,000.00' });
  await expect(retry).toBeVisible();
  // Reload: the screen opens with the top note; "Review pending purchase" must do something.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Review pending purchase' })).toBeVisible();
  await page.getByRole('button', { name: 'Review pending purchase' }).click();
  await expect(block).toBeFocused();
  await expect(block).toBeInViewport({ ratio: 1 });
  const bar = await page.locator('.bill-bar').boundingBox();
  const box = await block.boundingBox();
  expect(bar && box && box.y + box.height <= bar.y).toBe(true);
  await page.getByRole('button', { name: 'Retry same purchase · ₹3,000.00' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Purchase posted (1 item)' }).first(),
  ).toBeVisible();
  await expect(page.locator('#pending-purchase')).toHaveCount(0);
  // Exactly one bill exists: the retry replayed the same request.
  await page.goto('/purchases');
  await expect(page.getByRole('button', { name: /D5-PEND/ })).toHaveCount(1);
});

test('purchases list: Filter row starts collapsed with a summary; credit bills read Owed', async ({
  page,
}) => {
  test.setTimeout(180000);
  await setupPosShop(page, 'd5-list');
  await page.goto('/purchases');
  const row = page.locator('.home-row-toggle').filter({ hasText: /^Filter/ });
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await expect(row).toContainText('All bills');
  // The bill list starts right under the Filter row, not under five controls.
  const rowBox = (await row.boundingBox())!;
  const bill = page.getByRole('button', { name: /D4-STOCK/ });
  await expect(bill).toBeVisible();
  expect((await bill.boundingBox())!.y - rowBox.y).toBeLessThan(160);
  // A credit bill is "Owed" (amber), not "Unpaid" (red); the amount has a thousands separator.
  await expect(bill.getByTestId('list-settlement')).toHaveText('Owed');
  await expect(bill).toContainText('₹38,000.00');
  await expect(bill).not.toContainText('Unpaid');
  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  await page.getByLabel('Status').selectOption('paid');
  await expect(row).toContainText('Paid');
  await expect(page.getByRole('button', { name: /D4-STOCK/ })).toHaveCount(0);
  await page.getByLabel('Status').selectOption('unpaid');
  await expect(row).toContainText('Owed');
  await expect(page.getByRole('button', { name: /D4-STOCK/ })).toBeVisible();
  // Open the bill: main actions are buttons, Void is behind More, Payments can be folded.
  await page.getByRole('button', { name: /D4-STOCK/ }).click();
  const detail = page.getByLabel('Purchase detail');
  await expect(detail.getByRole('link', { name: 'Pay', exact: true })).toBeVisible();
  await expect(detail.getByRole('link', { name: 'Edit bill' })).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Remarks' })).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Void bill', exact: true })).toBeHidden();
  await detail.getByRole('button', { name: 'More actions for this bill' }).click();
  await detail.getByRole('menuitem', { name: 'Void bill…' }).click();
  await expect(detail.getByLabel('Reason for voiding')).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Void bill', exact: true })).toBeVisible();
  const payments = detail.locator('.home-row-toggle').filter({ hasText: /^Payments/ });
  await expect(payments).toContainText('Due ₹38,000.00');
});

test('suppliers: an empty shop gets an empty state whose action adds a supplier', async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/signup');
  await page.getByLabel('Email').fill(`d5-empty-${Date.now()}-${Math.random()}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Empty Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.goto('/suppliers');
  const empty = page.getByTestId('suppliers-empty');
  await expect(empty).toContainText('No suppliers yet');
  // No stray Home link next to the Suppliers / Customers tabs.
  await expect(
    page.getByRole('main').locator('.row').first().getByRole('link', { name: 'Home' }),
  ).toHaveCount(0);
  await empty.getByRole('button', { name: 'Add a supplier' }).click();
  await empty.getByLabel('Supplier name').fill('First Supplier');
  await empty.getByRole('button', { name: 'Save supplier' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Created supplier' })).toBeVisible();
  // The supplier is now selected and has no bills yet; the card says so instead of "No suppliers yet".
  await expect(page.getByLabel('Supplier', { exact: true })).toHaveValue(/.+/);
  await expect(page.getByLabel('Supplier', { exact: true })).toContainText('First Supplier');
  await expect(page.getByTestId('suppliers-empty')).toContainText('No supplier bills yet');
});
