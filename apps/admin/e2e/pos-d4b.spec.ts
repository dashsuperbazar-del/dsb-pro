import { test, expect, type Page } from '@playwright/test';
import { swReady } from './sw-ready';
import { setupPosShop, toPayment } from './pos-shop-setup';
import { addItemForm } from './design-helpers';
// D4b "tappable result list": the POS item picker is a search box with result rows (tap = add one, tap again
// = one more), unit chips, stock chips, recent items, a no-match state, offline add and the barcode box.
// Money behaviour is unchanged: the row price, the cart price and the total are the same figure.

const NAME = 'Basmati rice 1kg';
const row = (page: Page, name: string) => page.locator('.pick-row').filter({ hasText: name });
const cartQty = (page: Page, name: string) => page.getByLabel(`Cart qty for ${name}`);

async function openPos(page: Page) {
  await page.goto('/pos');
  await expect(page.getByRole('heading', { name: 'Sales POS', exact: true })).toBeVisible();
  await expect(page.locator('.pick-list')).toBeVisible();
  // The row price arrives after the row is drawn.
  await expect(row(page, NAME).locator('.pick-price')).not.toHaveText('…');
}

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('one tap adds, a second tap increments, and the row price is the cart price and the total', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await setupPosShop(page, 'd4b-tap');
    await openPos(page);
    // No keyboard raised on a phone.
    await expect(page.getByLabel('Find product')).not.toBeFocused();
    const rowEl = row(page, NAME);
    await expect(rowEl).toContainText('in stock');
    const box = await rowEl.locator('.pick-main').boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(56);
    const shown = (await rowEl.locator('.pick-price').textContent())!.trim();
    expect(shown).toBe('₹1,200.00');

    await page.getByRole('button', { name: `Add ${NAME}`, exact: true }).tap();
    await expect(cartQty(page, NAME)).toHaveValue('1');
    await expect(page.locator('#pos-cart tbody tr')).toHaveCount(1);
    await expect(page.locator('#pos-cart tbody tr')).toContainText(shown);
    await expect(rowEl).toContainText('In bill');

    await page.getByRole('button', { name: `Add ${NAME}`, exact: true }).tap();
    await expect(cartQty(page, NAME)).toHaveValue('2');
    await expect(page.locator('#pos-cart tbody tr')).toHaveCount(1);
    await expect(page.locator('.pos-cart')).toContainText('₹2,400.00');
    // Cart qty stays editable and is not reset by other redraws.
    await cartQty(page, NAME).fill('3');
    await page.getByLabel('Find product').fill('Bas');
    await expect(cartQty(page, NAME)).toHaveValue('3');

    // Empty box shows the recent items; the clear button empties the box.
    await page.getByLabel('Clear search').tap();
    await expect(page.getByLabel('Find product')).toHaveValue('');
    await expect(page.locator('#pos-pick-head')).toHaveText('Recent items');
    await expect(row(page, NAME)).toBeVisible();
  });

  test('no match shows a plain message; out-of-stock items are tappable; units switch', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await setupPosShop(page, 'd4b-states');
    // A second item with no stock at all.
    await page.goto('/inventory');
    await addItemForm(page);
    await page.getByPlaceholder('Item name').fill('Zed empty tin');
    await page.getByPlaceholder('Big unit (e.g. case)').fill('box');
    await page.getByPlaceholder('Small unit (e.g. pack)').fill('tin');
    await page.getByPlaceholder('Small units per big').fill('12');
    await page.getByRole('button', { name: 'Create item' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Created' }).first()).toBeVisible();
    await openPos(page);

    await page.getByLabel('Find product').fill('qqqq-none');
    await expect(page.getByText('No item matches “qqqq-none”')).toBeVisible();
    await expect(page.locator('.pick-row')).toHaveCount(0);
    await page.getByLabel('Clear search').tap();

    await page.getByLabel('Find product').fill('Zed');
    const out = row(page, 'Zed empty tin');
    await expect(out.locator('.chip', { hasText: 'Out of stock' })).toBeVisible();
    // Unit chips: the default is the largest unit; choosing another changes the row, not the cart.
    const units = page.getByRole('group', { name: 'Unit for Zed empty tin' }).getByRole('button');
    await expect(units).toHaveCount(2);
    await expect(units.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await units.nth(0).tap();
    await expect(units.nth(0)).toHaveAttribute('aria-pressed', 'true');
    await expect(units.nth(1)).toHaveAttribute('aria-pressed', 'false');
    await expect(out).toContainText('per ');
    await units.nth(1).tap();
    await expect(units.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#pos-cart tbody tr')).toHaveCount(0);

    // Tappable: it has no price, so the owner is asked to type one (the existing rule).
    await page.getByRole('button', { name: 'Add Zed empty tin', exact: true }).tap();
    await expect(page.getByRole('form', { name: 'Enter a price' })).toBeVisible();
    await page.getByLabel('Price for this sale ₹').fill('50');
    await page
      .getByRole('button', { name: /Use this price|Add to bill|Add/ })
      .last()
      .click();
    await expect(cartQty(page, 'Zed empty tin')).toHaveValue('1');
  });

  test('the barcode box still adds the linked item', async ({ page }) => {
    test.setTimeout(120000);
    await setupPosShop(page, 'd4b-barcode');
    await page.goto('/inventory');
    await page.getByLabel('Item details').selectOption({ label: NAME });
    await page.getByPlaceholder('Barcode').fill('8901234500017');
    await page.getByRole('button', { name: 'Link barcode' }).click();
    await expect(page.getByText('Barcode linked to item.')).toBeVisible();
    await openPos(page);
    await page.getByLabel('Barcode', { exact: true }).fill('8901234500017');
    await page.getByRole('button', { name: 'Scan / Add' }).click();
    await expect(cartQty(page, NAME)).toHaveValue('1');
  });

  test('offline: the list works from the saved catalog and the sale is queued', async ({
    page,
    context,
  }) => {
    test.setTimeout(150000);
    await setupPosShop(page, 'd4b-offline');
    await page.waitForTimeout(1200);
    await page.goto('/sync');
    await page.getByRole('button', { name: 'Sync now' }).click();
    await expect(page.getByTestId('sync-outbox-count')).toHaveText('0');
    await openPos(page);
    await expect(row(page, NAME)).toContainText('in stock');
    await swReady(page);
    await context.setOffline(true);
    // A fresh load while offline works from the saved catalog, stock and prices.
    await page.reload();
    await expect(page.locator('.pick-list')).toBeVisible();
    await page.getByLabel('Find product').fill('Basm');
    const shown = '₹1,200.00';
    await expect(row(page, NAME).locator('.pick-price')).toHaveText(shown);
    await expect(row(page, NAME)).toContainText('in stock');
    await page.getByRole('button', { name: `Add ${NAME}`, exact: true }).tap();
    await expect(cartQty(page, NAME)).toHaveValue('1');
    await expect(page.locator('#pos-cart tbody tr')).toContainText(shown);
    await toPayment(page);
    await page.getByLabel('Amount ₹').first().fill('1200');
    await page.getByRole('button', { name: 'Finalize sale' }).click();
    await expect(page.getByRole('region', { name: 'Sale done' })).toContainText(
      'Saved on this device',
    );
    await context.setOffline(false);
  });
});

test.describe('desktop keyboard and scanner', () => {
  test('Enter highlights first, then adds; barcode box adds once (scanner bursts: pos-scanner.spec.ts)', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await setupPosShop(page, 'd4b-enter');
    await page.goto('/inventory');
    await page.getByLabel('Item details').selectOption({ label: NAME });
    await page.getByPlaceholder('Barcode').fill('8901234500024');
    await page.getByRole('button', { name: 'Link barcode' }).click();
    await expect(page.getByText('Barcode linked to item.')).toBeVisible();
    await page.setViewportSize({ width: 1366, height: 768 });
    await openPos(page);

    // The barcode box path adds exactly once.
    await page.getByLabel('Barcode', { exact: true }).fill('8901234500024');
    await page.getByRole('button', { name: 'Scan / Add' }).click();
    await expect(cartQty(page, NAME)).toHaveValue('1');
    await expect(page.locator('#pos-cart tbody tr')).toHaveCount(1);

    const find = page.getByLabel('Find product');
    await find.fill('rice');
    await find.press('Enter');
    // First Enter only highlights the top match.
    await expect(row(page, NAME)).toHaveClass(/active/);
    await expect(cartQty(page, NAME)).toHaveValue('1');
    await find.press('Enter');
    await expect(cartQty(page, NAME)).toHaveValue('2');
    await expect(page.locator('#pos-cart tbody tr')).toHaveCount(1);
    await expect(
      page.getByRole('status').filter({ hasText: `Added ${NAME} (qty 2)` }),
    ).toBeAttached();
    // The text is selected and focus is back in the box: typing replaces it.
    await expect(find).toBeFocused();
    await page.keyboard.type('Bas');
    await expect(find).toHaveValue('Bas');
  });
});
