import { test, expect } from '@playwright/test';

const PASSWORD = 'TestOnly-2026!pw';
function uniqueEmail() {
  return `share-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

test('statement "Share as image" falls back to a PNG download and a WhatsApp link', async ({
  page,
  context,
}) => {
  // No file share sheet in this browser: force the fallback path explicitly.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'canShare', { value: () => false, configurable: true });
  });
  const opened: string[] = [];
  await context.route('https://wa.me/**', (route) => {
    opened.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/html', body: 'ok' });
  });
  await page.goto('/signup');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Share Image Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/Overview/)).toBeVisible();
  await page.getByRole('link', { name: 'Customers & ledger' }).click();
  await page
    .locator('summary')
    .filter({ hasText: /^Add customer$/ })
    .click();
  await page.getByLabel('Name').fill('Image Customer');
  await page.getByLabel('Phone').first().fill('98765 43210');
  await page.getByRole('button', { name: 'Create customer' }).click();
  await expect(page.getByText(/Customer owes ₹0.00/)).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Customer tasks' })
    .getByRole('button', { name: 'Ledger', exact: true })
    .click();
  await expect(page.getByLabel('Prepared customer statement')).toContainText('Closing ₹0.00');

  const popup = context.waitForEvent('page');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Share as image' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^customer-statement-Image-Customer-.*\.png$/);
  const bytes = await file.createReadStream().then(
    (s) =>
      new Promise<Buffer>((resolve, reject) => {
        const parts: Buffer[] = [];
        s.on('data', (c: Buffer) => parts.push(c));
        s.on('end', () => resolve(Buffer.concat(parts)));
        s.on('error', reject);
      }),
  );
  // PNG signature.
  expect(bytes.subarray(0, 4).toString('hex')).toBe('89504e47');
  const wa = await popup;
  await wa.waitForLoadState();
  expect(wa.url()).toMatch(/^https:\/\/wa\.me\/919876543210\?text=/);
  expect(decodeURIComponent(wa.url().split('text=')[1]!)).toContain(
    'customer statement for Image Customer',
  );
  expect(opened.length).toBeGreaterThan(0);
  await expect(page.getByRole('status').filter({ hasText: 'Image downloaded' })).toBeVisible();
});
