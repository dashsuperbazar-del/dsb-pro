import { stockTask, addItemForm, fillBillItem } from './design-helpers';
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'TestOnly-2026!pw';
function uniqueEmail() {
  return `keys-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}
async function createOwnerShop(page: Page) {
  await page.goto('/signup');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Keyboard Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/Overview/)).toBeVisible();
}
async function createItemWithStock(page: Page, name: string, price: string, qty: string) {
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
  await stockTask(page, 'Items');
  await page.getByLabel('Item details').selectOption({ label: name });
  const priceForm = page.getByRole('button', { name: 'Set price' }).locator('xpath=..');
  await priceForm.locator('input[name="price"]').fill(price);
  await page.getByRole('button', { name: 'Set price' }).click();
  await stockTask(page, 'Purchases');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase' }) });
  await fillBillItem(purchase, 1, name, qty, price);
  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  await expect(page.getByRole('status')).toContainText(
    'Purchase posted (1 item) and stock updated',
  );
}

test('POS is operable from the keyboard and no shortcut posts a sale by itself', async ({
  page,
}) => {
  test.setTimeout(90000);
  await createOwnerShop(page);
  await page.goto('/inventory');
  await createItemWithStock(page, 'Key Rice', '40', '20');
  await createItemWithStock(page, 'Key Rock Salt', '15', '20');

  await page.goto('/pos');
  await expect(page.getByText(/F2.*customer.*F3.*find/).first()).toBeVisible();
  const find = page.getByLabel('Find product');
  await find.fill('Key');
  await expect(page.locator('.pick-row')).toHaveCount(2);
  // Arrows move the highlighted row; Enter adds the highlighted row (else the top match), qty 1.
  await find.press('ArrowDown');
  await expect(page.locator('.pick-row.active')).toContainText('Key Rice');
  await find.press('ArrowDown');
  await expect(page.locator('.pick-row.active')).toContainText('Key Rock Salt');
  await find.press('ArrowUp');
  await expect(page.locator('.pick-row.active')).toContainText('Key Rice');
  await find.press('Enter');
  await expect(page.getByRole('cell', { name: /Key Rice/ })).toBeVisible();
  await expect(find).toBeFocused();
  // A second Enter is a second tap: the same line goes to 2, never a second line.
  await find.press('Enter');
  await expect(page.getByLabel('Cart qty for Key Rice')).toHaveValue('2');
  await expect(page.locator('#pos-cart tbody tr')).toHaveCount(1);
  // Enter with no highlight adds the top match.
  await find.fill('Key Ro');
  await find.press('Enter');
  await expect(page.locator('#pos-cart tbody tr')).toHaveCount(2);
  await expect(page.getByRole('cell', { name: /Key Rock Salt/ })).toBeVisible();
  // Nothing was posted by adding.
  await expect(page.getByRole('status').filter({ hasText: 'Sale finalized' })).toHaveCount(0);

  // Ctrl+Enter outside the payment view does nothing.
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('#pos-payment')).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Sale finalized' })).toHaveCount(0);

  // F4 opens payment, F2 focuses the customer, Esc leaves the field then the view, F3 returns to search.
  await page.keyboard.press('F4');
  await expect(page.locator('#pos-payment')).toBeVisible();
  await page.keyboard.press('F2');
  await expect(page.locator('#pos-payment select').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#pos-payment')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#pos-payment')).toBeHidden();
  await page.keyboard.press('F4');
  await page.keyboard.press('F3');
  await expect(find).toBeFocused();
  await expect(page.locator('#pos-payment')).toBeHidden();

  // The sale is posted only by Ctrl+Enter in the payment view, through the normal Finalize checks.
  await page.keyboard.press('F4');
  // Key Rice x2 (40 each) + Key Rock Salt x1 (15).
  await page.getByLabel('Amount ₹').first().fill('95');
  await page.getByLabel('Amount ₹').first().press('Control+Enter');
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: /Sale finalized/ })
      .first(),
  ).toBeVisible();
});

test('purchase entry: arrows pick a match, F2 adds an item, F4 only moves to Post', async ({
  page,
}) => {
  test.setTimeout(90000);
  await createOwnerShop(page);
  await page.goto('/inventory');
  await createItemWithStock(page, 'Buy Lentils', '30', '5');
  await createItemWithStock(page, 'Buy Lamp Oil', '90', '5');

  await stockTask(page, 'Purchases');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase' }) });
  await expect(purchase.getByText(/F2.*add.*item.*F4.*Post/).first()).toBeVisible();
  await purchase.getByRole('button', { name: '+ Add item', exact: true }).click();
  const name1 = purchase.getByLabel('Item 1 name', { exact: true });
  await name1.fill('Buy L');
  const matches = purchase.getByRole('group', { name: 'Matches for item 1', exact: true });
  await expect(matches.getByRole('button')).toHaveCount(3); // two items plus "Create"
  await name1.press('ArrowDown');
  await expect(matches.getByRole('button').first()).toBeFocused();
  await matches.getByRole('button').first().press('ArrowDown');
  await expect(matches.getByRole('button').nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Escape');
  await expect(name1).toBeFocused();
  await name1.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(purchase.getByLabel('Item 1 quantity', { exact: true })).toBeVisible();
  await purchase.getByLabel('Item 1 quantity', { exact: true }).fill('2');
  await purchase.getByLabel('Item 1 rate ₹', { exact: true }).fill('31');
  await purchase.getByLabel('Item 1 rate ₹', { exact: true }).press('Enter');
  await expect(purchase.getByLabel('Item 2 name', { exact: true })).toBeFocused();
  // F2 goes to an empty last row instead of stacking another empty one (row 2 is still empty) ...
  await page.keyboard.press('F2');
  await expect(purchase.getByRole('region', { name: /^Item \d+$/ })).toHaveCount(2);
  await expect(purchase.getByLabel('Item 2 name', { exact: true })).toBeFocused();
  // ... and adds a new row once the last one has something in it.
  await purchase.getByLabel('Item 2 name', { exact: true }).fill('x');
  await page.keyboard.press('F2');
  await expect(purchase.getByRole('region', { name: /^Item \d+$/ })).toHaveCount(3);
  await expect(purchase.getByLabel('Item 3 name', { exact: true })).toBeFocused();
  await purchase.getByLabel('Item 2 name', { exact: true }).fill('');
  // F4 moves focus to Post; the bill is not posted.
  await purchase.getByLabel('Item 2 name', { exact: true }).focus();
  await page.keyboard.press('F4');
  await expect(purchase.getByRole('button', { name: 'Post purchase' })).toBeFocused();
  // The entered bill is still on screen (a post would have cleared it).
  await expect(purchase.getByLabel('Item 1 quantity', { exact: true })).toHaveValue('2');
});
