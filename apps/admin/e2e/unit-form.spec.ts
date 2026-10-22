import { test, expect, type Page } from '@playwright/test';
import { addItemForm, fillBillItem, stockTask } from './design-helpers';

const PASSWORD = 'TestOnly-2026!pw';

async function createOwnerShop(page: Page) {
  await page.goto('/signup');
  await page
    .getByLabel('Email')
    .fill(`unit-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Unit Form Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/Overview/)).toBeVisible();
}

async function peek(page: Page, name: string) {
  await page.getByLabel('Item details').selectOption({ label: name });
  return page.getByLabel('item peek');
}

test('new item: a preset, manual units and the piece-unit fold at phone width', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 844 });
  await createOwnerShop(page);
  await page.goto('/inventory');
  await addItemForm(page);

  const example = page.getByTestId('unit-example');
  const piece = page.locator('#unit-piece-fields');
  await expect(piece).toBeHidden();
  await expect(example).toContainText('Type the big unit');

  // Every field is inside the viewport at 390px, and the page does not scroll sideways.
  for (const ph of ['Big unit (e.g. case)', 'Small unit (e.g. pack)', 'Small units per big']) {
    const box = await page.getByPlaceholder(ph).boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  // 1) preset
  await page.getByPlaceholder('Item name').fill('Preset Atta');
  await page.getByRole('button', { name: 'Use Kg / Gms units' }).click();
  await expect(page.getByPlaceholder('Big unit (e.g. case)')).toHaveValue('Kg');
  await expect(page.getByPlaceholder('Small units per big')).toHaveValue('1000');
  await expect(example).toContainText('1 Kg = 1000 Gms');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created Preset Atta' }).first(),
  ).toBeVisible();
  await expect(page.getByPlaceholder('Big unit (e.g. case)')).toHaveValue('');

  // 2) manual units with a piece unit; the fold keeps its values when closed
  await page.getByPlaceholder('Item name').fill('Manual Biscuit');
  await page.getByPlaceholder('Big unit (e.g. case)').fill('case');
  await page.getByPlaceholder('Small unit (e.g. pack)').fill('pack');
  await page.getByPlaceholder('Small units per big').fill('12');
  await expect(example).toContainText('1 case = 12 pack');
  await page.getByRole('button', { name: 'Add a piece unit' }).click();
  await expect(piece).toBeVisible();
  await page.getByPlaceholder('Piece unit (optional)').fill('pcs');
  await page.getByPlaceholder('Pieces per small').fill('10');
  await expect(example).toContainText('1 pack = 10 pcs');
  await page.getByRole('button', { name: 'Hide piece unit' }).click();
  await expect(piece).toBeHidden();
  await expect(page.getByTestId('piece-summary')).toContainText('pcs, 10 per pack');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created Manual Biscuit' }).first(),
  ).toBeVisible();

  // Stock is shown in the smallest configured unit, exactly as before.
  await expect(await peek(page, 'Manual Biscuit')).toContainText('Stock 0 pcs');
  await expect(await peek(page, 'Preset Atta')).toContainText('Stock 0 Gms');
});

test('bill rows still in the new-item state are counted, refused on post, then saved together', async ({
  page,
}) => {
  test.setTimeout(120000);
  await createOwnerShop(page);
  await page.goto('/inventory');
  for (const name of ['Ready One', 'Ready Two', 'Ready Three']) {
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
  await stockTask(page, 'Purchases');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase' }) });
  const total = purchase.getByTestId('bill-total');
  await fillBillItem(purchase, 1, 'Ready One', '1', '10');
  await fillBillItem(purchase, 2, 'Ready Two', '2', '10');
  await fillBillItem(purchase, 3, 'Ready Three', '3', '10');
  await expect(total).toContainText('Items (3)');
  await expect(total).toContainText('Bill total');

  // Two rows typed as new items but never saved.
  for (const [n, name] of [
    [4, 'Fresh Four'],
    [5, 'Fresh Five'],
  ] as const) {
    await purchase.getByRole('button', { name: '+ Add item', exact: true }).click();
    await purchase.getByLabel(`Item ${n} name`, { exact: true }).fill(name);
    await purchase.getByRole('button', { name: `+ Create “${name}”` }).click();
    await purchase.getByLabel(`Item ${n} big unit`).fill('kg');
    await purchase.getByLabel(`Item ${n} quantity`, { exact: true }).fill(String(n));
    await purchase.getByLabel(`Item ${n} rate ₹`, { exact: true }).fill('10');
  }
  await expect(purchase.getByTestId('not-added-badge')).toHaveCount(2);
  await expect(total).toContainText('3 items ready');
  await expect(total).toContainText('2 items not ready — not in this total');
  await expect(total).toContainText('Total so far');
  await expect(total).toContainText('₹60.00');

  // Post is refused with the first problem; nothing is posted.
  await purchase.locator('input[name="billNo"]').fill('NOT-READY-1');
  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  await expect(page.getByText(/Item 4: Choose the item/).first()).toBeVisible();

  // "Go to first" lands on the first not-ready row.
  await total.getByRole('button', { name: 'Go to first' }).click();
  await expect(purchase.getByLabel('Item 4 name', { exact: true })).toBeFocused();

  // Save all: rows become normal item rows, figures kept, total updates.
  await purchase.getByRole('button', { name: 'Save all new items (2)' }).click();
  await expect(total).toContainText('Items (5)', { timeout: 15000 });
  await expect(total).toContainText('Bill total');
  await expect(total).toContainText('₹150.00');
  await expect(purchase.getByTestId('not-added-badge')).toHaveCount(0);
  await expect(purchase.getByLabel('Item 4 quantity', { exact: true })).toHaveValue('4');

  // "+ Add item" reuses an empty last row; Enter on an empty last row adds nothing.
  const rows = purchase.getByRole('region', { name: /^Item \d+$/ });
  await purchase.getByRole('button', { name: '+ Add item', exact: true }).click();
  await expect(rows).toHaveCount(6);
  await purchase.getByRole('button', { name: '+ Add item', exact: true }).click();
  await expect(rows).toHaveCount(6);
  await expect(total).toContainText('1 empty row ignored');
  await purchase.getByLabel('Item 6 rate ₹', { exact: true }).press('Enter');
  await expect(rows).toHaveCount(6);

  await purchase.getByRole('button', { name: 'Post purchase' }).click();
  await expect(page.getByRole('status')).toContainText('Purchase posted (5 items)');
  await stockTask(page, 'Items');
  await page.getByLabel('Item details').selectOption({ label: 'Fresh Five' });
  await expect(page.getByLabel('item peek')).toContainText('Stock 5 kg');
});
