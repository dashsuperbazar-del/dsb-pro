import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

// First-load guard (boot order only): the page must paint a shell before JavaScript, the hosting headers
// must let hashed files be cached for good, and a signed-out boot must not make serial backend calls
// before its first screen.
test.use({ serviceWorkers: 'block' });

test('index.html ships a first-paint shell and a CSP-safe stylesheet', async ({ request }) => {
  const html = await (await request.get('/')).text();
  expect(html).toContain('id="boot-shell"');
  expect(html).toMatch(/<link rel="stylesheet" href="[^"]*shell\.css"/);
  expect(html).not.toMatch(/<style/i); // CSP: style-src 'self'
  const css = await request.get('/shell.css');
  expect(css.ok()).toBe(true);
});

test('hosting headers: hashed files immutable, entry points always fresh', async () => {
  const headers = await readFile(new URL('../dist/_headers', import.meta.url), 'utf8');
  expect(headers).toMatch(/\/assets\/\*\n\s+Cache-Control: public, max-age=31536000, immutable/);
  for (const entry of ['/index.html', '/sw.js', '/version.json', '/precache.json'])
    expect(headers).toContain(`${entry}\n  Cache-Control: no-cache`);
});

test('the shell is replaced by the app and a signed-out boot is not serialized behind the backend', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const backend: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/rest/v1/') || r.url().includes('/auth/v1/')) backend.push(r.url());
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
  await expect(page.locator('#boot-shell')).toHaveCount(0);
  await expect(page.locator('.app-bar')).toBeVisible();
  // No sign-in yet: the first screen needs no backend call at all.
  expect(backend.filter((u) => u.includes('/rest/v1/'))).toEqual([]);
});
