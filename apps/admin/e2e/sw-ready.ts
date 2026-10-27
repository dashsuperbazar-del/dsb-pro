import type { Page } from '@playwright/test';

// The service worker registers a moment after the first screen (idle, <= ~3 s). A spec that goes offline
// must first wait until the worker is installed AND controls the page.
//
// Never call this from inside a route handler or while a request the test cares about is in flight: it
// may reload the page once (when the worker was installed but has not claimed this page yet), which would
// cancel that request. Every evaluate retries when a navigation destroyed its context.
const DESTROYED = /Execution context was destroyed|Target closed|navigat/i;

async function settled<T>(page: Page, fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await page.waitForLoadState('load');
      return await fn();
    } catch (error) {
      if (!DESTROYED.test(String(error))) throw error;
      last = error;
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    }
  }
  throw last;
}

export async function swReady(page: Page): Promise<void> {
  await settled(page, () =>
    page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined)),
  );
  const controlled = () =>
    settled(page, () => page.evaluate(() => !!navigator.serviceWorker.controller));
  if (await controlled()) return;
  // The worker was installed after this page loaded and may claim it any moment: poll (survives a
  // navigation), then reload exactly once if it still does not control the page.
  await page
    .waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 5000 })
    .catch(() => undefined);
  if (await controlled()) return;
  await page.reload({ waitUntil: 'load' });
  await settled(page, () =>
    page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined)),
  );
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
}
