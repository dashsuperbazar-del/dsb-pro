import { stockTask, addItemForm } from './design-helpers';
import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const PASSWORD = 'TestOnly-2026!pw';
const email = () => `suppliers-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

async function ownerWithBill(page: Page) {
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email());
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Supplier Pay Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/Overview/)).toBeVisible();
  await page.goto('/inventory');
  await stockTask(page, 'Suppliers');
  await page.getByPlaceholder('Supplier name').fill('Acme Traders');
  await page.getByRole('button', { name: 'Create supplier' }).click();
  await expect(page.getByRole('status')).toContainText('Created supplier Acme Traders');
  await addItemForm(page);
  await page.getByPlaceholder('Item name').fill('Rice bag');
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(page.getByRole('status')).toContainText('Created Rice bag');
  await stockTask(page, 'Purchases');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase' }) });
  await purchase.locator('select[name="partyId"]').selectOption({ label: 'Acme Traders' });
  await purchase.locator('select[name="itemId"]').selectOption({ label: 'Rice bag' });
  await purchase.locator('input[name="qty"]').fill('10');
  await purchase.locator('input[name="price"]').fill('10');
  await purchase.getByRole('button', { name: 'Add line' }).click();
  await purchase.locator('input[name="billNo"]').fill('ACME-1');
  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  await expect(page.getByRole('status')).toContainText('Purchase posted');
  await page.goto('/');
  await page.getByRole('link', { name: 'Suppliers & payments' }).click();
  await page.getByLabel('Supplier', { exact: true }).selectOption({ label: 'Acme Traders' });
}
const bills = (page: Page) =>
  page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Open bills', includeHidden: true }) });
const history = (page: Page) =>
  page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Payment history', includeHidden: true }) });

async function ledgerTask(page: Page) {
  await page
    .getByRole('navigation', { name: 'Supplier tasks' })
    .getByRole('button', { name: 'Ledger', exact: true })
    .click();
  return page.getByRole('region', { name: 'Supplier statement', exact: true });
}

test('supplier statement shares/downloads complete server history and prints the selected period', async ({
  page,
  context,
}, testInfo) => {
  const headers = await readFile(new URL('../dist/_headers', import.meta.url), 'utf8');
  const csp = headers.match(/Content-Security-Policy: (.+)/)![1];
  // Preview normally omits hosting headers. Exercise the real production CSP, including the
  // inherited blank print window: inline/data CSS must not be required.
  await page.route('**/suppliers', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'content-security-policy': csp },
    });
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (value: ShareData) => {
        (window as unknown as { shared: ShareData }).shared = value;
      },
    });
    window.print = () => {
      (window as unknown as { printed: boolean }).printed = true;
    };
  });
  await ownerWithBill(page);
  await record(page, '30');
  await expect(page.getByRole('status')).toContainText('confirmed by the server');
  const statement = await ledgerTask(page);
  await expect(statement.getByLabel('Prepared supplier statement')).toContainText('Closing ₹70.00');
  await expect(statement.locator('tbody tr')).toHaveCount(2);
  await statement.getByRole('button', { name: 'Share text' }).click();
  const shared = await page.evaluate(() => (window as unknown as { shared: ShareData }).shared);
  expect(shared.text).toContain('Supplier Pay Shop');
  expect(shared.text).toContain('Acme Traders');
  expect(shared.text).toContain('ACME-1');
  expect(shared.text).toContain('Payment made');
  expect(shared.text).toContain('Closing: ₹70.00');

  const downloadPromise = page.waitForEvent('download');
  await statement.getByRole('button', { name: 'Download CSV' }).click();
  const download = await downloadPromise;
  const csv = await readFile((await download.path())!, 'utf8');
  expect(csv).toContain('Purchase,ACME-1,100.00,100.00');
  expect(csv).toContain(',-30.00,70.00');
  expect(csv).toContain('Closing,,0.00,70.00');
  expect(download.suggestedFilename()).toMatch(/^supplier-statement-.*\.csv$/);
  const textDownloadPromise = page.waitForEvent('download');
  await statement.getByRole('button', { name: 'Download text' }).click();
  const textDownload = await textDownloadPromise;
  expect(await readFile((await textDownload.path())!, 'utf8')).toContain(shared.text!);

  await page.setViewportSize({ width: 390, height: 844 });
  await statement.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('supplier-statement-phone.png'),
    fullPage: true,
  });
  const popupPromise = context.waitForEvent('page');
  await statement.getByRole('button', { name: 'Print A4 / PDF' }).click();
  const popup = await popupPromise;
  await expect(
    popup.getByRole('heading', { name: 'Supplier statement: Acme Traders' }),
  ).toBeVisible();
  await expect(popup.locator('tbody tr')).toHaveCount(2);
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  expect(await popup.evaluate(() => (window as unknown as { printed: boolean }).printed)).toBe(
    true,
  );
  await popup.setViewportSize({ width: 1100, height: 800 });
  await popup.emulateMedia({ media: 'print' });
  await popup.screenshot({
    path: testInfo.outputPath('supplier-statement-desktop.png'),
    fullPage: true,
  });
  await popup.close();

  const today = await statement.getByLabel('Statement through').inputValue();
  const tomorrow = new Date(`${today}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const next = tomorrow.toISOString().slice(0, 10);
  await statement.getByLabel('Statement through').fill(next);
  await statement.getByLabel('Statement from').fill(next);
  await expect(statement.getByRole('button', { name: 'Download CSV' })).toBeDisabled();
  await statement.getByRole('button', { name: 'Prepare statement', exact: true }).click();
  await expect(statement.getByLabel('Prepared supplier statement')).toContainText(
    'Opening ₹70.00 · Closing ₹70.00',
  );
  await expect(statement.getByLabel('Prepared supplier statement')).toContainText(
    'No posted entries in this period',
  );
  await statement.getByRole('button', { name: 'Share text' }).click();
  const emptyText = await page.evaluate(
    () => (window as unknown as { shared: ShareData }).shared.text,
  );
  expect(emptyText).toContain('Opening: ₹70.00');
  expect(emptyText).not.toContain('ACME-1');
  await page.route('**/rpc/get_party_ledger_v2', (route) => route.abort('internetdisconnected'));
  await statement.getByRole('button', { name: 'Prepare statement', exact: true }).click();
  await expect(statement.getByRole('alert')).toBeVisible();
  await expect(statement.getByRole('button', { name: 'Print A4 / PDF' })).toBeDisabled();
});

async function record(page: Page, amount: string, toBill?: string) {
  await page
    .getByRole('navigation', { name: 'Supplier tasks' })
    .getByRole('button', { name: 'Record payment', exact: true })
    .click();
  if (toBill) await page.getByLabel('Allocate to ACME-1').fill(toBill);
  await page.getByLabel('Amount paid ₹').fill(amount);
  await page.getByRole('button', { name: 'Review' }).click();
  await expect(page.getByLabel('Confirm payment')).toContainText('already made');
  await page.getByRole('button', { name: 'Confirm and record' }).click();
}

test('partial bill + advance, allocate the advance, release the match, void', async ({ page }) => {
  await ownerWithBill(page);
  await expect(bills(page).locator('tbody tr')).toContainText('₹100.00');

  await record(page, '100', '40');
  await expect(page.getByRole('status')).toContainText('confirmed by the server');
  await expect(bills(page).locator('tbody tr')).toContainText('₹60.00');
  await page
    .getByRole('navigation', { name: 'Supplier tasks' })
    .getByRole('button', { name: 'Payments', exact: true })
    .click();
  const row = history(page).locator('tbody tr').first();
  await expect(row).toContainText('₹100.00');
  await expect(row).toContainText('₹60.00'); // advance left

  const answers = ['ACME-1', '60'];
  page.on(
    'dialog',
    (d) => void d.accept(d.type() === 'prompt' ? (answers.shift() ?? 'test reason') : undefined),
  );
  await row.getByRole('button', { name: 'Allocate advance' }).click();
  await expect(page.getByRole('status')).toContainText('confirmed by the server');
  await expect(bills(page).locator('tbody tr').first().locator('td').nth(5)).toHaveText('₹0.00');

  await page
    .getByRole('navigation', { name: 'Supplier tasks' })
    .getByRole('button', { name: 'Payments', exact: true })
    .click();
  await history(page).locator('tbody tr').first().getByRole('button', { name: 'Bills' }).click();
  await page
    .getByRole('navigation', { name: 'Supplier tasks' })
    .getByRole('button', { name: 'Payments', exact: true })
    .click();
  await history(page).getByRole('button', { name: 'Release' }).first().click();
  await expect(page.getByRole('status')).toContainText('confirmed by the server');
  await expect(history(page).locator('tbody tr').first()).toContainText('POSTED'); // cash stays recorded

  await page
    .getByRole('navigation', { name: 'Supplier tasks' })
    .getByRole('button', { name: 'Payments', exact: true })
    .click();
  await history(page).locator('tbody tr').first().getByRole('button', { name: 'Void' }).click();
  await expect(page.getByRole('status')).toContainText('confirmed by the server');
  await expect(history(page).locator('tbody tr').first()).toContainText('VOID');
  await expect(bills(page).locator('tbody tr').first().locator('td').nth(5)).toHaveText('₹100.00');
});

test('a response lost after commit is reconciled by request id, never recorded twice', async ({
  page,
}) => {
  await ownerWithBill(page);
  let dropped = 0;
  await page.route('**/rpc/record_supplier_payment', async (route) => {
    if (dropped++ === 0) {
      await route.fetch(); // the server commits ...
      await route.abort('connectionreset'); // ... but the answer never arrives
    } else await route.continue();
  });
  await record(page, '30');
  await expect(page.getByRole('alert').first()).toContainText('Do NOT record this payment again');
  const pending = page.getByRole('alert', { name: 'Unresolved payments' });
  await expect(pending).toContainText('UNKNOWN');
  await page
    .getByRole('navigation', { name: 'Supplier tasks' })
    .getByRole('button', { name: 'Ledger', exact: true })
    .click();
  await expect(pending).toContainText('UNKNOWN');
  await expect(page.getByRole('button', { name: 'Review' })).toHaveCount(0); // blocked until resolved

  await page.reload();
  await page.getByLabel('Supplier', { exact: true }).selectOption({ label: 'Acme Traders' });
  await page.getByRole('button', { name: 'Check status' }).click();
  await expect(page.getByRole('status')).toContainText('confirmed by the server');
  await expect(history(page).locator('tbody tr')).toHaveCount(1);
  expect(dropped).toBe(1);
});

test('offline before dispatch keeps the request and sends it exactly once later', async ({
  page,
  context,
}) => {
  await ownerWithBill(page);
  let calls = 0;
  await page.route('**/rpc/record_supplier_payment', async (route) => {
    calls++;
    if (calls === 1) await route.abort('internetdisconnected');
    else await route.continue();
  });
  await record(page, '25');
  await expect(page.getByRole('alert', { name: 'Unresolved payments' })).toContainText('UNKNOWN');
  await page.getByRole('button', { name: 'Check status' }).click(); // NOT_FOUND → same id resent
  await expect(page.getByRole('status')).toContainText('confirmed by the server');
  await expect(history(page).locator('tbody tr')).toHaveCount(1);
  expect(calls).toBe(2);
  await context.clearCookies();
});
