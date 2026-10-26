import { test, expect } from '@playwright/test';

// D2: rarely used screens load on demand from a separate chunk. Once the service worker is installed
// that chunk is precached (dist/precache.json), so screens NEVER opened online still open offline.
const PASSWORD = 'TestOnly-2026!pw';

test('screens that load on demand open offline without ever being opened online', async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  await page.goto('/signup');
  await page.getByLabel('Email').fill(`lazy-${Date.now()}-${Math.random()}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Lazy Offline Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  // Only the home page was opened online. The worker installs and precaches every built file.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
          once: true,
        }),
      );
  });
  // Every built file — the on-demand chunk included — is in the worker's cache before it is ever
  // requested (Chromium's offline emulation does not reliably cover worker fetches, so check the cache).
  const missing = await page.evaluate(async () => {
    const files = (await (await fetch('/precache.json')).json()) as string[];
    const out: string[] = [];
    for (const f of files)
      if (!(await caches.match(new URL(f, location.origin).toString(), { ignoreVary: true })))
        out.push(f);
    return { files, out };
  });
  expect(missing.files.some((f) => /rareScreens-/.test(f))).toBe(true);
  expect(missing.out).toEqual([]);
  await context.setOffline(true);
  await page.goto('/sync');
  await expect(page.getByRole('heading', { name: 'Sync & offline' })).toBeVisible();
  await page.goto('/customers');
  await expect(page.getByRole('heading', { name: 'Customers & ledger' })).toBeVisible();
  await page.goto('/sales-history');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText('This screen could not be loaded')).toHaveCount(0);
  await context.setOffline(false);
});
