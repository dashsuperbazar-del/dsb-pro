// backlog (0070): free-text sale line (owner/manager only, no stock, not returnable), the manager audit log with
// typed prices, and no false duplicate-bill warning for a bill voided elsewhere. Real POS and PostgREST.
import { test, expect, type Browser, type Page } from '@playwright/test';
import pg from 'pg';
import { addItemForm, fillBillItem, reviewPayment } from './design-helpers';

const PASSWORD = 'TestOnly-2026!pw';
// Test fixture only: reads what was stored, and voids a bill "from another device".
const DB_URL = process.env.E2E_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const email = () => `bl-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
const unique = (prefix: string) => `${prefix} ${Date.now()}${Math.floor(Math.random() * 1e4)}`;

async function sql<T = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    return (await client.query(text, values)).rows as T[];
  } finally {
    await client.end();
  }
}

async function signUp(page: Page, address = email()) {
  await page.getByLabel('Email').fill(address);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  return address;
}

async function createOwnerShop(page: Page) {
  await page.goto('/signup');
  const address = await signUp(page);
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Backlog Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/Overview/)).toBeVisible();
  return address;
}

async function joinAs(browser: Browser, owner: Page, role: 'cashier' | 'manager') {
  await owner.goto('/team');
  await owner
    .locator('form')
    .filter({ has: owner.getByRole('button', { name: 'Create invite' }) })
    .getByLabel('Role')
    .selectOption(role);
  await owner.getByRole('button', { name: 'Create invite' }).click();
  const link = await owner.getByTestId('invite-link').last().textContent();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(link!);
  await signUp(page);
  await expect(page.getByText(new RegExp(`Signed in · ${role}`, 'i'))).toBeVisible();
  return page;
}

test('owner sells an item that is not in the list: no stock, not returnable; the manager sees it in the audit log', async ({
  page,
  browser,
}) => {
  test.setTimeout(150000);
  await createOwnerShop(page);
  const name = unique('Gift wrap');
  await page.goto('/pos');
  await page.getByText('Add an item that is not in the list').click();
  const form = page.getByRole('form', { name: 'Other thing' });
  await form.getByLabel('Other thing name').fill(`  ${name}  `);
  await form.getByLabel('Other thing count').fill('2');
  await form.getByLabel('Other thing rate ₹').fill('50');
  await form.getByLabel('Other thing tax rate').selectOption({ label: '5%' });
  await form.getByRole('button', { name: 'Add to bill' }).click();
  const row = page.locator('#pos-cart tr').filter({ hasText: name });
  await expect(row).toContainText('Not in the item list · GST 5% · no stock');
  await expect(row).toContainText('₹100.00');
  await reviewPayment(page);
  await page.getByLabel('Amount ₹').first().fill('100');
  await page.getByRole('button', { name: 'Finalize sale' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Sale finalized' }).first(),
  ).toBeVisible();
  const [line] = await sql<{
    item_id: string | null;
    line_kind: string;
    price_source: string;
    tax_rate_bp_snapshot: number;
    line_total_paise: string;
    sale: string;
  }>(
    `select item_id,line_kind,price_source,tax_rate_bp_snapshot,line_total_paise,sale_invoice_id sale
       from sale_invoice_items where item_name_snapshot=$1`,
    [name],
  );
  expect(line).toMatchObject({
    item_id: null,
    line_kind: 'free_text',
    price_source: 'manual',
    tax_rate_bp_snapshot: 500,
    line_total_paise: '10000',
  });
  expect(await sql(`select 1 from stock_movements where source_id=$1`, [line!.sale])).toHaveLength(
    0,
  );

  // Returns: the line is shown as not returnable (or not offered at all), never with a quantity box.
  await page.goto('/returns');
  await expect(page.getByLabel('Source document').locator('option')).toHaveCount(2);
  await page.getByLabel('Source document').selectOption({ index: 1 });
  await expect(page.locator(`input:enabled[aria-label="Return quantity for ${name}"]`)).toHaveCount(
    0,
  );

  // A cashier has no free-text control; a manager reads the audit log with the typed line in it.
  const cashier = await joinAs(browser, page, 'cashier');
  await cashier.goto('/pos');
  await expect(cashier.getByText('Add an item that is not in the list')).toHaveCount(0);
  await cashier.goto('/more');
  await expect(cashier.getByRole('link', { name: 'Audit log' })).toHaveCount(0);
  const manager = await joinAs(browser, page, 'manager');
  await manager.goto('/more');
  await manager.getByRole('link', { name: 'Audit log' }).click();
  await expect(manager.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  await manager
    .getByLabel('Event type')
    .selectOption({ label: 'Typed sale prices (including items not in the list)' });
  await expect(
    manager.getByRole('row').filter({ hasText: `Item not in the list "${name}"` }),
  ).toContainText('2 × ₹50.00, GST 5%');
});

test('a bill voided on another device no longer raises the duplicate warning', async ({ page }) => {
  test.setTimeout(120000);
  const owner = await createOwnerShop(page);
  await page.goto('/inventory');
  await addItemForm(page);
  await page.getByPlaceholder('Item name').fill('Dup Dal');
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created Dup Dal' }).first(),
  ).toBeVisible();
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase', exact: true }) })
    .last();
  const supplier = page
    .getByRole('button', { name: 'Create & select supplier' })
    .locator('xpath=..');
  await page.goto('/purchases?new=1');
  await expect(purchase.locator('input[name="date"]')).not.toHaveValue('');
  await page.getByText('Add a supplier', { exact: true }).click();
  await supplier.getByPlaceholder('New supplier name').fill('Dup Void Supplier');
  await supplier.getByRole('button', { name: 'Create & select supplier' }).click();
  await expect(purchase.locator('select[name="partyId"]')).toHaveValue(/.+/);
  await purchase.locator('input[name="billNo"]').fill('DV-1');
  await fillBillItem(purchase, 1, 'Dup Dal', '2', '10');
  await purchase.getByRole('button', { name: 'Post purchase', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Purchase posted (1 item)' }).first(),
  ).toBeVisible();
  // This device lists the bill as posted (cached list) ...
  await page.goto('/purchases');
  await expect(page.getByRole('button', { name: /DV-1/ })).toBeVisible();
  // ... then another device voids it (the owner's own session, straight through void_purchase).
  const [bill] = await sql<{ id: string; user_id: string }>(
    `select b.id,u.id user_id from purchase_bills b join auth.users u on u.email=$1 where b.bill_no='DV-1'
      and b.tenant_id=(select tenant_id from tenant_users where user_id=u.id limit 1)`,
    [owner],
  );
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('request.jwt.claims',$1,true)`, [
      JSON.stringify({ sub: bill!.user_id, role: 'authenticated' }),
    ]);
    await client.query('set local role authenticated');
    await client.query(`select void_purchase($1::uuid,'e2e-other-device-void')`, [bill!.id]);
    await client.query('commit');
  } finally {
    await client.end();
  }

  // Same supplier and bill number again: no "Possible duplicate" question, the bill posts.
  await page.goto('/purchases?new=1');
  await expect(purchase.locator('input[name="date"]')).not.toHaveValue('');
  await expect(purchase.locator('select[name="partyId"]')).toHaveValue(/.+/);
  await purchase.locator('input[name="billNo"]').fill('DV-1');
  await fillBillItem(purchase, 1, 'Dup Dal', '2', '10');
  let asked = '';
  page.on('dialog', (d) => {
    asked = d.message();
    void d.accept();
  });
  await purchase.getByRole('button', { name: 'Post purchase', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Purchase posted (1 item)' }).first(),
  ).toBeVisible();
  expect(asked).toBe('');
});
