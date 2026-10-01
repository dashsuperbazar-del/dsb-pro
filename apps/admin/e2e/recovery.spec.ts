// V002 verifier findings VF-005/006/007: a write whose outcome is unknown is stored on the device
// before it is sent, survives reload, is retried with the same request id, and is never replaced by
// a new id. Each case commits on the real local database and then loses or withholds the answer.
import { test, expect, type Page, type Route } from '@playwright/test';

const PASSWORD = 'TestOnly-2026!pw';
const email = () => `recovery-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

async function createOwnerShop(page: Page) {
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email());
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Recovery Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/DSB Pro — Admin/)).toBeVisible();
}

// The first call commits on the server; its answer is withheld until the page is reloaded
// (a crash or closed tab while the response is pending). Later calls pass through.
function commitThenCrash(page: Page, pattern: string) {
  const state = { calls: 0, committed: false };
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  void page.route(pattern, async (route: Route) => {
    if (state.calls++ === 0) {
      await route.fetch();
      state.committed = true;
      await gate;
      await route.abort('connectionreset').catch(() => undefined);
    } else await route.continue();
  });
  return { state, release: () => release() };
}

test('expense: a crash after commit keeps the request; the retry posts it exactly once', async ({
  page,
}) => {
  await createOwnerShop(page);
  await page.goto('/expenses');
  const net = commitThenCrash(page, '**/rpc/post_expense');
  await page.getByLabel('Category').fill('Rent');
  await page.getByLabel('Amount ₹').fill('1000');
  await page.getByRole('button', { name: 'Post expense' }).click();
  await expect.poll(() => net.state.committed).toBe(true);
  await page.reload(); // the answer never arrived
  net.release();
  await expect(page.getByRole('button', { name: 'Retry same expense' })).toBeVisible();
  await expect(page.getByLabel('Amount ₹')).toBeDisabled();
  await page.getByRole('button', { name: 'Retry same expense' }).click();
  await expect(page.getByRole('status')).toContainText('Expense posted.');
  await expect(page.getByRole('region', { name: 'Expenses today' })).toContainText('1,000.00');
  expect(net.state.calls).toBe(2);
});

test('expense: a gateway error after commit is unknown, not a refusal', async ({ page }) => {
  await createOwnerShop(page);
  await page.goto('/expenses');
  let calls = 0;
  await page.route('**/rpc/post_expense', async (route) => {
    if (calls++ === 0) {
      await route.fetch();
      await route.fulfill({ status: 502, contentType: 'text/plain', body: 'Bad Gateway' });
    } else await route.continue();
  });
  await page.getByLabel('Category').fill('Rent');
  await page.getByLabel('Amount ₹').fill('300');
  await page.getByRole('button', { name: 'Post expense' }).click();
  await expect(page.getByRole('status')).toContainText('Not confirmed');
  await expect(page.getByLabel('Amount ₹')).toBeDisabled();
  await page.getByRole('button', { name: 'Retry same expense' }).click();
  await expect(page.getByRole('status')).toContainText('Expense posted.');
  await expect(page.getByRole('region', { name: 'Expenses today' })).toContainText('300.00');
  expect(calls).toBe(2);
});

test('expense: if the device cannot store the request, nothing is sent', async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith('dsb-pending-expense:'))
        throw new DOMException('full', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await createOwnerShop(page);
  await page.goto('/expenses');
  let calls = 0;
  await page.route('**/rpc/post_expense', async (route) => {
    calls++;
    await route.continue();
  });
  await page.getByLabel('Category').fill('Rent');
  await page.getByLabel('Amount ₹').fill('50');
  await page.getByRole('button', { name: 'Post expense' }).click();
  await expect(page.getByRole('status')).toContainText('Nothing was sent');
  expect(calls).toBe(0);
});

test('stock count: answer lost after posting; the retry after reload never applies it twice', async ({
  page,
}) => {
  await createOwnerShop(page);
  await page.goto('/inventory');
  await page.getByPlaceholder('Item name').fill('Count Item');
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(page.getByRole('status')).toContainText('Created Count Item');
  await page.goto('/stock-adjust');
  const net = commitThenCrash(page, '**/rpc/post_stock_count');
  await page.getByLabel('Item').selectOption({ label: 'Count Item' });
  await page.getByLabel('Counted quantity (smallest unit)').fill('7');
  await page.getByRole('button', { name: 'Post stock count' }).click();
  await expect.poll(() => net.state.committed).toBe(true);
  await page.reload();
  net.release();
  await expect(page.getByRole('button', { name: 'Retry posting this count' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry posting this count' }).click();
  await expect(page.getByRole('status')).toContainText('already posted by an earlier attempt');
  await page.getByLabel('Item').selectOption({ label: 'Count Item' });
  await expect(page.getByLabel('expected stock')).toContainText('Expected 7');
  expect(net.state.calls).toBe(1); // status was read; the count was not posted again
});

test('purchase: a crash after commit keeps the bill locked; the retry posts it once', async ({
  page,
}) => {
  await createOwnerShop(page);
  await page.getByRole('link', { name: 'Inventory & purchases' }).click();
  await page.getByPlaceholder('Item name').fill('Rice bag');
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(page.getByRole('status')).toContainText('Created Rice bag');
  const net = commitThenCrash(page, '**/rpc/post_purchase');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase' }) });
  await purchase.locator('select[name="itemId"]').selectOption({ label: 'Rice bag' });
  await purchase.locator('input[name="qty"]').fill('10');
  await purchase.locator('input[name="price"]').fill('5');
  await purchase.getByRole('button', { name: 'Add line' }).click();
  await purchase.locator('input[name="billNo"]').fill('REC-1');
  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  await expect.poll(() => net.state.committed).toBe(true);
  await page.reload();
  net.release();
  const again = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase' }) });
  await expect(again.getByRole('button', { name: 'Retry same purchase' })).toBeVisible();
  await again.getByRole('button', { name: 'Retry same purchase' }).click();
  await expect(page.getByRole('status')).toContainText('Purchase posted');
  await page.goto('/stock-adjust');
  await page.getByLabel('Item').selectOption({ label: 'Rice bag' });
  await expect(page.getByLabel('expected stock')).toContainText('Expected 10');
  expect(net.state.calls).toBe(2);
});

test('customer receipt: switching to a customer with an unresolved receipt cannot bypass it', async ({
  page,
}) => {
  await createOwnerShop(page);
  await page.getByRole('link', { name: 'Customers & ledger' }).click();
  await page.getByLabel('Name').fill('Customer B');
  await page.getByRole('button', { name: 'Create customer' }).click();
  await expect(page.getByText(/Balance ₹0.00/)).toBeVisible();
  // B gets a receipt whose answer is lost after commit (UNKNOWN on this device).
  let calls = 0;
  await page.route('**/rpc/record_customer_payment_v2', async (route) => {
    calls++;
    await route.fetch();
    await route.abort('connectionreset');
  });
  await page.getByLabel('Amount ₹').fill('25');
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByRole('alert', { name: 'Unresolved receipts' })).toContainText('UNKNOWN');

  await page.getByLabel('Name').fill('Customer A');
  await page.getByRole('button', { name: 'Create customer' }).click();
  await expect(page.getByRole('alert', { name: 'Unresolved receipts' })).toHaveCount(0);

  // Hold B's ledger answer, then switch to B and try to submit while B is still loading.
  let releaseLedger: () => void = () => undefined;
  const ledgerGate = new Promise<void>((r) => (releaseLedger = r));
  await page.route('**/rest/v1/customer_ledger*', async (route) => {
    await ledgerGate;
    await route.continue();
  });
  await page
    .locator('select')
    .filter({ has: page.locator('option', { hasText: 'Customer B' }) })
    .first()
    .selectOption({ label: 'Customer B' });
  const submit = page
    .locator('form')
    .filter({ has: page.getByLabel('Amount ₹') })
    .locator('button.primary');
  await expect(submit).toBeDisabled();
  await expect(submit).toHaveText('Loading…');
  releaseLedger();
  await expect(page.getByRole('alert', { name: 'Unresolved receipts' })).toContainText('UNKNOWN');
  await expect(submit).toBeDisabled();
  expect(calls).toBe(1);
});

test('expense: a second window cannot overwrite the first window’s unconfirmed expense', async ({
  page,
}) => {
  await createOwnerShop(page);
  await page.goto('/expenses');
  const other = await page.context().newPage();
  await other.goto('/expenses'); // mounted before the first window stores its entry
  await expect(other.getByRole('button', { name: 'Post expense' })).toBeEnabled();
  let calls = 0;
  await page.context().route('**/rpc/post_expense', async (route) => {
    if (calls++ === 0) {
      await route.fetch();
      await route.fulfill({ status: 502, contentType: 'text/plain', body: 'Bad Gateway' });
    } else await route.continue();
  });
  await page.getByLabel('Category').fill('Rent');
  await page.getByLabel('Amount ₹').fill('1000');
  await page.getByRole('button', { name: 'Post expense' }).click();
  await expect(page.getByRole('status')).toContainText('Not confirmed');

  await other.getByLabel('Category').fill('Tea & snacks');
  await other.getByLabel('Amount ₹').fill('20');
  await other.getByRole('button', { name: 'Post expense' }).click();
  await expect(other.getByRole('status')).toContainText('Another window');
  expect(calls).toBe(1);

  await page.getByRole('button', { name: 'Retry same expense' }).click();
  await expect(page.getByRole('status')).toContainText('Expense posted.');
  await expect(page.getByRole('region', { name: 'Expenses today' })).toContainText('1,000.00');
});
