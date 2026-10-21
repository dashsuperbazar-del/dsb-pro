import {
  stockTask,
  addItemForm,
  fillBillItem,
  openBillDetails,
  openItemMore,
} from './design-helpers';
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

test('a bill card shows the unit conversion and sets a retail price that POS then uses', async ({
  page,
}) => {
  test.setTimeout(60000);
  await createOwnerShop(page);
  await page.goto('/inventory');
  await stockTask(page, 'Purchases');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase' }) });
  await purchase.getByLabel('Item 1 name', { exact: true }).fill('Card Biscuit');
  await purchase.getByRole('button', { name: '+ Create “Card Biscuit”' }).click();
  const form = purchase.getByRole('group', { name: 'New item for item 1' });
  await form.getByLabel('Item 1 big unit').fill('ctn');
  await form.getByLabel('Item 1 small unit', { exact: true }).fill('pcs');
  await form.getByLabel('Item 1 small units per big').fill('12');
  await form.getByRole('button', { name: 'Save item' }).click();
  await expect(form).toHaveCount(0);
  // Conversion and sale prices sit behind the row's "More" toggle.
  await expect(purchase.getByTestId('item-1-more')).toBeHidden();
  await openItemMore(purchase, 1);
  await expect(purchase.getByTestId('item-1-conversion')).toHaveText('1 ctn = 12 pcs');
  await purchase.getByLabel('Item 1 quantity', { exact: true }).fill('2');
  await purchase.getByLabel('Item 1 rate ₹', { exact: true }).fill('96');

  const sale = purchase.getByRole('group', { name: 'Item 1 sale prices' });
  // Opens on the smallest unit; nothing set yet.
  await expect(sale.getByRole('button', { name: 'pcs', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(sale.getByLabel('Item 1 retail ₹')).toHaveValue('');
  await sale.getByLabel('Item 1 retail ₹').fill('10');
  // ₹100 for 12 pcs is not whole paise per pcs: refused, nothing posted.
  await sale.getByLabel('Item 1 wholesale qty').fill('12');
  await sale.getByLabel('Item 1 wholesale price ₹').fill('100');
  await expect(sale).toContainText('is not a whole number of paise per pcs');
  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  await expect(purchase.locator('.bill-bar')).toContainText('Item 1: ₹100.00 for 12 pcs');
  await sale.getByLabel('Item 1 wholesale price ₹').fill('108');
  await expect(sale).toContainText('Wholesale ₹9.00 per pcs');
  await purchase.locator('input[name="billNo"]').fill('PRICE-1');
  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  await expect(page.getByRole('status')).toContainText(
    'Purchase posted (1 item) and stock updated. Sale prices updated: 2.',
  );

  // The next bill for the same item opens with the new prices.
  await purchase.getByLabel('Item 1 name', { exact: true }).fill('Card Biscuit');
  await purchase
    .getByRole('group', { name: 'Matches for item 1', exact: true })
    .getByRole('button', { name: 'Card Biscuit', exact: true })
    .click();
  await openItemMore(purchase, 1);
  await expect(sale.getByLabel('Item 1 retail ₹')).toHaveValue('10.00');
  await expect(sale.getByLabel('Item 1 wholesale price ₹')).toHaveValue('');
  await expect(sale).toContainText('Current wholesale ₹9.00 per pcs');

  // Leaving the started second bill: accept the unsaved-entry prompt (its draft is kept).
  page.on('dialog', (d) => void d.accept());
  await page.goto('/pos');
  await page.getByLabel('Find product').fill('Card Biscuit');
  await expect(page.getByLabel('Item').locator('option')).toHaveCount(2);
  await page.getByLabel('Item').selectOption({ index: 1 });
  await page.locator('select[name="unitLevel"]').selectOption('2');
  await page.getByLabel('Quantity').fill('3');
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  const row = page.locator('#pos-cart tr').filter({ hasText: 'Card Biscuit' });
  await expect(row).toContainText('₹10.00');
  await expect(row).toContainText('₹30.00');
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
  await page.route('**/rpc/post_purchase_v2', async (route) => {
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

test('a cash bill with item discount/GST and a named charge posts with its round-off, paid in full, and the supplier ledger is settled', async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 844 });
  await createOwnerShop(page);
  await page.goto('/inventory');
  await createItem(page, 'Cash Oil');
  await page.goto('/purchases?new=1');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase', exact: true }) })
    .last();
  await expect(purchase.locator('input[name="date"]')).not.toHaveValue('');
  const supplier = page
    .getByRole('button', { name: 'Create & select supplier' })
    .locator('xpath=..');
  await page.getByText('Add a supplier', { exact: true }).click();
  await supplier.getByPlaceholder('New supplier name').fill('Counter Supplier');
  await supplier.getByRole('button', { name: 'Create & select supplier' }).click();
  await expect(purchase.locator('select[name="partyId"]')).toHaveValue(/.+/);
  await purchase.locator('input[name="billNo"]').fill('CASH-1');
  // 3 x 33.53 = 100.59, 2% off = 98.5782, +5% GST = 103.50711 -> ₹103.51 (core = server line total).
  await fillBillItem(purchase, 1, 'Cash Oil', '3', '33.53');
  // Discount and GST are behind the row's "More"; Bill details (charges, notes) start closed.
  await expect(purchase.getByLabel('Item 1 discount %', { exact: true })).toBeHidden();
  await expect(purchase.locator('textarea[name="notes"]')).toBeHidden();
  await openItemMore(purchase, 1);
  await purchase.getByLabel('Item 1 discount %', { exact: true }).fill('2');
  await expect(purchase.getByTestId('item-1-gst-hint')).toHaveText(
    'GST blank: the rate already includes GST. Nothing is added.',
  );
  await purchase.getByLabel('Item 1 GST %', { exact: true }).fill('5');
  await expect(purchase.getByTestId('item-1-gst-hint')).toHaveText(
    '5% GST added on top of the rate.',
  );
  await expect(purchase.getByTestId('item-1-amount')).toContainText('Item total ₹103.51');
  // Closed again, the row keeps the values and names them.
  await purchase.getByRole('button', { name: 'More for item 1', exact: true }).click();
  await expect(purchase.getByLabel('Item 1 discount %', { exact: true })).toBeHidden();
  await expect(purchase.getByTestId('item-1-badge')).toHaveText('−2% +5% GST');
  await openBillDetails(purchase);
  await purchase.getByRole('button', { name: '+ Add charge', exact: true }).click();
  await purchase.getByLabel('Extra charge 1 name', { exact: true }).fill('Transport');
  await purchase.getByLabel('Extra charge 1 amount ₹', { exact: true }).fill('10');
  await purchase.locator('textarea[name="notes"]').fill('Paid at the counter');
  await purchase.locator('.bill-details-toggle').click();
  await expect(purchase.getByTestId('bill-details-badge')).toHaveText('1 charge ₹10.00 · notes');
  await purchase
    .locator('.bill-bar')
    .getByRole('group', { name: 'Payment type', exact: true })
    .getByRole('button', { name: 'Cash', exact: true })
    .click();
  const totals = purchase.getByTestId('bill-total');
  await expect(totals).toContainText('Total before round off₹113.51');
  await expect(purchase.getByTestId('round-off')).toHaveText('Round off+₹0.49');
  await expect(totals).toContainText('Bill total₹114.00');
  await expect(purchase.getByTestId('paid-now')).toContainText('Paid in full ₹114.00 now by Cash');
  const post = purchase.getByRole('button', { name: 'Post and pay ₹114.00 by Cash', exact: true });
  await expect(post).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const shots = process.env.BILL_V2_SHOTS;
  await purchase.getByRole('region', { name: 'Item 1', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: shots ? `${shots}/bill-v2-item.png` : testInfo.outputPath('bill-v2-item.png'),
  });
  await totals.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: shots ? `${shots}/bill-v2-totals.png` : testInfo.outputPath('bill-v2-totals.png'),
  });
  await page.screenshot({
    path: shots ? `${shots}/bill-v2-full.png` : testInfo.outputPath('bill-v2-full.png'),
    fullPage: true,
  });
  await post.click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Purchase posted (1 item)' }).first(),
  ).toContainText('Paid in full ₹114.00 by Cash.');

  await page.getByRole('link', { name: 'Bill list', exact: true }).click();
  await page.getByRole('button', { name: /Counter Supplier.*CASH-1/ }).click();
  const detail = page.getByLabel('Purchase detail');
  await expect(detail.getByTestId('settlement-badge')).toHaveText('Settled');
  await expect(detail).toContainText('₹114.00 · Cash bill');
  await expect(detail).toContainText('Round off +₹0.49');
  await expect(detail).toContainText('Notes: Paid at the counter');
  await expect(detail).toContainText('Extra charges: Transport ₹10.00');
  await expect(detail).toContainText('− 2% discount + 5% GST');
  await expect(detail.getByRole('button', { name: 'Void bill and its payment' })).toBeVisible();
  await detail.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: shots ? `${shots}/bill-v2-detail.png` : testInfo.outputPath('bill-v2-detail.png'),
  });

  await detail.getByRole('link', { name: 'Supplier ledger', exact: true }).click();
  const ledger = page.locator('.supplier-ledger');
  await expect(ledger).toContainText('CASH-1');
  await expect(ledger).toContainText('Closing: ₹0.00');
  // The bill (+₹114.00) and its automatic cash payment (−₹114.00, linked to the bill) net to zero.
  const payment = ledger
    .locator('tr')
    .filter({ hasText: 'Paid with purchase bill CASH-1' })
    .first();
  await expect(payment.locator('td[data-label="Change"]')).toHaveText('−₹114.00');
  const billRow = ledger
    .locator('tr')
    .filter({ has: page.locator('td[data-label="Entry"]', { hasText: /^Purchase$/ }) })
    .filter({ hasText: 'CASH-1' })
    .first();
  await expect(billRow.locator('td[data-label="Change"]')).toHaveText('₹114.00');
});

test('returning a whole rounded bill shows the return round off in Returns and the supplier ledger', async ({
  page,
}) => {
  test.setTimeout(90000);
  await createOwnerShop(page);
  await page.goto('/inventory');
  await createItem(page, 'Round Rice');
  await page.goto('/purchases?new=1');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase', exact: true }) })
    .last();
  await expect(purchase.locator('input[name="date"]')).not.toHaveValue('');
  const supplier = page
    .getByRole('button', { name: 'Create & select supplier' })
    .locator('xpath=..');
  await page.getByText('Add a supplier', { exact: true }).click();
  await supplier.getByPlaceholder('New supplier name').fill('Round Supplier');
  await supplier.getByRole('button', { name: 'Create & select supplier' }).click();
  await expect(purchase.locator('select[name="partyId"]')).toHaveValue(/.+/);
  await purchase.locator('input[name="billNo"]').fill('RO-1');
  // ₹100.49 of items, rounded down to a ₹100.00 bill (round off −₹0.49).
  await fillBillItem(purchase, 1, 'Round Rice', '1', '100.49');
  await expect(purchase.getByTestId('round-off')).toHaveText('Round off−₹0.49');
  await purchase.getByRole('button', { name: 'Post purchase', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Purchase posted (1 item)' }).first(),
  ).toBeVisible();

  // Straight to the supplier return, before any later sync cycle: the device's stock copy may not have
  // the purchase yet (the sync pull skips rows changed in the last second), so the return must refresh it
  // itself instead of refusing "Insufficient cached stock".
  const posted = page.getByRole('status').filter({ hasText: 'Purchase return posted' }).first();
  await page.goto('/returns');
  await expect(page.getByRole('heading', { name: 'Returns', exact: true })).toBeVisible();
  await page.getByLabel('Return type').selectOption('PURCHASE');
  const source = page.getByLabel('Source document');
  await expect(source.locator('option', { hasText: 'RO-1' })).toHaveCount(1);
  await source.selectOption({
    label: (await source.locator('option', { hasText: 'RO-1' }).textContent())!,
  });
  await page.getByLabel('Return quantity for Round Rice').fill('1');
  await page.getByRole('button', { name: 'Post return' }).click();
  await expect(posted.or(page.getByRole('alert'))).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(posted).toBeVisible();
  // The return that completes the bill takes back exactly ₹100.00: ₹100.49 of items, round off −₹0.49.
  const recent = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Recent returns' }) })
    .locator('tbody tr')
    .filter({ hasText: 'PURCHASE' })
    .first();
  await expect(recent).toContainText('₹100.00');
  await expect(recent).toContainText('Round off −₹0.49');

  await page.goto('/purchases');
  await page.getByRole('button', { name: /Round Supplier.*RO-1/ }).click();
  await page
    .getByLabel('Purchase detail')
    .getByRole('link', { name: 'Supplier ledger', exact: true })
    .click();
  const ledger = page.locator('.supplier-ledger');
  await expect(ledger).toContainText('Closing: ₹0.00');
  const returnRow = ledger
    .locator('tr')
    .filter({ has: page.locator('td[data-label="Entry"]', { hasText: 'Purchase return' }) })
    .first();
  await expect(returnRow.locator('td[data-label="Change"]')).toHaveText('−₹100.00');
  await expect(returnRow.locator('td[data-label="Document"]')).toContainText(
    'Round off −₹0.49 (included)',
  );
});

test('fast bill: the supplier is remembered, its usual items are added in one go with empty quantities, Enter moves row to row', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 844 });
  await createOwnerShop(page);
  await page.goto('/inventory');
  for (const name of ['Usual Sugar', 'Usual Tea', 'Usual Salt']) await createItem(page, name);
  await page.goto('/purchases?new=1');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase', exact: true }) })
    .last();
  await expect(purchase.locator('input[name="date"]')).not.toHaveValue('');
  await expect(purchase.locator('fieldset').first()).toBeEnabled();
  await page.getByText('Add a supplier', { exact: true }).click();
  const supplier = page
    .getByRole('button', { name: 'Create & select supplier' })
    .locator('xpath=..');
  await supplier.getByPlaceholder('New supplier name').fill('Usual Traders');
  await supplier.getByRole('button', { name: 'Create & select supplier' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Created supplier' })).toBeVisible();
  // Keyboard only: name, Enter (the only match), qty, Enter, rate, Enter (the next row) …
  const post = purchase.getByRole('button', { name: 'Post purchase', exact: true });
  async function typeBill(rows: [string, string, string][]) {
    await purchase.getByLabel('Item 1 name', { exact: true }).click();
    for (const [i, [name, qty, rate]] of rows.entries()) {
      await expect(purchase.getByLabel(`Item ${i + 1} name`, { exact: true })).toBeFocused();
      await page.keyboard.type(name);
      await page.keyboard.press('Enter');
      await expect(purchase.getByLabel(`Item ${i + 1} quantity`, { exact: true })).toBeFocused();
      await page.keyboard.type(qty);
      await page.keyboard.press('Enter');
      await page.keyboard.type(rate);
      if (i < rows.length - 1) await page.keyboard.press('Enter');
    }
  }
  const posted = page.getByRole('status').filter({ hasText: 'Purchase posted (2 items)' });
  await typeBill([
    ['Usual Sugar', '10', '42'],
    ['Usual Tea', '5', '120'],
  ]);
  await expect(purchase.getByRole('region', { name: /^Item \d+$/ })).toHaveCount(2);
  await post.click();
  await expect(posted).toBeVisible();
  await expect(purchase.getByLabel('Item 1 name', { exact: true })).toHaveValue('');
  // The next bill starts with the same supplier.
  await expect(purchase.locator('select[name="partyId"] option:checked')).toHaveText(
    'Usual Traders',
  );
  await typeBill([
    ['Usual Sugar', '4', '43'],
    ['Usual Salt', '20', '18'],
  ]);
  await post.click();
  await expect(posted).toBeVisible();
  await expect(purchase.getByLabel('Item 1 name', { exact: true })).toHaveValue('');

  // A new bill: the usual items (read through PostgREST) list each item once, most bought first.
  await page.goto('/purchases?new=1');
  await expect(purchase.locator('select[name="partyId"] option:checked')).toHaveText(
    'Usual Traders',
  );
  const usual = purchase.getByRole('group', { name: 'Usual items', exact: true });
  await expect(usual.locator('.usual-name')).toHaveText(['Usual Sugar', 'Usual Salt', 'Usual Tea']);
  await expect(usual.locator('.usual-row').first()).toContainText('piece · ₹43.00');
  await usual.getByLabel('Usual Sugar', { exact: true }).click();
  await usual.getByLabel('Usual Tea', { exact: true }).click();
  await usual.getByRole('button', { name: 'Add 2 items', exact: true }).click();
  await expect(purchase.getByRole('region', { name: /^Item \d+$/ })).toHaveCount(2);
  const qty1 = purchase.getByLabel('Item 1 quantity', { exact: true });
  await expect(qty1).toBeFocused();
  await expect(qty1).toHaveValue('');
  await expect(purchase.getByLabel('Item 1 rate ₹', { exact: true })).toHaveValue('43.00');
  await expect(purchase.getByTestId('item-1-suggested')).toContainText('Last rate');
  await page.keyboard.type('6');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(purchase.getByLabel('Item 2 quantity', { exact: true })).toBeFocused();
  await page.keyboard.type('2');
  await expect(purchase.getByTestId('bill-total')).toContainText('Bill total₹498.00');
  // Bill details stay closed with nothing set in them.
  await expect(purchase.getByTestId('bill-details-badge')).toHaveText(
    'discount, charges, notes, photos',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await post.click();
  await expect(posted).toBeVisible();
  await expect(purchase.getByLabel('Item 1 name', { exact: true })).toHaveValue('');
});

test('voiding a credit bill needs a reason, reverses its stock and supplier balance, and the list shows Unpaid/Void', async ({
  page,
}) => {
  test.setTimeout(90000);
  await createOwnerShop(page);
  await page.goto('/inventory');
  await createItem(page, 'Void Rice');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase', exact: true }) })
    .last();
  const supplier = page
    .getByRole('button', { name: 'Create & select supplier' })
    .locator('xpath=..');
  for (const [no, qty] of [
    ['VOID-1', '5'],
    ['KEEP-1', '3'],
  ] as const) {
    await page.goto('/purchases?new=1');
    await expect(purchase.locator('input[name="date"]')).not.toHaveValue('');
    if (no === 'VOID-1') {
      await page.getByText('Add a supplier', { exact: true }).click();
      await supplier.getByPlaceholder('New supplier name').fill('Void Supplier');
      await supplier.getByRole('button', { name: 'Create & select supplier' }).click();
    }
    await expect(purchase.locator('select[name="partyId"]')).toHaveValue(/.+/);
    await purchase.locator('input[name="billNo"]').fill(no);
    await fillBillItem(purchase, 1, 'Void Rice', qty, '10');
    await purchase.getByRole('button', { name: 'Post purchase', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Purchase posted (1 item)' }).first(),
    ).toBeVisible();
  }

  await page.getByRole('link', { name: 'Bill list', exact: true }).click();
  await page.getByRole('button', { name: /Void Supplier.*VOID-1/ }).click();
  const detail = page.getByLabel('Purchase detail');
  const voidButton = detail.getByRole('button', { name: 'Void bill', exact: true });
  await expect(voidButton).toBeDisabled();
  await detail.getByLabel('Reason for voiding').fill('entered twice');
  page.once('dialog', (d) => {
    expect(d.message()).toMatch(/stock comes off.*supplier balance/i);
    void d.accept();
  });
  await voidButton.click();
  await expect(detail).toContainText('Bill voided. Stock and supplier balance reversed.');
  await expect(detail.getByTestId('void-reason')).toHaveText('Void reason: entered twice');
  await expect(page.getByTestId('list-settlement')).toHaveText(['Unpaid', 'Void']);

  await page.goto('/purchases');
  await page.getByRole('button', { name: /Void Supplier.*KEEP-1/ }).click();
  await detail.getByRole('link', { name: 'Supplier ledger', exact: true }).click();
  await expect(page.locator('.supplier-ledger')).toContainText('Closing: ₹30.00');
  await page.goto('/inventory');
  await stockTask(page, 'Items');
  await page.getByLabel('Item details').selectOption({ label: 'Void Rice' });
  await expect(page.getByLabel('item peek')).toContainText('Stock 3 piece');
});

test('a repeated supplier bill number asks before posting, and global search opens the bill', async ({
  page,
}) => {
  test.setTimeout(90000);
  await createOwnerShop(page);
  await page.goto('/inventory');
  await createItem(page, 'Dup Sugar');
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
  await supplier.getByPlaceholder('New supplier name').fill('Dup Supplier');
  await supplier.getByRole('button', { name: 'Create & select supplier' }).click();
  await expect(purchase.locator('select[name="partyId"]')).toHaveValue(/.+/);
  await purchase.locator('input[name="billNo"]').fill('DUP-7');
  await fillBillItem(purchase, 1, 'Dup Sugar', '2', '10');
  await purchase.getByRole('button', { name: 'Post purchase', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Purchase posted (1 item)' }).first(),
  ).toBeVisible();

  // Same supplier + same bill number: a confirm; Cancel posts nothing.
  await page.goto('/purchases?new=1');
  await expect(purchase.locator('input[name="date"]')).not.toHaveValue('');
  await expect(purchase.locator('select[name="partyId"]')).toHaveValue(/.+/);
  await purchase.locator('input[name="billNo"]').fill('dup-7');
  await fillBillItem(purchase, 1, 'Dup Sugar', '1', '10');
  let message = '';
  page.once('dialog', (d) => {
    message = d.message();
    void d.dismiss();
  });
  await purchase.getByRole('button', { name: 'Post purchase', exact: true }).click();
  await expect.poll(() => message).toMatch(/^Possible duplicate of bill #DUP-7 dated .*₹20\.00/);
  await expect(page.getByRole('status').filter({ hasText: 'Purchase posted' })).toHaveCount(0);

  await page.goto('/search');
  await page.getByPlaceholder('Name, SKU, phone, bill no. or amount').fill('DUP-7');
  const bills = page.getByLabel('Purchase bills', { exact: true });
  await expect(bills).toContainText('Dup Supplier');
  await bills.getByRole('link', { name: 'DUP-7' }).click();
  await expect(page.getByLabel('Purchase detail')).toContainText('Dup Sugar');
  await expect(page.getByRole('button', { name: 'Share as image' })).toBeVisible();
});
