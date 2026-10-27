import { test, expect, type Page } from '@playwright/test';
import { setupPosShop } from './pos-shop-setup';
// Hardware scanner detection: a burst of 6+ characters with gaps under 50 ms ending in Enter, landing in any
// text field that is not a numeric quantity/price field, goes through the barcode scan path and adds once.
// Slow human typing keeps the two-step Enter (highlight, then add). A burst that matches nothing adds nothing.

const NAME = 'Basmati rice 1kg';
const CODE = '8901234500031';
const cartQty = (page: Page) => page.getByLabel(`Cart qty for ${NAME}`);
const cartRows = (page: Page) => page.locator('#pos-cart tbody tr');

async function openPosWithBarcode(page: Page, tag: string) {
  await setupPosShop(page, tag);
  await page.goto('/inventory');
  await page.getByLabel('Item details').selectOption({ label: NAME });
  await page.getByPlaceholder('Barcode').fill(CODE);
  await page.getByRole('button', { name: 'Link barcode' }).click();
  await expect(page.getByText('Barcode linked to item.')).toBeVisible();
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/pos');
  await expect(page.getByRole('heading', { name: 'Sales POS', exact: true })).toBeVisible();
  await expect(
    page.locator('.pick-row').filter({ hasText: NAME }).locator('.pick-price'),
  ).not.toHaveText('…');
  // Let the page finish its start-up work: a key that waits behind it would look like slow typing.
  await page.waitForTimeout(1500);
  // Warm the search render path so the first typed key is not slower than the rest.
  await page.getByLabel('Find product').fill('Bas');
  await page.getByLabel('Find product').fill('');
  await page.waitForTimeout(300);
}

test('a scanner burst (5 ms gaps) into the search box adds exactly once and clears the field', async ({
  page,
}) => {
  test.setTimeout(120000);
  await openPosWithBarcode(page, 'scan-burst');
  const find = page.getByLabel('Find product');
  await find.click();
  await page.keyboard.type(`${CODE}\n`, { delay: 5 });
  await expect(cartQty(page)).toHaveValue('1');
  await expect(cartRows(page)).toHaveCount(1);
  await expect(find).toHaveValue('');
  // Settle: no second add arrives from the old Enter-highlights-then-adds flow.
  await page.waitForTimeout(500);
  await expect(cartQty(page)).toHaveValue('1');
  // A second scan is a second add, exactly one per scan (the barcode path adds a line per scan, as before).
  await page.keyboard.type(`${CODE}\n`, { delay: 5 });
  await expect(cartRows(page)).toHaveCount(2);
  await page.waitForTimeout(300);
  await expect(cartRows(page)).toHaveCount(2);
});

test('a burst into the barcode box adds once too', async ({ page }) => {
  test.setTimeout(120000);
  await openPosWithBarcode(page, 'scan-box');
  const box = page.getByLabel('Barcode', { exact: true });
  await box.click();
  await page.keyboard.type(`${CODE}\n`, { delay: 5 });
  await expect(cartQty(page)).toHaveValue('1');
  await page.waitForTimeout(400);
  await expect(cartQty(page)).toHaveValue('1');
  await expect(box).toHaveValue('');
});

test('slow human typing (120 ms) keeps the two-step Enter: highlight, then add', async ({
  page,
}) => {
  test.setTimeout(120000);
  await openPosWithBarcode(page, 'scan-slow');
  const find = page.getByLabel('Find product');
  await find.click();
  await page.keyboard.type('Basmati', { delay: 120 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.pick-row').filter({ hasText: NAME })).toHaveClass(/active/);
  await expect(cartRows(page)).toHaveCount(0);
  await expect(find).toHaveValue('Basmati');
  await page.keyboard.press('Enter');
  await expect(cartQty(page)).toHaveValue('1');
});

test('a burst that matches nothing adds nothing and says so', async ({ page }) => {
  test.setTimeout(120000);
  await openPosWithBarcode(page, 'scan-miss');
  const find = page.getByLabel('Find product');
  await find.click();
  await page.keyboard.type('ZZZ99999\n', { delay: 5 });
  await expect(
    page.getByRole('alert').filter({ hasText: 'No item with code ZZZ99999' }).first(),
  ).toBeVisible();
  await expect(cartRows(page)).toHaveCount(0);
  await expect(find).toHaveValue('');
});

test('a burst into a cart quantity field is ignored by the scanner path', async ({ page }) => {
  test.setTimeout(120000);
  await openPosWithBarcode(page, 'scan-qty');
  await page.getByLabel('Barcode', { exact: true }).fill(CODE);
  await page.getByRole('button', { name: 'Scan / Add' }).click();
  await expect(cartQty(page)).toHaveValue('1');
  await cartQty(page).fill('');
  await cartQty(page).focus();
  await page.keyboard.type(`${CODE}\n`, { delay: 5 });
  await page.waitForTimeout(400);
  // Still one line; nothing was scanned (no second add, no "No item with code"), the digits stayed in the field.
  await expect(cartRows(page)).toHaveCount(1);
  await expect(page.getByText(/No item with code/)).toHaveCount(0);
  await expect(cartQty(page)).toHaveValue(CODE);
});

test('a fast burst plus Enter in another text field (hold label) is left untouched', async ({
  page,
}) => {
  test.setTimeout(120000);
  await openPosWithBarcode(page, 'scan-other');
  const hold = page.getByTestId('pos-hold-label');
  await hold.click();
  await page.keyboard.type(`${CODE}\n`, { delay: 5 });
  await page.waitForTimeout(300);
  await expect(hold).toHaveValue(CODE);
  await expect(cartRows(page)).toHaveCount(0);
  await expect(page.getByText(/No item with code/)).toHaveCount(0);
});

test('text typed before a scan stays in the search box', async ({ page }) => {
  test.setTimeout(120000);
  await openPosWithBarcode(page, 'scan-keep');
  const find = page.getByLabel('Find product');
  await find.fill('xy');
  await find.focus();
  await page.keyboard.press('End');
  await page.keyboard.type(`${CODE}\n`, { delay: 5 });
  await expect(cartRows(page)).toHaveCount(1);
  await expect(find).toHaveValue('xy');
});
