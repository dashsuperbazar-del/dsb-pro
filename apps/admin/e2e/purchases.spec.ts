import { stockTask, addItemForm, fillBillItem } from './design-helpers';
import { test, expect } from '@playwright/test';

const PASSWORD = 'TestOnly-2026!pw';
function uniqueEmail() {
  return `purchases-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}
async function createOwnerShop(page: import('@playwright/test').Page) {
  await page.goto('/signup');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Multi-line Purchase Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/Overview/)).toBeVisible();
}
async function createItem(page: import('@playwright/test').Page, name: string) {
  await addItemForm(page);
  await page.getByPlaceholder('Item name').fill(name);
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: `Created ${name}` })
      .first(),
  ).toBeVisible();
}

test('a single supplier bill carries several items, each an editable card', async ({ page }) => {
  await createOwnerShop(page);
  await page.goto('/inventory');
  await createItem(page, 'Bill Item A');
  await createItem(page, 'Bill Item B');

  await stockTask(page, 'Purchases');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase' }) });
  const cards = purchase.getByRole('region', { name: /^Item \d+$/ });
  const total = purchase.getByTestId('bill-total');
  await expect(purchase.getByRole('button', { name: 'Post purchase' })).toBeDisabled();
  await expect(cards).toHaveCount(1);

  await fillBillItem(purchase, 1, 'Bill Item A', '4', '10');
  await fillBillItem(purchase, 2, 'Bill Item B', '6', '5');
  await expect(cards).toHaveCount(2);
  await expect(purchase.getByTestId('item-2-amount')).toHaveText('Amount ₹30.00');
  await expect(total).toContainText('₹70.00');

  // An item can be dropped before posting without disturbing the other item's amount.
  page.once('dialog', (d) => void d.accept());
  await purchase.getByRole('button', { name: 'Remove item 1', exact: true }).click();
  await expect(cards).toHaveCount(1);
  await expect(purchase.getByLabel('Item 1 name', { exact: true })).toHaveValue('Bill Item B');
  await expect(total).toContainText('₹30.00');

  // Add the first item again so the posted bill genuinely carries both items.
  await fillBillItem(purchase, 2, 'Bill Item A', '4', '10');
  await expect(total).toContainText('₹70.00');
  await expect(purchase.locator('.bill-bar')).toContainText('Total ₹70.00');

  await purchase.locator('input[name="billNo"]').fill('MULTI-1');
  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  await expect(page.getByRole('status')).toContainText(
    'Purchase posted (2 items) and stock updated',
  );
  await expect(cards).toHaveCount(1);
  await expect(purchase.getByLabel('Item 1 name', { exact: true })).toHaveValue('');

  await stockTask(page, 'Items');
  await page.getByLabel('Item details').selectOption({ label: 'Bill Item A' });
  await expect(page.getByLabel('item peek')).toContainText('Stock 4 piece');
  await stockTask(page, 'Items');
  await page.getByLabel('Item details').selectOption({ label: 'Bill Item B' });
  await expect(page.getByLabel('item peek')).toContainText('Stock 6 piece');
});

test('a new item is created inside a bill card, chosen there, findable in other cards, then posted', async ({
  page,
}) => {
  await createOwnerShop(page);
  await page.goto('/inventory');
  await createItem(page, 'Card Known Item');

  await stockTask(page, 'Purchases');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase' }) });
  const card = (n: number) => purchase.getByRole('region', { name: `Item ${n}`, exact: true });

  await purchase.getByLabel('Item 1 name', { exact: true }).fill('Card New Rice');
  // Nothing is created by typing: the started card blocks posting until the item exists.
  await purchase.getByRole('button', { name: '+ Create “Card New Rice”' }).click();
  const form = card(1).getByRole('group', { name: 'New item for item 1' });
  await expect(form.getByLabel('Item 1 new item name')).toHaveValue('Card New Rice');
  await form.getByLabel('Item 1 big unit').fill('bag');
  await form.getByLabel('Item 1 small unit', { exact: true }).fill('pkt');
  await form.getByLabel('Item 1 small units per big').fill('10');
  await form.getByRole('button', { name: 'Save item' }).click();
  await expect(form).toHaveCount(0);
  const units = card(1).getByRole('group', { name: 'Item 1 purchased in' });
  await expect(units.getByRole('button', { name: 'bag', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(purchase.getByLabel('Item 1 quantity', { exact: true })).toHaveValue('');
  await expect(purchase.getByLabel('Item 1 rate ₹', { exact: true })).toHaveValue('');
  await units.getByRole('button', { name: 'pkt', exact: true }).click();
  await purchase.getByLabel('Item 1 quantity', { exact: true }).fill('5');
  await purchase.getByLabel('Item 1 rate ₹', { exact: true }).fill('12');
  await expect(purchase.getByTestId('item-1-amount')).toHaveText('Amount ₹60.00');

  // Another card finds the new item by search, and an existing name offers no create.
  await fillBillItem(purchase, 2, 'Card New Rice', '1', '100');
  await expect(purchase.getByRole('button', { name: /^\+ Create/ })).toHaveCount(0);
  await expect(purchase.getByTestId('bill-total')).toContainText('₹160.00');

  await purchase.locator('input[name="billNo"]').fill('CARD-NEW-1');
  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  await expect(page.getByRole('status')).toContainText(
    'Purchase posted (2 items) and stock updated',
  );
  // 5 pkt + 1 bag of 10 pkt = 15 pkt in stock.
  await stockTask(page, 'Items');
  await page.getByLabel('Item details').selectOption({ label: 'Card New Rice' });
  await expect(page.getByLabel('item peek')).toContainText('15 pkt');
});

test('a card-created three-unit item posted in its second unit is stocked in the smallest unit', async ({
  page,
}) => {
  await createOwnerShop(page);
  await page.goto('/inventory');
  await stockTask(page, 'Purchases');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase' }) });
  await purchase.getByLabel('Item 1 name', { exact: true }).fill('Card Soap');
  await purchase.getByRole('button', { name: '+ Create “Card Soap”' }).click();
  const form = purchase.getByRole('group', { name: 'New item for item 1' });
  // Level 1 is the BIG unit, as on the Add item form.
  await expect(form).toContainText('Big unit (e.g. case)');
  await form.getByLabel('Item 1 big unit').fill('ctn');
  await form.getByLabel('Item 1 small unit', { exact: true }).fill('box');
  await form.getByLabel('Item 1 small units per big').fill('12');
  await form.getByLabel('Item 1 piece unit').fill('pc');
  await form.getByLabel('Item 1 pieces per small').fill('10');
  await form.getByRole('button', { name: 'Save item' }).click();
  await expect(form).toHaveCount(0);
  await purchase
    .getByRole('group', { name: 'Item 1 purchased in' })
    .getByRole('button', { name: 'box', exact: true })
    .click();
  await purchase.getByLabel('Item 1 quantity', { exact: true }).fill('3');
  await purchase.getByLabel('Item 1 rate ₹', { exact: true }).fill('50');
  await expect(purchase.getByTestId('item-1-amount')).toHaveText('Amount ₹150.00');
  await purchase.locator('input[name="billNo"]').fill('CARD-SOAP-1');
  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  await expect(page.getByRole('status')).toContainText('Purchase posted (1 item)');
  // 3 box × 10 pc = 30 pc, held in the smallest unit.
  await stockTask(page, 'Items');
  await page.getByLabel('Item details').selectOption({ label: 'Card Soap' });
  await expect(page.getByLabel('item peek')).toContainText('30 pc');
});

test('a purchase whose answer is lost is retried as the same bill, never posted twice', async ({
  page,
}) => {
  await createOwnerShop(page);
  await page.goto('/inventory');
  await createItem(page, 'Retry Item');
  await stockTask(page, 'Purchases');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase' }) });
  await fillBillItem(purchase, 1, 'Retry Item', '3', '10');
  let calls = 0;
  await page.route('**/rpc/post_purchase', async (route) => {
    if (calls++ === 0) {
      await route.fetch(); // committed on the server ...
      await route.abort('connectionreset'); // ... answer lost
    } else await route.continue();
  });
  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  await expect(purchase.getByRole('alert')).toContainText('may already be saved');
  await expect(purchase.getByLabel('Item 1 quantity', { exact: true })).toBeDisabled();
  // A reload keeps the frozen request: the screen still offers only the safe retry.
  await page.reload();
  await expect(purchase.getByRole('button', { name: 'Retry same purchase' })).toBeVisible();
  await purchase.getByRole('button', { name: 'Retry same purchase' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Purchase posted (1 item)' }).first(),
  ).toBeVisible();
  await stockTask(page, 'Items');
  await page.getByLabel('Item details').selectOption({ label: 'Retry Item' });
  await expect(page.getByLabel('item peek')).toContainText('Stock 3 piece');
  expect(calls).toBe(2);
});

test('an item cost can be entered as its total; an inexact total is shown, never silently rounded', async ({
  page,
}) => {
  await createOwnerShop(page);
  await page.goto('/inventory');
  await createItem(page, 'Total Cost Item A');
  await createItem(page, 'Total Cost Item B');

  await stockTask(page, 'Purchases');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase' }) });
  const card = (n: number) => purchase.getByRole('region', { name: `Item ${n}`, exact: true });
  const total = purchase.getByTestId('bill-total');

  // Exact: Rs 100.00 for 4 pieces is Rs 25.00 each.
  await fillBillItem(purchase, 1, 'Total Cost Item A', '4', '100', { total: true });
  await expect(card(1).getByTestId('cost-derivation')).toContainText('₹25.00 per unit');
  await expect(purchase.getByTestId('item-1-amount')).toHaveText('Amount ₹100.00');
  await expect(total).toContainText('₹100.00');

  // Inexact: Rs 100.00 for 3 pieces cannot be stored; the app says by how much and waits for a choice.
  await fillBillItem(purchase, 2, 'Total Cost Item B', '3', '100', { total: true });
  await expect(card(2).getByTestId('cost-derivation')).toContainText('₹0.01 less');
  await expect(purchase.getByTestId('item-2-amount')).toHaveText('');
  await expect(total).toContainText('Items (1)');
  await card(2)
    .getByRole('button', { name: /Use ₹33\.33 per unit/ })
    .click();
  await expect(purchase.getByLabel('Item 2 rate ₹', { exact: true })).toHaveValue('33.33');
  await expect(purchase.getByTestId('item-2-amount')).toHaveText('Amount ₹99.99');
  await expect(total).toContainText('₹199.99');
});

test('batch entry saves several single-line bills as drafts; nothing posts until a draft is resumed and posted', async ({
  page,
}) => {
  await createOwnerShop(page);
  await page.goto('/inventory');
  await stockTask(page, 'Suppliers');
  await page.getByPlaceholder('Supplier name').fill('Batch Supplier');
  await page.getByRole('button', { name: 'Create supplier' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created supplier Batch Supplier' }).first(),
  ).toBeVisible();
  await createItem(page, 'Batch Item A');
  await createItem(page, 'Batch Item B');
  await page.goto('/purchases?new=1');

  await page.getByText('Batch entry (save several bills as drafts)').click();
  const batch = page.getByLabel('Batch bill entry');
  await batch.getByLabel('Batch supplier 1').selectOption({ label: 'Batch Supplier' });
  await batch.getByLabel('Batch bill number 1').fill('BATCH-1');
  await batch.getByLabel('Batch item 1').selectOption({ label: 'Batch Item A' });
  await batch.getByLabel('Batch quantity 1').fill('4');
  await batch.getByLabel('Batch cost 1').fill('25');
  await batch.getByRole('button', { name: 'Add another bill' }).click();
  await batch.getByLabel('Batch bill number 2').fill('BATCH-2');
  await batch.getByLabel('Batch item 2').selectOption({ label: 'Batch Item B' });
  await batch.getByLabel('Batch quantity 2').fill('2');
  await batch.getByLabel('Batch cost mode 2').selectOption('total');
  await batch.getByLabel('Batch cost 2').fill('50');

  // A bad row saves nothing and names the row.
  await batch.getByLabel('Batch quantity 2').fill('0');
  await batch.getByRole('button', { name: 'Save 2 drafts' }).click();
  await expect(batch.getByRole('alert')).toContainText('Bill 2');
  await batch.getByLabel('Batch quantity 2').fill('2');

  await batch.getByRole('button', { name: 'Save 2 drafts' }).click();
  await expect(batch).toContainText('Saved 2 drafts. Nothing is posted yet');

  // The drafts are listed; resuming one and posting it goes through the normal purchase path.
  await page.getByText('Saved purchase drafts', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume draft', exact: true })).toHaveCount(2);
  // Switching from a touched form asks for confirmation; accept it like a user would.
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Resume draft', exact: true }).first().click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Saved purchase draft restored' }).first(),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Post purchase' }).click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: /Purchase posted/ })
      .first(),
  ).toBeVisible();
});
