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

test('customer receipt: a second window waits for the first and then refuses to record it again', async ({
  page,
}) => {
  await createOwnerShop(page);
  await page.getByRole('link', { name: 'Customers & ledger' }).click();
  await page.getByLabel('Name').fill('Two Window Customer');
  await page.getByRole('button', { name: 'Create customer' }).click();
  await expect(page.getByText(/Balance ₹0.00/)).toBeVisible();
  const other = await page.context().newPage();
  await other.goto('/customers');
  await other
    .locator('select')
    .filter({ has: other.locator('option', { hasText: 'Two Window Customer' }) })
    .first()
    .selectOption({ label: 'Two Window Customer' });
  await expect(other.getByRole('button', { name: 'Record payment' })).toBeEnabled();

  let calls = 0;
  let committed = false;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  await page.context().route('**/rpc/record_customer_payment_v2', async (route) => {
    calls++;
    await route.fetch();
    committed = true;
    await gate;
    await route.abort('connectionreset');
  });
  await page.getByLabel('Amount ₹').fill('40');
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect.poll(() => committed).toBe(true);

  // Both windows passed their screen checks; the second must wait for the first's send to settle.
  await other.getByLabel('Amount ₹').fill('40');
  await other.getByRole('button', { name: 'Record payment' }).click();
  release();
  await expect(page.getByRole('alert', { name: 'Unresolved receipts' })).toContainText('UNKNOWN');
  await expect(other.getByText(/Another window just recorded a payment/)).toBeVisible();
  expect(calls).toBe(1);
});

test('customer receipt: when the first window succeeds, the waiting window does not send a second payment', async ({
  page,
}) => {
  await createOwnerShop(page);
  await page.getByRole('link', { name: 'Customers & ledger' }).click();
  await page.getByLabel('Name').fill('Success Window Customer');
  await page.getByRole('button', { name: 'Create customer' }).click();
  await expect(page.getByText(/Balance ₹0.00/)).toBeVisible();
  const other = await page.context().newPage();
  await other.goto('/customers');
  await other
    .locator('select')
    .filter({ has: other.locator('option', { hasText: 'Success Window Customer' }) })
    .first()
    .selectOption({ label: 'Success Window Customer' });
  await expect(other.getByRole('button', { name: 'Record payment' })).toBeEnabled();

  let calls = 0;
  let inFlight = false;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  await page.context().route('**/rpc/record_customer_payment_v2', async (route) => {
    calls++;
    const response = await route.fetch();
    inFlight = true;
    await gate;
    await route.fulfill({ response }); // the first payment is confirmed normally
  });
  await page.getByLabel('Amount ₹').fill('40');
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect.poll(() => inFlight).toBe(true);
  await other.getByLabel('Amount ₹').fill('40');
  await other.getByRole('button', { name: 'Record payment' }).click();
  release();
  await expect(page.getByText(/Payment recorded/)).toBeVisible();
  await expect(other.getByText(/Another window just recorded a payment/)).toBeVisible();
  expect(calls).toBe(1);
});

test('expense: two unconfirmed expenses from racing windows are each finished once (VF-009)', async ({
  page,
}) => {
  await createOwnerShop(page);
  await page.goto('/expenses');
  let calls = 0;
  await page.route('**/rpc/post_expense', async (route) => {
    if (calls++ === 0) {
      await route.fetch(); // A commits, answer lost
      await route.abort('connectionreset');
    } else await route.continue();
  });
  await page.getByLabel('Category').fill('Rent');
  await page.getByLabel('Amount ₹').fill('100');
  await page.getByRole('button', { name: 'Post expense' }).click();
  await expect(page.getByRole('status')).toContainText('Not confirmed');
  // A second window raced past the check and stored B (never sent) under its own key.
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('dsb-pending-expense:'))!;
    const a = JSON.parse(localStorage.getItem(key)!);
    const prefix = key.slice(0, key.lastIndexOf(':'));
    const b = {
      req: { ...a.req, category: 'Transport', description: 'Transport', amountPaise: 2500 },
      clientId: crypto.randomUUID(),
      savedAt: a.savedAt + 1,
    };
    localStorage.setItem(`${prefix}:${b.clientId}`, JSON.stringify(b));
  });
  await page.reload();
  await page.getByRole('button', { name: 'Retry same expense' }).click();
  await expect(page.getByRole('status')).toContainText('Expense posted.');
  await expect(page.getByRole('status')).toContainText('Another expense from this device');
  await page.getByRole('button', { name: 'Retry same expense' }).click();
  await expect(page.getByRole('status')).toContainText('Expense posted.');
  await expect(page.getByRole('button', { name: 'Post expense' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Expenses today' })).toContainText('125.00');
});

test('customer receipt: finishing customer A’s receipt after switching to B never shows or voids A’s payment under B (VF-007)', async ({
  page,
}) => {
  await createOwnerShop(page);
  await page.getByRole('link', { name: 'Customers & ledger' }).click();
  await page.getByLabel('Name').fill('Customer B');
  await page.getByRole('button', { name: 'Create customer' }).click();
  await expect(page.getByText(/Balance ₹0.00/)).toBeVisible();
  await page.getByLabel('Name').fill('Customer A');
  await page.getByRole('button', { name: 'Create customer' }).click();
  await expect(page.getByText(/Customer A created/)).toBeVisible();
  await expect(page.locator('strong', { hasText: 'Customer A' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record payment' })).toBeEnabled();

  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  let committed = false;
  await page.route('**/rpc/record_customer_payment_v2', async (route) => {
    const response = await route.fetch();
    committed = true;
    await gate;
    await route.fulfill({ response });
  });
  await page.getByLabel('Amount ₹').fill('30');
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect.poll(() => committed).toBe(true);

  await page
    .locator('select')
    .filter({ has: page.locator('option', { hasText: 'Customer B' }) })
    .first()
    .selectOption({ label: 'Customer B' });
  release(); // A's receipt completes while B is selected
  await expect(page.getByText(/Payment recorded/)).toBeVisible();
  const ledger = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Customer ledger' }) });
  await expect(page.locator('strong', { hasText: 'Customer B' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record payment' })).toBeEnabled();
  await expect(ledger.getByRole('button', { name: 'Void payment' })).toHaveCount(0);
  await expect(ledger).not.toContainText('PAYMENT');
});

test('purchase without a supplier: a 502 after commit is retried in the same window and posts once (V4 review)', async ({
  page,
}) => {
  await createOwnerShop(page);
  await page.getByRole('link', { name: 'Inventory & purchases' }).click();
  await page.getByPlaceholder('Item name').fill('Loose item');
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(page.getByRole('status')).toContainText('Created Loose item');
  let calls = 0;
  await page.route('**/rpc/post_purchase', async (route) => {
    if (calls++ === 0) {
      await route.fetch();
      await route.fulfill({ status: 502, contentType: 'text/plain', body: 'Bad Gateway' });
    } else await route.continue();
  });
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase' }) });
  await purchase.locator('select[name="itemId"]').selectOption({ label: 'Loose item' });
  await purchase.locator('input[name="qty"]').fill('4');
  await purchase.locator('input[name="price"]').fill('5');
  await purchase.getByRole('button', { name: 'Add line' }).click();
  await purchase.getByRole('button', { name: 'Post purchase' }).click(); // no supplier, no bill no
  await expect(purchase.getByRole('button', { name: 'Retry same purchase' })).toBeVisible();
  await purchase.getByRole('button', { name: 'Retry same purchase' }).click();
  await expect(page.getByRole('status')).toContainText('Purchase posted');
  await page.goto('/stock-adjust');
  await page.getByLabel('Item').selectOption({ label: 'Loose item' });
  await expect(page.getByLabel('expected stock')).toContainText('Expected 4');
  expect(calls).toBe(2);
});
