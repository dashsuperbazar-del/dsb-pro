import { test, expect, type Page } from '@playwright/test';
import { setupPosShop, addToCart, toPayment } from './pos-shop-setup';
// D4 "Counter: POS sell + pay": the sale-done card (online and saved on the device), the error shown
// directly above the Finalize bar, the Amount field above that bar, no barcode autofocus on a phone,
// secondary blocks closed on a phone, no sideways scroll at 200% zoom, no health strip on the POS.

const stubPrint = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as { __prints: number }).__prints = 0;
    window.print = () => {
      (window as unknown as { __prints: number }).__prints += 1;
    };
  });
const prints = (page: Page) =>
  page.evaluate(() => (window as unknown as { __prints: number }).__prints);
const doneCard = (page: Page) => page.getByRole('region', { name: 'Sale done' });

async function openPos(page: Page) {
  await page.goto('/pos');
  await expect(page.getByRole('heading', { name: 'Sales POS', exact: true })).toBeVisible();
  await expect(page.getByLabel('Item', { exact: true })).toBeEnabled();
}

test('sale done card (online): total, paid, credit balance, invoice, bill code, print, share, new sale', async ({
  page,
}) => {
  test.setTimeout(90000);
  await setupPosShop(page, 'd4-done');
  await openPos(page);
  await page.getByLabel('Find product').fill('Basm');
  await addToCart(page, '2');
  await toPayment(page);
  await page.getByText('Add a new customer').click();
  await page.getByPlaceholder('Name', { exact: true }).fill('Ravi Kumar');
  await page.getByRole('button', { name: 'Create & select' }).click();
  await expect(page.getByText('Customer Ravi Kumar created.').first()).toBeVisible();
  await page.getByLabel('Amount ₹').first().fill('1000');
  await page.getByRole('button', { name: 'Finalize sale' }).click();

  const card = doneCard(page);
  await expect(card).toBeVisible();
  await expect(card.getByRole('status').first()).toContainText(/Sale finalized: INV-\d+\./);
  await expect(card.locator('.sale-done-total strong')).toHaveText('₹2,400.00');
  await expect(card).toContainText('Paid₹1,000.00');
  await expect(card).toContainText('Balance on credit₹1,400.00');
  await expect(card).toContainText('CustomerRavi Kumar');
  await expect(card.getByTestId('bill-code')).toContainText(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
  await expect(card.getByRole('button', { name: 'Share as image' })).toBeVisible();
  // Money on the POS tables is grouped like Home.
  await expect(page.locator('.print-area')).toContainText('₹2,400.00');

  // Print uses the same receipt as Sales history, built from the server invoice.
  await stubPrint(page);
  await card.getByRole('button', { name: 'Print receipt' }).click();
  await expect(page.locator('[aria-label="invoice receipt"]')).toContainText('Total');
  await expect(page.locator('[aria-label="invoice receipt"]')).toContainText('₹2400.00');
  await expect.poll(() => prints(page)).toBe(1);

  // The card stays until dismissed; "New sale" clears it and any old Find-product text.
  await page.getByLabel('Find product').fill('leftover text');
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'New sale' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByLabel('Find product')).toHaveValue('');
});

test('sale done card (offline): saved on this device, same Print, friendly saved-sale label', async ({
  page,
  context,
}) => {
  test.setTimeout(120000);
  await setupPosShop(page, 'd4-offline');
  // The device needs the shop's stock before it can sell offline (same wait as offline-sync.spec).
  await page.waitForTimeout(1200);
  await page.goto('/sync');
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('0');
  await openPos(page);
  await context.setOffline(true);
  await addToCart(page, '1');
  await toPayment(page);
  await page.getByLabel('Amount ₹').first().fill('1200');
  await page.getByRole('button', { name: 'Finalize sale' }).click();

  const card = doneCard(page);
  await expect(card).toBeVisible();
  await expect(card.getByRole('status').first()).toContainText('Saved on this device — will sync');
  await expect(card.getByRole('status').first()).toContainText('Saved locally as T-');
  await expect(card.locator('.sale-done-total strong')).toHaveText('₹1,200.00');
  await expect(card).toContainText('Paid₹1,200.00');
  await expect(card).toContainText('BalanceNil, fully paid');
  // Only what works offline: no share image (it is built from the server invoice).
  await expect(card.getByRole('button', { name: 'Share as image' })).toHaveCount(0);
  await stubPrint(page);
  await card.getByRole('button', { name: 'Print receipt' }).click();
  await expect(page.locator('[aria-label="provisional offline receipt"]')).toContainText(
    'PROVISIONAL — PENDING SYNC',
  );
  await expect.poll(() => prints(page)).toBe(1);

  // Saved-sales list: "Sale 14:32 · waiting", never the raw T-uuid as the name.
  const saved = page.locator('section[aria-label="Local offline sales"]');
  await saved.locator('.home-row-toggle').click();
  await expect(saved).toContainText(/Sale \d\d:\d\d/);
  await expect(saved.locator('td .badge')).toHaveText('waiting');
  await expect(saved).not.toContainText('QUEUED');

  await context.setOffline(false);
  await page.goto('/sync');
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('sync-outbox-count')).toHaveText('0');
  await openPos(page);
  const after = page.locator('section[aria-label="Local offline sales"]');
  if ((await after.locator('.home-row-toggle').getAttribute('aria-expanded')) !== 'true')
    await after.locator('.home-row-toggle').click();
  await expect(after.locator('td .badge')).toHaveText('synced');
  await expect(after).toContainText(/Sale \d+/);
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('Amount sits above the Finalize bar and the refusal shows directly above Finalize', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await setupPosShop(page, 'd4-pay');
    await openPos(page);
    await addToCart(page, '2');
    await toPayment(page);
    const amount = page.getByLabel('Amount ₹').first();
    const bar = page.locator('.checkout-actions');
    const above = async () => {
      const a = (await amount.boundingBox())!;
      const b = (await bar.boundingBox())!;
      return { amountBottom: a.y + a.height, barTop: b.y };
    };
    await expect(amount).toBeInViewport({ ratio: 1 });
    let pos = await above();
    expect(pos.amountBottom).toBeLessThanOrEqual(pos.barTop + 1);

    // A walk-in sale paid short is refused by the server: the sentence sits right above Finalize.
    await amount.fill('100');
    await page.getByRole('button', { name: 'Finalize sale' }).click();
    const alert = bar.getByRole('alert');
    await expect(alert).toContainText('Walk-in sale must be fully paid');
    await expect(alert).toHaveAttribute('aria-live', 'assertive');
    await expect(alert).toBeInViewport({ ratio: 1 });
    const a = (await alert.boundingBox())!;
    const f = (await page.getByRole('button', { name: 'Finalize sale' }).boundingBox())!;
    expect(a.y + a.height).toBeLessThanOrEqual(f.y + 1);
    // Not left only at the top of the page, and the fields are still above the (taller) bar.
    await expect(page.locator('main > p[role="alert"]')).toHaveCount(0);
    await expect(amount).toBeInViewport({ ratio: 1 });
    pos = await above();
    expect(pos.amountBottom).toBeLessThanOrEqual(pos.barTop + 1);
  });

  test('the barcode box does not take focus on a phone, and the secondary blocks start closed', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await setupPosShop(page, 'd4-focus');
    await openPos(page);
    await expect(page.getByLabel('Barcode')).not.toBeFocused();
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY');
    const row = (name: string) =>
      page.locator('.home-row-toggle').filter({ hasText: new RegExp(`^${name}`) });
    for (const name of ['Bill options', 'Customer payment / advance', 'Recent invoices'])
      await expect(row(name)).toHaveAttribute('aria-expanded', 'false');
    // Opening one is remembered on this device for this user.
    await row('Customer payment / advance').click();
    await expect(row('Customer payment / advance')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('button', { name: 'Record payment' })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Item', { exact: true })).toBeEnabled();
    await expect(row('Customer payment / advance')).toHaveAttribute('aria-expanded', 'true');
    await expect(row('Bill options')).toHaveAttribute('aria-expanded', 'false');
    // Something that needs a look keeps the block open: GST added on top.
    await row('Bill options').click();
    await page.getByLabel('Invoice type').selectOption('gst_extra');
    await row('Bill options').click();
    await expect(row('Bill options')).toHaveAttribute('aria-expanded', 'true');
  });
});

test('on a desktop the barcode box takes focus and the secondary blocks stay open', async ({
  page,
}) => {
  test.setTimeout(90000);
  await setupPosShop(page, 'd4-desk');
  await page.setViewportSize({ width: 1366, height: 768 });
  await openPos(page);
  await expect(page.getByLabel('Barcode')).toBeFocused();
  await expect(page.getByLabel('Invoice type')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record payment' })).toBeVisible();
});

test('no sideways scroll on the POS at 200% zoom (195px) and amounts never split by digit', async ({
  page,
}) => {
  test.setTimeout(120000);
  await setupPosShop(page, 'd4-zoom');
  await page.setViewportSize({ width: 195, height: 422 });
  const noSideScroll = async (label: string) => {
    const w = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }));
    expect(w.scroll, `${label}: scrollWidth`).toBeLessThanOrEqual(w.inner);
  };
  const oneLine = async (selector: string) => {
    for (const box of await page.locator(selector).evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { h: r.height, line: parseFloat(getComputedStyle(el).lineHeight) || r.height };
      }),
    ))
      expect(box.h).toBeLessThanOrEqual(box.line * 1.3);
  };
  await openPos(page);
  await noSideScroll('empty');
  await addToCart(page, '2');
  await noSideScroll('cart');
  await oneLine('.pos-overview strong');
  await toPayment(page);
  await noSideScroll('payment');
  await oneLine('.payment-total strong');
  await oneLine('.checkout-entered strong');
  // Pay what the screen says the bill is (the quantity box can be redrawn by a late catalog update).
  const billTotal = (await page.locator('.payment-total strong').innerText()).replace(/[₹,]/g, '');
  await page.getByLabel('Amount ₹').first().fill(billTotal);
  await page.getByRole('button', { name: 'Finalize sale' }).click();
  await expect(doneCard(page)).toBeVisible();
  await noSideScroll('sale done');
  await oneLine('.sale-done-total strong');
});

test('the System health strip stays off the POS and purchase entry, and stays on Home', async ({
  page,
}) => {
  test.setTimeout(90000);
  await setupPosShop(page, 'd4-health');
  const health = page.getByRole('region', { name: 'System health' });
  await page.goto('/');
  await expect(health).toBeVisible();
  await page.goto('/pos');
  await expect(page.getByRole('heading', { name: 'Sales POS', exact: true })).toBeVisible();
  await expect(health).toHaveCount(0);
  await page.goto('/purchases?new=1');
  await expect(page.getByRole('heading', { name: 'Post purchase', exact: true })).toBeVisible();
  await expect(health).toHaveCount(0);
  await page.goto('/');
  await expect(health).toBeVisible();
});

test('a typed quantity and line discount survive a redraw of the page, then reset after Add', async ({
  page,
}) => {
  test.setTimeout(90000);
  await setupPosShop(page, 'd4-redraw');
  await page.setViewportSize({ width: 1366, height: 768 });
  await openPos(page);
  await page.getByLabel('Item', { exact: true }).selectOption({ label: 'Basmati rice 1kg' });
  await page.getByLabel('Quantity', { exact: true }).fill('5');
  await page.getByLabel('Discount ₹', { exact: true }).fill('3');
  // Typing in another box re-renders the whole POS screen (state change).
  await page.locator('form').filter({ hasText: 'Record payment' }).getByLabel('Amount ₹').fill('7');
  await expect(page.getByLabel('Quantity', { exact: true })).toHaveValue('5');
  await expect(page.getByLabel('Discount ₹', { exact: true })).toHaveValue('3');
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  await expect(page.getByLabel('Cart qty for Basmati rice 1kg')).toHaveValue('5');
  await expect(page.getByLabel('Discount for Basmati rice 1kg')).toHaveValue('3.00');
  await expect(page.getByLabel('Quantity', { exact: true })).toHaveValue('1');
  await expect(page.getByLabel('Discount ₹', { exact: true })).toHaveValue('0');
});
