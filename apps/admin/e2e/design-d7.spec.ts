import { test, expect, type Page } from '@playwright/test';
// D7: unknown address, 200% zoom, tap targets and the offline health note.
const PASSWORD = 'TestOnly-2026!pw';

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

test('an unknown address shows Page not found, Home and the install address still open Home', async ({
  page,
}) => {
  await newShop(page, 'd7-404');
  await page.goto('/nonexistent-page');
  await expect(page.getByTestId('not-found')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await page.getByRole('link', { name: 'Go to Home' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.goto('/index.html');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.goto('/sync');
  await expect(page.getByTestId('not-found')).toHaveCount(0);
});

test('at 200% zoom (195px) Home, POS and New purchase do not scroll sideways', async ({ page }) => {
  await newShop(page, 'd7-zoom');
  await page.setViewportSize({ width: 195, height: 422 });
  for (const path of ['/', '/pos', '/purchases?new=1']) {
    await page.goto(path);
    await page.waitForLoadState('load');
    await page.waitForTimeout(800);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(1);
  }
});

test('the back-to-Home link is a real tap target (44px)', async ({ page }) => {
  await newShop(page, 'd7-tap');
  await page.goto('/sync');
  const link = page.locator('a.back-home').first();
  await expect(link).toBeVisible();
  const box = (await link.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(43.5);
});
