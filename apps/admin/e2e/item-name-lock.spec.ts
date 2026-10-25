import { test, expect, type Page } from '@playwright/test';
import { addItemForm, stockTask } from './design-helpers';

const PASSWORD = 'TestOnly-2026!pw';

async function createOwnerShop(page: Page) {
  await page.goto('/signup');
  await page
    .getByLabel('Email')
    .fill(`namelock-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Name Lock Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/Overview/)).toBeVisible();
}

// The item is created from a second tab AFTER the first tab loaded its item list, so the bill card does not
// know the name and the server (create_item_v2) decides: same units -> that item, other units -> refused.
async function createElsewhere(page: Page, name: string, unit: string) {
  const other = await page.context().newPage();
  await other.goto('/inventory');
  await addItemForm(other);
  await other.getByPlaceholder('Item name').fill(name);
  await other.getByPlaceholder('Big unit (e.g. case)').fill(unit);
  await other.getByRole('button', { name: 'Create item' }).click();
  await expect(
    other
      .getByRole('status')
      .filter({ hasText: `Created ${name}` })
      .first(),
  ).toBeVisible();
  await other.close();
}

test('bill card "+ Create": same name + same units uses the existing item; other units are refused', async ({
  page,
}) => {
  test.setTimeout(120000);
  await createOwnerShop(page);
  await page.goto('/inventory');
  await stockTask(page, 'Purchases');
  const purchase = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase' }) });
  await expect(purchase.getByLabel('Item 1 name', { exact: true })).toBeEnabled();

  await createElsewhere(page, 'Twin Salt', 'kg');

  // (c) same name, other units -> refused with the distinct-name advice; the new-item form stays open.
  await purchase.getByLabel('Item 1 name', { exact: true }).fill('Twin Salt');
  await purchase.getByRole('button', { name: '+ Create “Twin Salt”' }).click();
  await purchase.getByLabel('Item 1 big unit').fill('bag');
  await purchase.getByRole('button', { name: 'Save item' }).click();
  await expect(
    page
      .getByText(
        'An item called “Twin Salt” already exists with different units, so it was not created. Choose that item, or give this one a distinct name (for example “Sugar 50kg bag” next to “Sugar”).',
      )
      .first(),
  ).toBeVisible();
  await expect(purchase.getByLabel('New item for item 1')).toBeVisible();
  await purchase.getByRole('button', { name: 'Cancel', exact: true }).first().click();
  // A refused create re-reads the list too, so the next name is created elsewhere only now.
  await createElsewhere(page, 'Twin Dal', 'kg');

  // (a) same name, same units -> mapped: no new item, GST/SKU unchanged, the existing item is chosen.
  await purchase.getByLabel('Item 1 name', { exact: true }).fill('twin dal');
  await purchase.getByRole('button', { name: '+ Create “twin dal”' }).click();
  await purchase.getByLabel('Item 1 big unit').fill('kg');
  await purchase.getByRole('button', { name: 'Save item' }).click();
  await expect(
    page
      .getByText(
        'Twin Dal already exists with these units — no new item was created (its GST and SKU are unchanged; any GST or SKU typed here was not used).',
      )
      .first(),
  ).toBeVisible();
  await expect(purchase.getByLabel('Item 1 name', { exact: true })).toHaveValue('Twin Dal');
  await expect(page.getByText('Created Twin Dal')).toHaveCount(0);
});
