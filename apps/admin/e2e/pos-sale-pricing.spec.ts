// salepricing (0065): typed sale prices, "save as sale price", cashier refusal, manager override,
// GST-extra invoice and the customer credit limit warning/override, through the real POS and PostgREST.
import { test, expect, type Browser, type Page } from '@playwright/test';
import pg from 'pg';
import {
  addCustomerForm,
  addItemForm,
  fillBillItem,
  reviewPayment,
  stockTask,
} from './design-helpers';

const PASSWORD = 'TestOnly-2026!pw';
// Test fixture only (item GST rate and a list price for a second item); the app itself never uses it.
const DB_URL = process.env.E2E_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const unique = (prefix: string) => `${prefix} ${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const email = () => `sp-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

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

async function signUp(page: Page) {
  await page.getByLabel('Email').fill(email());
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
}

async function createOwnerShop(page: Page) {
  await page.goto('/signup');
  await signUp(page);
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Pricing Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/Overview/)).toBeVisible();
}

/** Creates an item without a price and buys 20 of it. */
async function stockedItem(page: Page, name: string) {
  await page.goto('/inventory');
  await addItemForm(page);
  await page.getByPlaceholder('Item name').fill(name);
  await page
    .getByPlaceholder('SKU', { exact: true })
    .fill(`SP-${Date.now()}${Math.floor(Math.random() * 1e4)}`);
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: `Created ${name}` })
      .first(),
  ).toBeVisible();
  await stockTask(page, 'Purchases');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase' }) });
  await fillBillItem(purchase, 1, name, '20', '5');
  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  await expect(page.getByRole('status')).toContainText(
    'Purchase posted (1 item) and stock updated',
  );
}

async function addToCart(page: Page, name: string) {
  await page.getByLabel('Find product').fill(name);
  await expect(page.getByLabel('Item').locator('option')).toHaveCount(2);
  await page.getByLabel('Item').selectOption({ index: 1 });
  await page.getByLabel('Quantity').fill('1');
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
}

async function finalizePaid(page: Page, rupees: string) {
  await reviewPayment(page);
  await page.getByLabel('Amount ₹').first().fill(rupees);
  await page.getByRole('button', { name: 'Finalize sale' }).click();
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

test('owner prices an unpriced item and saves it, overrides a list price, and posts a GST-extra invoice', async ({
  page,
}) => {
  test.setTimeout(120000);
  await createOwnerShop(page);
  const name = unique('Loose Tea');
  await stockedItem(page, name);
  // Item GST % through the Inventory item form (set_item_tax_rate, owner/manager).
  await stockTask(page, 'Items');
  await page.getByLabel('Item details').selectOption({ label: name });
  await page.getByLabel('Item GST %').fill('18');
  await page.getByRole('button', { name: 'Save GST rate' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'GST rate saved: 18%' }).first(),
  ).toBeVisible();
  expect(await sql(`select tax_rate_bp from items where name=$1`, [name])).toEqual([
    { tax_rate_bp: 1800 },
  ]);

  await page.goto('/pos');
  await addToCart(page, name);
  const prompt = page.getByRole('form', { name: 'Enter a price' });
  await expect(prompt).toContainText(`${name} has no retail price for piece`);
  await prompt.getByLabel('Price for this sale ₹').fill('125');
  await prompt.getByLabel("Save as this item's sale price").check();
  await prompt.getByRole('button', { name: 'Use this price' }).click();
  const row = page.locator('#pos-cart tr').filter({ hasText: name });
  await expect(row).toContainText('₹125.00');
  await expect(row).toContainText('Typed price · no list price');
  await expect(page.getByText('1 item in bill')).toBeVisible();
  await finalizePaid(page, '125');
  await expect(
    page.getByRole('status').filter({ hasText: 'Sale finalized' }).first(),
  ).toContainText(`Saved as sale price: ${name}`);
  const [first] = await sql<{
    price_source: string;
    list_price_snapshot_paise: string | null;
    unit_price_paise: string;
  }>(
    `select sii.price_source,sii.list_price_snapshot_paise,sii.unit_price_paise from sale_invoice_items sii
      join items i on i.id=sii.item_id where i.name=$1 order by sii.created_at`,
    [name],
  );
  expect(first).toEqual({
    price_source: 'manual',
    list_price_snapshot_paise: null,
    unit_price_paise: '12500',
  });

  // The saved price is now the list price: no prompt, no "typed" mark.
  await addToCart(page, name);
  await expect(page.getByRole('form', { name: 'Enter a price' })).toHaveCount(0);
  await expect(row).toContainText('₹125.00');
  await expect(row).not.toContainText('Typed price');

  // Owner override of the list price, then GST added on top at the item's 18%.
  await row.getByRole('button', { name: 'Change price' }).click();
  await page.getByLabel(`Price for ${name}`).fill('100');
  await page.getByLabel(`Price for ${name}`).press('Tab');
  await expect(row).toContainText('Typed price · list ₹125.00');
  await page.getByLabel('Invoice type').selectOption('gst_extra');
  await expect(page.getByTestId('gst-extra-summary')).toContainText(
    'GST ₹18.00 (CGST ₹9.00 + SGST ₹9.00)',
  );
  await expect(page.locator('.pos-overview strong')).toHaveText('₹118.00');
  await finalizePaid(page, '118');
  await expect
    .poll(
      async () =>
        (
          await sql(
            `select 1 from sale_invoice_items sii join items i on i.id=sii.item_id where i.name=$1`,
            [name],
          )
        ).length,
    )
    .toBe(2);
  await expect(
    page.getByRole('status').filter({ hasText: 'Sale finalized' }).first(),
  ).toBeVisible();
  const [sale] = await sql<{
    invoice_type: string;
    tax_paise: string;
    total_paise: string;
    price_source: string;
    list: string;
  }>(
    `select si.invoice_type,si.tax_paise,si.total_paise,sii.price_source,sii.list_price_snapshot_paise list
      from sale_invoices si join sale_invoice_items sii on sii.sale_invoice_id=si.id join items i on i.id=sii.item_id
      where i.name=$1 order by si.created_at desc limit 1`,
    [name],
  );
  expect(sale).toEqual({
    invoice_type: 'gst_extra',
    tax_paise: '1800',
    total_paise: '11800',
    price_source: 'manual',
    list: '12500',
  });
});

test('a credit sale over the customer limit warns, is blocked, and posts with the owner override', async ({
  page,
}) => {
  test.setTimeout(120000);
  await createOwnerShop(page);
  const name = unique('Rice Bag');
  await stockedItem(page, name);
  const customer = unique('Limit Customer');
  await page.goto('/customers');
  await addCustomerForm(page);
  const form = page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'Create customer' }) });
  await form.getByLabel('Name').fill(customer);
  await form.getByLabel('Credit limit ₹ (blank = no limit)').fill('100');
  await form.getByRole('button', { name: 'Create customer' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: `Customer ${customer} created` }),
  ).toBeVisible();

  await page.goto('/pos');
  await addToCart(page, name);
  await page
    .getByRole('form', { name: 'Enter a price' })
    .getByLabel('Price for this sale ₹')
    .fill('150');
  await page.getByRole('button', { name: 'Use this price' }).click();
  // A GST-extra bill with a 0% item warns that no GST is added.
  await page.getByLabel('Invoice type').selectOption('gst_extra');
  await expect(page.getByTestId('gst-zero-warning')).toContainText(
    `GST 0%: ${name} has no GST rate`,
  );
  await page.getByLabel('Invoice type').selectOption('gst_included');
  await expect(page.getByTestId('gst-zero-warning')).toHaveCount(0);
  await reviewPayment(page);
  await page
    .locator('#pos-payment')
    .getByRole('combobox', { name: /^Customer/ })
    .selectOption({ label: customer });
  const warning = page.getByTestId('credit-limit-warning');
  await expect(warning).toContainText(
    `${customer} owes ₹0.00, this bill adds ₹150.00 on credit, limit ₹100.00`,
  );
  await page.getByRole('button', { name: 'Finalize sale' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: "over the customer's credit limit" }),
  ).toBeVisible();
  expect(
    await sql(
      `select 1 from sale_invoices si join customers c on c.id=si.customer_id where c.name=$1`,
      [customer],
    ),
  ).toHaveLength(0);
  await warning.getByLabel(/Allow this credit sale anyway/).check();
  await page.getByRole('button', { name: 'Finalize sale' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Sale finalized' }).first(),
  ).toBeVisible();
  const [row] = await sql<{ overridden: boolean; credit_limit: string }>(
    `select si.credit_override_by is not null overridden,si.credit_limit_snapshot_paise credit_limit from sale_invoices si
      join customers c on c.id=si.customer_id where c.name=$1`,
    [customer],
  );
  expect(row).toEqual({ overridden: true, credit_limit: '10000' });
});

test('a cashier cannot sell an unpriced item or change a price; a manager can override a price', async ({
  page,
  browser,
}) => {
  test.setTimeout(150000);
  await createOwnerShop(page);
  const unpriced = unique('No Price Soap');
  const priced = unique('Priced Biscuit');
  await stockedItem(page, unpriced);
  await stockedItem(page, priced);
  await sql(
    `insert into item_prices(tenant_id,item_id,shop_id,kind,unit_level,price_paise,effective_from,client_id,created_by)
      select i.tenant_id,i.id,null,'retail',1,9000,now()-interval '1 minute','e2e-price-'||i.id,i.created_by from items i where i.name=$1`,
    [priced],
  );

  const cashier = await joinAs(browser, page, 'cashier');
  await cashier.goto('/pos');
  await addToCart(cashier, unpriced);
  await expect(cashier.getByRole('alert')).toContainText(
    'Ask the owner or a manager to enter a price.',
  );
  await expect(cashier.getByRole('form', { name: 'Enter a price' })).toHaveCount(0);
  await addToCart(cashier, priced);
  await expect(cashier.locator('#pos-cart tr').filter({ hasText: priced })).toContainText('₹90.00');
  await expect(cashier.getByRole('button', { name: 'Change price' })).toHaveCount(0);

  const manager = await joinAs(browser, page, 'manager');
  await manager.goto('/pos');
  await addToCart(manager, priced);
  await manager
    .locator('#pos-cart tr')
    .filter({ hasText: priced })
    .getByRole('button', { name: 'Change price' })
    .click();
  await manager.getByLabel(`Price for ${priced}`).fill('80');
  await manager.getByLabel(`Price for ${priced}`).press('Tab');
  await expect(manager.locator('#pos-cart tr').filter({ hasText: priced })).toContainText(
    'Typed price · list ₹90.00',
  );
  await finalizePaid(manager, '80');
  await expect(
    manager.getByRole('status').filter({ hasText: 'Sale finalized' }).first(),
  ).toBeVisible();
  const [line] = await sql<{
    price_source: string;
    unit_price_paise: string;
    list: string;
    by_manager: boolean;
  }>(
    `select sii.price_source,sii.unit_price_paise,sii.list_price_snapshot_paise list,
       exists(select 1 from tenant_users tu where tu.user_id=sii.overridden_by and tu.role='manager') by_manager
     from sale_invoice_items sii join items i on i.id=sii.item_id where i.name=$1`,
    [priced],
  );
  expect(line).toEqual({
    price_source: 'manual',
    unit_price_paise: '8000',
    list: '9000',
    by_manager: true,
  });
});
