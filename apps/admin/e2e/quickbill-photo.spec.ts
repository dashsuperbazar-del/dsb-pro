import { test, expect } from '@playwright/test';
import { openBillDetails } from './design-helpers';

// Quick bill with a bill photo: the bytes are kept on the device first, the saved draft lists the photo,
// the photo survives a reload before any upload, and opening the draft uploads it once (same path as the
// full bill card).
test('quick bill photo is kept, survives reload before upload, and uploads from the opened draft', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/signup');
  await page.getByLabel('Email').fill(`quickbill-photo-${Date.now()}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill('TestOnly-2026!pw');
  await page.getByLabel('Confirm password').fill('TestOnly-2026!pw');
  await page.getByRole('button', { name: 'Sign up', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Quick bill photo shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.goto('/purchases?new=1');
  await page.getByText('Add a supplier', { exact: true }).click();
  const supplier = page
    .getByRole('button', { name: 'Create & select supplier' })
    .locator('xpath=..');
  await supplier.getByPlaceholder('New supplier name').fill('Photo Supplier');
  await supplier.getByRole('button', { name: 'Create & select supplier' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Created supplier' })).toBeVisible();

  const image = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 600;
    c.height = 800;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 600, 800);
    ctx.fillStyle = '#111';
    ctx.font = '30px sans-serif';
    ctx.fillText('SYNTHETIC PAPER BILL', 40, 80);
    return c.toDataURL('image/png').split(',')[1];
  });
  let uploads = 0;
  await page.route('**/storage/v1/object/bill-documents/**', (route) => {
    if (route.request().method() === 'POST') uploads++;
    return route.continue();
  });

  const quick = page.getByLabel('Quick bill', { exact: true });
  await quick.locator('summary').first().click();
  await quick.getByLabel('Quick bill supplier').selectOption({ label: 'Photo Supplier' });
  await quick.getByLabel('Quick bill number').fill('QB-1');
  await quick.getByLabel('Quick bill total').fill('250');
  await quick.getByLabel('Choose bill image (quick bill)', { exact: true }).setInputFiles({
    name: 'paper.png',
    mimeType: 'image/png',
    buffer: Buffer.from(image, 'base64'),
  });
  await expect(quick.getByTestId('bill-photo-1-quick')).toContainText('Kept on this device');
  await quick.getByRole('button', { name: 'Save quick bill' }).click();
  await expect(quick.getByRole('status')).toContainText('Quick bill saved as a draft');
  expect(uploads).toBe(0);

  // Before any upload: reload, the draft still lists the photo.
  await page.reload();
  await page.getByText('Saved purchase drafts', { exact: true }).click();
  const row = page.locator('.context-actions').filter({ hasText: 'Quick bill QB-1' });
  await expect(row).toContainText('1 photo');

  // Opening the draft shows the photo and uploads it once through the bill card path.
  await row.getByRole('button', { name: 'Resume draft', exact: true }).click();
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase', exact: true }) })
    .last();
  await openBillDetails(purchase);
  const card = purchase.getByLabel('Bill attachment', { exact: true });
  await expect(card).toContainText('paper.png');
  await expect(card).toContainText('Upload confirmed');
  expect(uploads).toBe(1);
  await card.getByRole('button', { name: 'View bill document', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Bill document viewer' }).getByRole('img'),
  ).toBeVisible();
});
