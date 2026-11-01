import { test, expect } from '@playwright/test';
import type { Browser } from '@playwright/test';
import {
  PASSWORD,
  cards,
  createExistingItem,
  createOwnerShop,
  seedLocalConflict,
  seedRefusedItem,
} from './d9-helpers';
import { stockTask } from './design-helpers';
import type { Page } from '@playwright/test';

// D9: the Sync screen shows ONE card per refused/changed event (device alert + shop record merged), with
// fixes in place for a refused item (use the existing item / rename and create), one-click "Mark reviewed"
// and a confirmed bulk "Mark all reviewed". The refusal is the same fault injection offline-new-items uses.

test('one refused item shows ONE merged card with plain words; Mark reviewed clears device and shop together', async ({
  page,
  context,
}) => {
  test.setTimeout(150000);
  await seedRefusedItem(page, context);
  await expect(cards(page)).toHaveCount(1, { timeout: 20000 });
  const card = cards(page).first();
  await expect(card).toContainText("New item 'Camel match box' was not created");
  await expect(card).toContainText('already exists with different units');
  await expect(card).toContainText('Bills waiting on this item');
  await expect(card).toContainText('Purchase BAD-12 for Item Supplier');
  await expect(card).toContainText('On this device and recorded for the shop', { timeout: 20000 });
  await expect(page.getByTestId('sync-headline')).toHaveText('1 needs your attention');
  await expect(page.getByTestId('sync-chip-attention')).toHaveText('1 need attention');
  // Raw type/op/id only inside the collapsed Details.
  await expect(card.locator('.review-raw')).toBeHidden();
  await expect(card.getByText('create_item_v2')).toBeHidden();
  await card.getByText('Details', { exact: true }).click();
  await expect(card.locator('.review-raw')).toContainText('create_item_v2');
  // The old duplicated lists and buttons are gone.
  await expect(page.getByRole('button', { name: 'Mark reviewed locally' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mark reviewed for shop' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Mark reviewed', exact: true })).toHaveCount(1);

  // Double tap is safe; the alert disappears on the device AND for the shop (it does not come back).
  const mark = card.getByRole('button', { name: 'Mark reviewed', exact: true });
  await mark.dblclick();
  await expect(page.getByTestId('review-empty')).toBeVisible();
  await expect(page.getByTestId('review-note')).toContainText('Nothing was changed or posted');
  await page.reload();
  await expect(page.getByTestId('review-empty')).toBeVisible();
  await expect(page.getByTestId('sync-chip-attention')).toHaveText('0 need attention');
  // The underlying records stay: the refused item and its held bill are still listed in Purchases.
  await page.goto('/purchases?new=1');
  const pending = page.getByLabel('Purchases saved on this device');
  await expect(pending.locator('[data-testid="offline-item"][data-status="REJECTED"]')).toHaveCount(
    1,
  );
  await expect(
    pending.locator('[data-testid="offline-purchase"][data-status="REJECTED"]'),
  ).toContainText('BAD-12');
});

test('Use the existing item: side by side, explicit confirm, the held bill posts once against the existing item', async ({
  page,
  context,
}) => {
  test.setTimeout(150000);
  const seen = await seedRefusedItem(page, context);
  await createExistingItem(page);
  const card = cards(page).first();
  await expect(card).toBeVisible({ timeout: 20000 });
  await card.getByRole('button', { name: 'Use the existing item' }).click();
  const panel = card.getByRole('group', { name: 'Use the existing item' });
  await expect(panel).toContainText('Your new item (refused)');
  await expect(panel).toContainText('Existing item in the shop');
  await expect(panel).toContainText('box only');
  await expect(panel).toContainText('pcs only');
  const use = panel.getByRole('button', { name: 'Use this item' });
  await expect(use).toBeDisabled();
  await panel.getByLabel('These are the same product').check();
  await use.dblclick();
  await expect(page.getByTestId('review-note')).toContainText("Using 'Camel match box'");
  await expect(page.getByTestId('review-empty')).toBeVisible();
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('0', { timeout: 20000 });
  await expect.poll(() => seen.bills.filter((b) => b.includes('BAD-12')).length).toBeGreaterThan(0);
  // Exactly one bill exists on the server; the refused item was never created.
  await page.goto('/purchases?new=1');
  await page.getByRole('link', { name: 'Bill list', exact: true }).click();
  await expect(page.getByRole('button', { name: /Item Supplier.*BAD-12/ })).toHaveCount(1);
});

test('Rename and create: one new item, the held bill follows it and posts', async ({
  page,
  context,
}) => {
  test.setTimeout(150000);
  const seen = await seedRefusedItem(page, context);
  const card = cards(page).first();
  await expect(card).toBeVisible({ timeout: 20000 });
  await card.getByRole('button', { name: 'Rename and create' }).click();
  const panel = card.getByRole('group', { name: 'Rename and create' });
  await expect(panel.getByLabel('New item name')).toHaveValue('Camel match box (box)');
  await expect(panel).toContainText('Suggestion: Camel match box (box)');
  await panel.getByLabel('New item name').fill('Camel match box 12 pcs');
  await panel.getByRole('button', { name: 'Create with this name' }).dblclick();
  await expect(page.getByTestId('review-note')).toContainText("Creating 'Camel match box 12 pcs'");
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('0', { timeout: 20000 });
  await expect(page.getByTestId('review-empty')).toBeVisible();
  await expect.poll(() => seen.bills.filter((b) => b.includes('BAD-12')).length).toBeGreaterThan(0);
  // One create under the new name (a resend after a lost answer would carry the same ids).
  const renamed = seen.creates.filter((b) => b.includes('Camel match box 12 pcs'));
  expect(new Set(renamed.map((b) => JSON.parse(b).p_client_id ?? b)).size).toBe(1);
  await page.goto('/inventory');
  await stockTask(page, 'Items');
  await expect(
    page.getByLabel('Item details').locator('option', { hasText: 'Camel match box 12 pcs' }),
  ).toHaveCount(1);
  await page.goto('/purchases?new=1');
  await page.getByRole('link', { name: 'Bill list', exact: true }).click();
  await expect(page.getByRole('button', { name: /Item Supplier.*BAD-12/ })).toHaveCount(1);
});

test('Mark all reviewed: the dialog lists each item, flags money, and only marks what it listed', async ({
  page,
  context,
}) => {
  test.setTimeout(150000);
  await seedRefusedItem(page, context);
  await expect(cards(page)).toHaveCount(1, { timeout: 20000 });
  await seedLocalConflict(page, 'weird_target', 'other-1');
  await expect(cards(page)).toHaveCount(2, { timeout: 10000 });
  await page.getByRole('button', { name: 'Mark all reviewed (2)' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Mark 2 reviewed?');
  await expect(dialog).toContainText("New item 'Camel match box' was not created");
  await expect(dialog).toContainText('Involves money');
  await expect(dialog).toContainText('Nothing is deleted, changed or posted');
  // Cancel changes nothing.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(cards(page)).toHaveCount(2);
  // An alert that arrives while the dialog is open is NOT marked by it.
  await page.getByRole('button', { name: 'Mark all reviewed (2)' }).click();
  await seedLocalConflict(page, 'late_target', 'late-1');
  await expect(page.getByRole('dialog')).toContainText('Mark 2 reviewed?');
  await page.getByRole('dialog').getByRole('button', { name: 'Mark 2 reviewed' }).click();
  await expect(cards(page)).toHaveCount(1, { timeout: 10000 });
  await expect(page.getByTestId('review-note')).toContainText('Marked 2 reviewed');
});

async function joinAsCashier(browser: Browser, owner: Page) {
  await owner.goto('/team');
  await owner.getByRole('button', { name: 'Create invite' }).click();
  const link = (await owner.getByTestId('invite-link').textContent())!;
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(link);
  await page
    .getByLabel('Email')
    .fill(`d9-cashier-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByText(/Signed in · cashier/i)).toBeVisible();
  return page;
}

test('a cashier clears the device entry only and is told so (the shop record is not touched)', async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  await createOwnerShop(page);
  const cashier = await joinAsCashier(browser, page);
  let resolves = 0;
  await cashier.route('**/rest/v1/rpc/phase5_resolve_sync_conflict', (route) => {
    resolves++;
    return route.continue();
  });
  await cashier.route('**/rest/v1/sync_conflicts*', (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: '11111111-1111-4111-8111-111111111111',
          op_client_id: 'pay-1',
          kind: 'financial-rejection',
          target: 'supplier_payment',
          reason: 'DSB_PAYLOAD_MISMATCH: seeded for the test',
          status: 'OPEN',
          created_at: new Date().toISOString(),
          resolved_at: null,
        },
      ]),
    });
  });
  await cashier.goto('/sync');
  await seedLocalConflict(cashier, 'supplier_payment', 'pay-1');
  await expect(cards(cashier)).toHaveCount(1, { timeout: 10000 });
  const card = cards(cashier).first();
  await expect(card).toContainText('supplier payment');
  await expect(card).toContainText('this clears it on this device only');
  await card.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  await expect(cashier.getByTestId('review-note')).toContainText('on this device only');
  await expect(cashier.getByTestId('review-empty')).toBeVisible();
  expect(resolves).toBe(0);
});
