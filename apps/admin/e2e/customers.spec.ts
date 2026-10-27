import { test, expect } from '@playwright/test';

const PASSWORD = 'TestOnly-2026!pw';
function uniqueEmail() {
  return `customers-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}
async function createOwnerShop(page: import('@playwright/test').Page) {
  await page.goto('/signup');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Customer Ledger Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/Overview/)).toBeVisible();
}

test('owner can open customer ledger and allocation workflow', async ({ page }) => {
  await createOwnerShop(page);
  await openAllScreens(page);
  await page.getByRole('link', { name: 'Customers & ledger' }).click();
  await expect(page.getByRole('heading', { name: 'Customers & ledger' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Customer master' })).toBeVisible();
  await page
    .locator('summary')
    .filter({ hasText: /^Add customer$/ })
    .click();
  await page.getByLabel('Name').fill('Ledger Customer');
  await page.getByRole('button', { name: 'Create customer' }).click();
  await expect(page.getByText(/Customer owes ₹0.00/)).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Receive payment / allocate invoices' }),
  ).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Customer tasks' })
    .getByRole('button', { name: 'Ledger', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Customer ledger', exact: true })).toBeVisible();
  // Statement over the real PostgREST path (empty ledger: no balance row yet).
  const empty = page.getByLabel('Prepared customer statement');
  await expect(empty).toContainText('Closing ₹0.00');
  await expect(empty).toContainText('No posted entries in this period.');
});

test("owner can correct a customer's phone and credit limit and the change survives a reload", async ({
  page,
}) => {
  await createOwnerShop(page);
  await openAllScreens(page);
  await page.getByRole('link', { name: 'Customers & ledger' }).click();
  await page
    .locator('summary')
    .filter({ hasText: /^Add customer$/ })
    .click();
  await page.getByLabel('Name').fill('Edit Me Customer');
  await page.getByRole('button', { name: 'Create customer' }).click();
  await expect(page.getByText(/Customer owes ₹0.00/)).toBeVisible();
  await page
    .locator('summary')
    .filter({ hasText: /^Edit details$/ })
    .click();
  const editor = page.locator('form.party-editor');
  await editor.getByLabel('Phone').fill('98765 43210');
  await editor.getByLabel('Credit limit').fill('1500');
  await editor.getByRole('button', { name: 'Save details' }).click();
  await expect(page.getByText('Details of Edit Me Customer saved.').first()).toBeVisible();
  await page.reload();
  await page
    .getByRole('combobox', { name: /^Customer\b/ })
    .selectOption({ label: 'Edit Me Customer' });
  await page
    .locator('summary')
    .filter({ hasText: /^Edit details$/ })
    .click();
  await expect(page.locator('form.party-editor').getByLabel('Phone')).toHaveValue('98765 43210');
  await expect(page.locator('form.party-editor').getByLabel('Credit limit')).toHaveValue('1500.00');
});

test('a receipt whose answer is lost after commit is reconciled, never recorded twice', async ({
  page,
}) => {
  await createOwnerShop(page);
  await openAllScreens(page);
  await page.getByRole('link', { name: 'Customers & ledger' }).click();
  await page
    .locator('summary')
    .filter({ hasText: /^Add customer$/ })
    .click();
  await page.getByLabel('Name').fill('Receipt Customer');
  await page.getByRole('button', { name: 'Create customer' }).click();
  await expect(page.getByText(/Customer owes ₹0.00/)).toBeVisible();
  let calls = 0;
  await page.route('**/rpc/record_customer_payment_v2', async (route) => {
    if (calls++ === 0) {
      await route.fetch(); // the server commits ...
      await route.abort('connectionreset'); // ... but the answer is lost
    } else await route.continue();
  });
  await page.getByLabel('Amount ₹').fill('25');
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByRole('alert', { name: 'Unresolved receipts' })).toContainText('UNKNOWN');
  // A second receipt cannot be started while the first is unresolved.
  await expect(page.getByRole('button', { name: 'Record payment' })).toBeDisabled();
  const tasks = page.getByRole('navigation', { name: 'Customer tasks' });
  await tasks.getByRole('button', { name: 'Ledger', exact: true }).click();
  await expect(page.getByRole('alert', { name: 'Unresolved receipts' })).toContainText('UNKNOWN');
  await tasks.getByRole('button', { name: 'Receive payment', exact: true }).click();
  await page.getByRole('button', { name: 'Check status' }).click();
  await expect(page.getByText('Receipt confirmed by the server.')).toBeVisible();
  await expect(page.getByText(/Advance available ₹25.00/)).toBeVisible();
  expect(calls).toBe(1);
  // The confirmed receipt appears once in the verified statement (paged read + stored-balance check).
  await tasks.getByRole('button', { name: 'Ledger', exact: true }).click();
  const statement = page.getByLabel('Prepared customer statement');
  await expect(statement).toContainText('Closing −₹25.00');
  await expect(statement.getByRole('row').filter({ hasText: 'Payment received' })).toHaveCount(1);
});

test('global search finds a customer by name and says plainly when nothing matches', async ({
  page,
}) => {
  await createOwnerShop(page);
  await openAllScreens(page);
  await page.getByRole('link', { name: 'Customers & ledger' }).click();
  await page
    .locator('summary')
    .filter({ hasText: /^Add customer$/ })
    .click();
  await page.getByLabel('Name').fill('Searchable Customer');
  await page.getByRole('button', { name: 'Create customer' }).click();
  await expect(page.getByText(/Customer owes ₹0.00/)).toBeVisible();
  await page.goto('/');
  await page.getByRole('link', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Search', exact: true })).toBeVisible();
  await page.getByPlaceholder('Name, SKU, phone, bill no. or amount').fill('searchab');
  const group = page.getByLabel('Customers', { exact: true });
  await expect(group.getByRole('link', { name: 'Searchable Customer' })).toBeVisible();
  await page.getByPlaceholder('Name, SKU, phone, bill no. or amount').fill('zzzzqq');
  await expect(page.getByText('No matches.')).toBeVisible();
});
