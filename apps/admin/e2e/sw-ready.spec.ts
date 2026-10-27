import { test, expect } from '@playwright/test';
import { swReady } from './sw-ready';

// Regression: swReady used to throw "Execution context was destroyed" when a navigation (the worker
// claiming the page, or a reload) overlapped its evaluate, which broke the lost-acknowledgement return
// spec. It must survive a navigation that happens while it runs.
test('swReady survives a navigation that overlaps it', async ({ page }) => {
  await page.goto('/');
  const ready = swReady(page);
  await page.reload();
  await ready;
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
});
