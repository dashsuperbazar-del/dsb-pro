import { test, expect, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { setupPosShop, addToCart, toPayment } from './pos-shop-setup';
// D4 evidence: the POS sell + pay screens (empty, cart, payment error, credit, sale done online and
// offline-queued, collapsed/expanded secondary blocks, 195px zoom). The phone runs in a touch context
// (so the barcode box does not take focus, as on a real phone); the desktop in a mouse context.
// With DESIGN_SHOTS_DIR set it takes light + dark; without it only light (CI keeps this spec short).
const full = Boolean(process.env.DESIGN_SHOTS_DIR);
const themes = (full ? ['light', 'dark'] : ['light']) as ('light' | 'dark')[];

async function shoot(
  page: Page,
  context: BrowserContext,
  info: TestInfo,
  vp: { name: string; width: number; height: number },
) {
  const dir = process.env.DESIGN_SHOTS_DIR;
  const prefix = process.env.DESIGN_SHOTS_PREFIX ?? 'd4';
  const shot = async (name: string) => {
    await page.waitForTimeout(300);
    const file = `${prefix}-${name}.png`;
    await page.screenshot({ path: dir ? `${dir}/${file}` : info.outputPath(file) });
  };
  let first = true;
  for (const theme of themes) {
    const tag = `${theme}-${vp.name}`;
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.evaluate((t) => localStorage.setItem('dsb-pro:appearance', t), theme);
    await page.goto('/pos');
    await expect(page.getByRole('heading', { name: 'Sales POS', exact: true })).toBeVisible();
    await expect(page.locator('.pick-list')).toBeVisible();
    await shot(`01-pos-empty-${tag}`);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await shot(`02-pos-empty-bottom-${tag}`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await addToCart(page, '2');
    await shot(`03-pos-cart-${tag}`);
    // Payment: a walk-in sale paid short is refused by the server.
    await toPayment(page);
    const amount = page.locator('#pos-payment input[type="number"]').first();
    await shot(`04a-pos-payment-first-view-${tag}`);
    await amount.fill('100');
    await page.getByRole('button', { name: 'Finalize sale' }).click();
    await expect(
      page
        .getByRole('alert')
        .filter({ hasText: /fully paid/ })
        .first(),
    ).toBeVisible();
    await page.waitForTimeout(400);
    await shot(`04-pos-payment-walkin-error-${tag}`);
    // Credit: a customer takes the rest on credit.
    if (first) {
      await page.getByText('Add a new customer').click();
      await page.getByPlaceholder('Name', { exact: true }).fill('Ravi Kumar');
      await page.getByRole('button', { name: 'Create & select' }).click();
      await expect(page.getByText('Customer Ravi Kumar created.').first()).toBeVisible();
    } else {
      const customer = page.locator('#pos-payment select').first();
      const value = await customer.evaluate(
        (el) =>
          [...(el as HTMLSelectElement).options].find((o) => o.text.startsWith('Ravi'))?.value ??
          '',
      );
      await customer.selectOption(value);
    }
    first = false;
    await amount.fill('1000');
    await shot(`05-pos-payment-credit-${tag}`);
    await page.getByRole('button', { name: 'Finalize sale' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Sale finalized' }).first(),
    ).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(`06-pos-sale-done-online-${tag}`);
    // Offline: the same flow is saved on this device.
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('.pick-list')).toBeVisible();
    await addToCart(page, '1');
    await toPayment(page);
    await page.locator('#pos-payment input[type="number"]').first().fill('1200');
    await shot(`07-pos-payment-offline-${tag}`);
    await page.getByRole('button', { name: 'Finalize sale' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Saved locally as T-' }).first(),
    ).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(`08-pos-sale-done-offline-${tag}`);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await shot(`09-pos-secondary-blocks-${tag}`);
    // Open one of the blocks (closed on a phone until opened) to show the expanded look.
    const toggle = page.locator('.home-row-toggle').filter({ hasText: /^Recent invoices/ });
    // (Before D4 the block was always open and had no toggle.)
    if ((await toggle.count()) > 0 && (await toggle.getAttribute('aria-expanded')) !== 'true')
      await toggle.click();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await shot(`09b-pos-recent-invoices-expanded-${tag}`);
    await context.setOffline(false);
    await page.goto('/sync');
    await page.getByRole('button', { name: 'Sync now' }).click();
    await expect(page.getByTestId('sync-outbox-count')).toHaveText('0');
  }
  if (vp.name === 'phone') {
    // 200% zoom on a 390px phone = a 195px viewport.
    await page.setViewportSize({ width: 195, height: 422 });
    await page.evaluate(() => localStorage.setItem('dsb-pro:appearance', 'light'));
    await page.goto('/pos');
    await expect(page.locator('.pick-list')).toBeVisible();
    await shot('10-zoom200-pos-empty');
    await addToCart(page, '2');
    await shot('11-zoom200-pos-cart');
    await toPayment(page);
    await shot('12-zoom200-pos-payment');
  }
}

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('design screenshots: POS sell + pay on a phone', async ({ page, context }, info) => {
    test.setTimeout(600000);
    await setupPosShop(page, 'd4p');
    await shoot(page, context, info, { name: 'phone', width: 390, height: 844 });
  });
});

test('design screenshots: POS sell + pay on a desktop', async ({ page, context }, info) => {
  test.skip(!full, 'the desktop set is only taken for the design review (DESIGN_SHOTS_DIR)');
  test.setTimeout(600000);
  await setupPosShop(page, 'd4d');
  await shoot(page, context, info, { name: 'desktop', width: 1366, height: 768 });
});
