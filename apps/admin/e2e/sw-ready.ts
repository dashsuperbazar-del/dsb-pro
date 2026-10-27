import type { Page } from '@playwright/test';

// The service worker registers a moment after the first screen (idle, <= ~3 s). A spec that goes offline
// must first wait until the worker is installed AND controls the page; reload once if it was claimed late.
export async function swReady(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  const controlled = () => page.evaluate(() => !!navigator.serviceWorker.controller);
  if (!(await controlled())) {
    await page
      .waitForFunction(() => !!navigator.serviceWorker.controller, null, {
        timeout: 5000,
      })
      .catch(() => undefined);
  }
  if (!(await controlled())) {
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  }
}
