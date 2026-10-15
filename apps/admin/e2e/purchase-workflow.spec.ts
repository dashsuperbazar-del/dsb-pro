import { readFile } from 'node:fs/promises';
import { test, expect, type Request, type Response } from '@playwright/test';
import { addItemForm } from './design-helpers';
test('DSB purchase detail, repeat and contextual payment use the same financial records', async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/signup');
  await page.getByLabel('Email').fill(`purchase-workflow-${Date.now()}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill('TestOnly-2026!pw');
  await page.getByLabel('Confirm password').fill('TestOnly-2026!pw');
  await page.getByRole('button', { name: 'Sign up', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Purchase workflow shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.goto('/inventory');
  await addItemForm(page);
  await page.getByPlaceholder('Item name', { exact: true }).fill('Daily oil');
  await page.getByPlaceholder('Big unit (e.g. case)').fill('jar');
  await page.getByRole('button', { name: 'Create item', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Created Daily oil' })).toContainText(
    'Created Daily oil',
  );
  // Main's editor first loads its catalog, then prepares the explicit new-bill
  // context with a second business-date read. Finish that baseline before entry.
  const dateRequests = new Set<Request>();
  let dateReads = 0;
  const trackRequest = (request: Request) => {
    if (
      request.url().endsWith('/rpc/shop_business_date') &&
      new URL(request.frame().url()).pathname === '/purchases'
    )
      dateRequests.add(request);
  };
  page.on('request', trackRequest);
  const trackResponse = async (response: Response) => {
    if (dateRequests.has(response.request()) && response.ok()) {
      const failure = await response.finished().catch(() => new Error('Response did not finish'));
      if (!failure) dateReads++;
    }
  };
  page.on('response', trackResponse);
  await page.goto('/purchases?new=1');
  await expect.poll(() => dateReads).toBeGreaterThanOrEqual(2);
  page.off('request', trackRequest);
  page.off('response', trackResponse);
  const readyPurchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase', exact: true }) })
    .last();
  await expect(readyPurchase.locator('input[name="date"]')).not.toHaveValue('');
  await expect(readyPurchase.locator('fieldset').first()).toBeEnabled();
  const supplier = page
    .getByRole('button', { name: 'Create & select supplier' })
    .locator('xpath=..');
  await page.getByText('Add a supplier', { exact: true }).click();
  await supplier.getByPlaceholder('New supplier name').fill('Daily Supplier');
  await supplier.getByRole('button', { name: 'Create & select supplier' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Created supplier' })).toContainText(
    'Created supplier',
  );
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase', exact: true }) })
    .last();
  const currentBusinessDate = await purchase.locator('input[name="date"]').inputValue();
  const olderDate = new Date(currentBusinessDate + 'T12:00:00Z');
  olderDate.setUTCDate(olderDate.getUTCDate() - 1);
  await purchase.locator('input[name="date"]').fill(olderDate.toISOString().slice(0, 10));
  await purchase.locator('input[name="billNo"]').fill('DSB-1');
  await expect(purchase.locator('select[name="partyId"]')).toHaveValue(/.+/);
  await purchase.getByLabel('Purchase item', { exact: true }).selectOption({ label: 'Daily oil' });
  await purchase.locator('input[name="qty"]').fill('2');
  await purchase.locator('input[name="price"]').fill('120');
  await purchase.getByRole('button', { name: 'Add line', exact: true }).click();
  await purchase.locator('input[name="discount"]').fill('5');
  await purchase.locator('input[name="extra"]').fill('5');
  await purchase.getByRole('button', { name: 'Edit purchase line 1' }).click();
  await purchase.locator('input[name="qty"]').fill('2');
  await expect(purchase).toContainText('Draft saved on this device');
  const image = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 700;
    c.height = 1000;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 700, 1000);
    ctx.fillStyle = '#111';
    ctx.font = '30px sans-serif';
    ['SYNTHETIC SUPPLIER BILL', 'Daily oil: 2 jars', 'Unit cost: Rs 120', 'Total: Rs 240'].forEach(
      (line, i) => ctx.fillText(line, 40, 70 + i * 70),
    );
    return c.toDataURL('image/png').split(',')[1];
  });
  let uploads = 0;
  await page.route('**/storage/v1/object/bill-documents/**', async (route) => {
    if (route.request().method() === 'POST' && uploads++ === 0) {
      await route.fetch();
      await route.abort('connectionreset'); // object exists, upload answer lost
    } else await route.continue();
  });
  await purchase.getByLabel('Choose bill image', { exact: true }).setInputFiles({
    name: 'supplier-bill.png',
    mimeType: 'image/png',
    buffer: Buffer.from(image, 'base64'),
  });
  await expect(purchase.getByLabel('Bill attachment')).toContainText('Upload confirmed');
  await expect(purchase.getByRole('button', { name: 'Post purchase', exact: true })).toBeDisabled(); // line edit still requires review
  const originalSupplier = await purchase.locator('select[name="partyId"]').inputValue();
  await page.reload();
  await page.getByText('Saved purchase drafts', { exact: true }).click();
  await page.getByRole('button', { name: 'Resume draft', exact: true }).click();
  await expect(purchase.locator('input[name="billNo"]')).toHaveValue('DSB-1');
  await expect(purchase.getByLabel('Bill attachment')).toContainText('supplier-bill.png');
  await expect(purchase.getByLabel('Bill attachment')).toContainText('Upload confirmed');
  expect(uploads).toBe(1);
  await expect(purchase.locator('input[name="date"]')).toHaveValue(
    olderDate.toISOString().slice(0, 10),
  );
  await expect(purchase.locator('select[name="partyId"]')).toHaveValue(originalSupplier);
  await expect(purchase.locator('input[name="discount"]')).toHaveValue('5');
  await expect(purchase.locator('input[name="extra"]')).toHaveValue('5');
  await expect(purchase.locator('input[name="qty"]')).toHaveValue('2');
  await expect(purchase.locator('input[name="price"]')).toHaveValue('120.00');
  await expect(purchase.getByRole('button', { name: 'Post purchase', exact: true })).toBeDisabled();
  await purchase.getByRole('button', { name: 'View bill document', exact: true }).click();
  const photo = page.getByRole('dialog', { name: 'Bill document viewer' });
  await expect(photo.getByRole('img', { name: 'Attached supplier bill' })).toBeVisible();
  await photo.getByRole('button', { name: 'Zoom in' }).click();
  await photo.getByRole('button', { name: 'Move bill viewer' }).focus();
  await page.keyboard.press('ArrowLeft');
  await page.screenshot({
    path: testInfo.outputPath('15-recovered-bill-photo-phone.png'),
    fullPage: true,
  });
  await photo.getByRole('button', { name: 'Close bill viewer' }).click();
  await purchase.getByRole('button', { name: 'Update line', exact: true }).click();
  await purchase.getByRole('button', { name: 'Post purchase', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Purchase posted' })).toContainText(
    'Purchase posted',
  );
  await page.getByRole('link', { name: 'Bill list', exact: true }).click();
  await page.getByRole('button', { name: /Daily Supplier.*DSB-1/ }).click();
  const detail = page.getByLabel('Purchase detail');
  await expect(detail).toContainText('Daily oil');
  await expect(detail).toContainText('Due ₹240.00');
  await detail.getByRole('button', { name: 'View bill document' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Bill document viewer' }).getByRole('img'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close bill viewer' }).click();
  async function capture(name: string) {
    const health = page.locator('.health-summary');
    await expect(health.locator(':scope > summary')).not.toContainText('Checking…');
    if ((await health.getAttribute('open')) !== null)
      await health.locator(':scope > summary').click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(name + '.png'), fullPage: true });
  }
  await capture('12-purchases-phone');
  await detail.getByRole('link', { name: 'Repeat into new draft' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Draft repeated from DSB-1' }),
  ).toContainText('Draft repeated from DSB-1');
  await expect(purchase.locator('input[name="billNo"]')).toHaveValue('');
  await expect(purchase.getByLabel('Bill attachment')).not.toContainText('supplier-bill.png');
  await expect(purchase.locator('input[name="date"]')).toHaveValue(currentBusinessDate);
  await expect(purchase).toContainText('Daily oil');
  await purchase.locator('input[name="billNo"]').fill('DSB-2');
  const pdfBody = Buffer.from(
    'JVBERi0xLjMKJZOMi54gUmVwb3J0TGFiIEdlbmVyYXRlZCBQREYgZG9jdW1lbnQgKG9wZW5zb3VyY2UpCjEgMCBvYmoKPDwKL0YxIDIgMCBSCj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9CYXNlRm9udCAvSGVsdmV0aWNhIC9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nIC9OYW1lIC9GMSAvU3VidHlwZSAvVHlwZTEgL1R5cGUgL0ZvbnQKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL0NvbnRlbnRzIDcgMCBSIC9NZWRpYUJveCBbIDAgMCAzMDAgMzAwIF0gL1BhcmVudCA2IDAgUiAvUmVzb3VyY2VzIDw8Ci9Gb250IDEgMCBSIC9Qcm9jU2V0IFsgL1BERiAvVGV4dCAvSW1hZ2VCIC9JbWFnZUMgL0ltYWdlSSBdCj4+IC9Sb3RhdGUgMCAvVHJhbnMgPDwKCj4+IAogIC9UeXBlIC9QYWdlCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9QYWdlTW9kZSAvVXNlTm9uZSAvUGFnZXMgNiAwIFIgL1R5cGUgL0NhdGFsb2cKPj4KZW5kb2JqCjUgMCBvYmoKPDwKL0F1dGhvciAoYW5vbnltb3VzKSAvQ3JlYXRpb25EYXRlIChEOjIwMDAwMTAxMDAwMDAwKzAwJzAwJykgL0NyZWF0b3IgKGFub255bW91cykgL0tleXdvcmRzICgpIC9Nb2REYXRlIChEOjIwMDAwMTAxMDAwMDAwKzAwJzAwJykgL1Byb2R1Y2VyIChSZXBvcnRMYWIgUERGIExpYnJhcnkgLSBcKG9wZW5zb3VyY2VcKSkgCiAgL1N1YmplY3QgKHVuc3BlY2lmaWVkKSAvVGl0bGUgKHVudGl0bGVkKSAvVHJhcHBlZCAvRmFsc2UKPj4KZW5kb2JqCjYgMCBvYmoKPDwKL0NvdW50IDEgL0tpZHMgWyAzIDAgUiBdIC9UeXBlIC9QYWdlcwo+PgplbmRvYmoKNyAwIG9iago8PAovRmlsdGVyIFsgL0FTQ0lJODVEZWNvZGUgL0ZsYXRlRGVjb2RlIF0gL0xlbmd0aCAxNzQKPj4Kc3RyZWFtCkdhcm85WW1TPzUmNEhEQ2BLWSwyXCZTWmoxNCVycitYJV4yYjxsZ1ImY3NEPkorIiIlLzxqOzc9UGROajdPKiEzSEN1Qj03dEZlMyVXUTdoN1gvUEFRT2RoUDRUa0NbZUNRS1BTbWRdVjtPMCc0JDpUYmokK0FkV0xGO29hKkUoP0wwZjdccigyXEFWOC8mIiNCP2FkYltkUXAjO2M2RCpsYjcoRDAySkFyaXJ+PmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDgKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDYxIDAwMDAwIG4gCjAwMDAwMDAwOTIgMDAwMDAgbiAKMDAwMDAwMDE5OSAwMDAwMCBuIAowMDAwMDAwMzkyIDAwMDAwIG4gCjAwMDAwMDA0NjAgMDAwMDAgbiAKMDAwMDAwMDcyMSAwMDAwMCBuIAowMDAwMDAwNzgwIDAwMDAwIG4gCnRyYWlsZXIKPDwKL0lEIApbPDFjMTc4MTk4ZmJkZmE1MWIyNTk5NWQ4OWQ0MTAyMDQzPjwxYzE3ODE5OGZiZGZhNTFiMjU5OTVkODlkNDEwMjA0Mz5dCiUgUmVwb3J0TGFiIGdlbmVyYXRlZCBQREYgZG9jdW1lbnQgLS0gZGlnZXN0IChvcGVuc291cmNlKQoKL0luZm8gNSAwIFIKL1Jvb3QgNCAwIFIKL1NpemUgOAo+PgpzdGFydHhyZWYKMTA0NAolJUVPRgo=',
    'base64',
  );
  await purchase
    .getByLabel('Choose bill PDF', { exact: true })
    .setInputFiles({ name: 'supplier-bill.pdf', mimeType: 'application/pdf', buffer: pdfBody });
  await expect(purchase.getByLabel('Bill attachment')).toContainText('Upload confirmed');
  await capture('13-repeat-purchase-phone');
  await purchase.getByRole('button', { name: 'Post purchase', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Purchase posted' })).toContainText(
    'Purchase posted',
  );
  await page.getByRole('link', { name: 'Bill list', exact: true }).click();
  // Repeating the same source again after posting must create a fresh, unposted draft.
  await page.getByRole('button', { name: /Daily Supplier.*DSB-1/ }).click();
  await detail.getByRole('link', { name: 'Repeat into new draft' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Draft repeated from DSB-1' }),
  ).toContainText('Draft repeated from DSB-1');
  await expect(purchase.getByLabel('Purchase cart')).toContainText('₹240.00');
  await page.getByRole('link', { name: 'Bill list', exact: true }).click();
  await page.getByRole('button', { name: /Daily Supplier.*DSB-2/ }).click();
  await detail.getByRole('button', { name: 'View bill document' }).click();
  await expect(photo.getByRole('link', { name: 'Open PDF' })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    photo.getByRole('link', { name: 'Download document' }).click(),
  ]);
  const downloadedPath = testInfo.outputPath('confirmed-bill.pdf');
  await download.saveAs(downloadedPath);
  expect(await readFile(downloadedPath)).toEqual(pdfBody);
  await photo.getByRole('button', { name: 'Close bill viewer' }).click();
  await detail.getByRole('link', { name: 'Record payment', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Suppliers & payments' })).toBeVisible();
  await expect(page.getByLabel('Amount paid ₹')).toHaveValue('');
  await expect(page.getByLabel('Allocate to DSB-2')).toHaveValue('240.00');
  await page.getByLabel('Amount paid ₹').fill('100');
  await page.getByRole('button', { name: 'Auto · oldest first' }).click();
  await expect(page.getByLabel('Allocate to DSB-1')).toHaveValue('100.00');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm and record', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'confirmed by the server' }),
  ).toContainText('confirmed by the server');
  await expect(
    page.getByRole('heading', { name: 'Summary', exact: true }).locator('..'),
  ).toContainText('₹380.00');
  await capture('14-context-payment-phone');
  await page.goto('/purchases');
  await page.getByRole('button', { name: /Daily Supplier.*DSB-1/ }).click();
  await expect(page.getByLabel('Purchase detail')).toContainText('Due ₹140.00');
  await page.goto('/inventory');
  await expect(page.getByRole('button', { name: /Daily oil/ }).first()).toContainText('4');
});
