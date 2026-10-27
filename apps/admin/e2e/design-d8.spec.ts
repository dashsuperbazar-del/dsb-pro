import { test, expect, type Page } from '@playwright/test';
import { setupPosShop } from './pos-shop-setup';
import { swReady } from './sw-ready';
// D8: Home screen. Assertions plus (with DESIGN_SHOTS_DIR) evidence screenshots.
const PASSWORD = 'TestOnly-2026!pw';
const dir = process.env.DESIGN_SHOTS_DIR;
const themes = (dir ? ['light', 'dark'] : ['light']) as ('light' | 'dark')[];
const sizes = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1366, height: 768 },
] as const;

async function newShop(page: Page, tag: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/signup');
  await page.getByLabel('Email').fill(`${tag}-${Date.now()}-${Math.random()}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Dash Super Bazar');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
}

async function shootAll(page: Page, name: string, info: { outputPath: (f: string) => string }) {
  for (const theme of themes)
    for (const size of sizes) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.evaluate((t) => localStorage.setItem('dsb-pro:appearance', t), theme);
      await page.emulateMedia({ colorScheme: theme });
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 20000 });
      await page.waitForTimeout(1500);
      const file = `${name}-${theme}-${size.name}.png`;
      await page.screenshot({
        path: dir ? `${dir}/${file}` : info.outputPath(file),
        fullPage: true,
      });
    }
}

test('first-run Home shows a setup checklist instead of zero tiles', async ({ page }, info) => {
  test.setTimeout(120000);
  await newShop(page, 'd8-empty');
  const checklist = page.getByRole('region', { name: 'Day book today' });
  await expect(checklist.getByRole('heading', { name: 'Set up your shop' })).toBeVisible();
  await expect(checklist.getByRole('link', { name: 'Add items' })).toBeVisible();
  await expect(checklist.getByRole('link', { name: 'Add suppliers' })).toBeVisible();
  await expect(checklist.getByRole('link', { name: 'Make your first sale' })).toBeVisible();
  await expect(page.getByText('Net money flow')).toHaveCount(0);
  await shootAll(page, 'home-first-run', info);
});

test('quick entry order, negative flow on a neutral panel, refresh, offline saved figures', async ({
  page,
  context,
}, info) => {
  test.setTimeout(240000);
  await setupPosShop(page, 'd8');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.locator('.daybook-net')).toContainText('₹0.00');
  await shootAll(page, 'home-normal', info);
  // An expense with no sales: net money flow is negative.
  await page.goto('/expenses');
  await page.getByLabel('Category').fill('Rent');
  await page.getByLabel('Amount ₹').fill('12500');
  await page.getByRole('button', { name: 'Post expense' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Expense posted' })).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

  // Quick entry: New sale first, full labels, tiles big enough to tap.
  const tiles = page.getByRole('navigation', { name: 'Quick entry' }).getByRole('link');
  await expect(tiles).toHaveText(['New sale', 'Purchase', 'Pay supplier', 'Stock']);
  for (const t of await tiles.all()) {
    const box = await t.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(56);
    expect(box!.width).toBeGreaterThanOrEqual(120);
  }

  // Negative net money flow: red text, neutral (not green) panel.
  const net = page.locator('.daybook-net');
  await expect(net).toContainText('−₹12,500.00');
  await expect(net).toHaveClass(/negative/);
  const colours = await net.evaluate((el) => {
    const parse = (c: string) =>
      c
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number);
    const bg = parse(getComputedStyle(el).backgroundColor);
    const fg = parse(getComputedStyle(el.querySelector('dd')!).color);
    return { bg, fg };
  });
  expect(colours.fg[0]).toBeGreaterThan(colours.fg[1]); // red-dominant text
  expect(colours.bg[1]).toBeLessThanOrEqual(colours.bg[0] + 12); // background is not green-tinted
  expect(colours.bg[1]).toBeLessThanOrEqual(colours.bg[2] + 12);

  // Updated line and Refresh.
  await expect(page.getByTestId('daybook-updated')).toContainText(/Updated \d{1,2}:\d{2}/);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByTestId('daybook-updated')).toContainText(/Updated \d{1,2}:\d{2}/);

  // The duplicated workspace list is one collapsed "All screens" row; every screen is two taps away.
  const toggle = page.locator('.home-row-toggle').filter({ hasText: /^All screens/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('link', { name: 'Customers & ledger' })).toHaveCount(0);

  await shootAll(page, 'home-negative', info);

  // Offline: reload; the saved figures show with a calm amber note, not a red error.
  await swReady(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 20000 });
  const note = page.getByTestId('daybook-saved');
  await expect(note).toContainText(/Showing saved figures from \d{1,2}:\d{2}/, { timeout: 30000 });
  await expect(note).toHaveClass(/warning/);
  await expect(page.locator('.daybook-net')).toContainText('−₹12,500.00');
  await shootAll(page, 'home-offline', info);
  await context.setOffline(false);
});
