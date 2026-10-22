import { addItemForm, fillBillItem, stockTask } from './design-helpers';
import { test, expect } from '@playwright/test';

// 0066 billedit: "Edit bill" opens the posted bill in the entry card; saving posts the corrected bill and
// voids the original in one server transaction.
const PASSWORD = 'TestOnly-2026!pw';

test('editing a posted bill replaces it: original void, corrected bill posted, stock and supplier follow', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.goto('/signup');
  await page
    .getByLabel('Email')
    .fill(`bill-edit-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Bill Edit Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/Overview/)).toBeVisible();

  await page.goto('/inventory');
  await addItemForm(page);
  await page.getByPlaceholder('Item name').fill('Edit Rice');
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Created Edit Rice' }).first(),
  ).toBeVisible();

  // Post the original: 5 x ₹10 from a new supplier.
  await page.goto('/purchases?new=1');
  const post = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Post purchase', exact: true }) })
    .last();
  await expect(post.locator('input[name="date"]')).not.toHaveValue('');
  const supplier = page
    .getByRole('button', { name: 'Create & select supplier' })
    .locator('xpath=..');
  await page.getByText('Add a supplier', { exact: true }).click();
  await supplier.getByPlaceholder('New supplier name').fill('Edit Supplier');
  await supplier.getByRole('button', { name: 'Create & select supplier' }).click();
  await expect(post.locator('select[name="partyId"]')).toHaveValue(/.+/);
  await post.locator('input[name="billNo"]').fill('EDIT-1');
  await fillBillItem(post, 1, 'Edit Rice', '5', '10');
  await post.getByRole('button', { name: 'Post purchase', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Purchase posted (1 item)' }).first(),
  ).toBeVisible();

  // Open it and edit: the card comes prefilled with the bill as posted.
  await page.goto('/purchases');
  await page.getByRole('button', { name: /Edit Supplier.*EDIT-1/ }).click();
  const detail = page.getByLabel('Purchase detail');
  // A pending remark on the original travels to the corrected bill (read side only).
  const box = detail.getByLabel('Pending remarks');
  await box.getByLabel('New remark').fill('2 pieces still to come');
  await box.getByRole('button', { name: 'Add remark' }).click();
  await expect(box.getByTestId('remark')).toHaveCount(1);
  await detail.getByTestId('edit-bill').click();
  const edit = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Edit bill', exact: true }) })
    .last();
  await expect(edit.getByTestId('editing-bill')).toContainText('Editing bill EDIT-1');
  await expect(edit.locator('input[name="billNo"]')).toHaveValue('EDIT-1');
  await expect(edit.getByLabel('Item 1 quantity', { exact: true })).toHaveValue('5');
  await edit.getByLabel('Item 1 quantity', { exact: true }).fill('7');
  // Same supplier and bill no. as the original it replaces: no duplicate-bill question.
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await edit.getByRole('button', { name: 'Save corrected bill', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Bill corrected (1 item)' }).first(),
  ).toBeVisible();
  expect(dialogs).toEqual([]);

  // The list shows the corrected bill and the void original; each links to the other.
  await page.goto('/purchases');
  // The replaced original is void, so it is hidden by default; "Show voided" lists it.
  await expect(page.getByTestId('list-settlement')).toHaveCount(1);
  await expect(page.getByText(/1 voided item hidden\./)).toBeVisible();
  await page.getByLabel('Show voided').check();
  await expect(page.getByTestId('list-settlement')).toHaveCount(2);
  await expect(page.getByTestId('list-settlement')).toContainText(['Void']);
  await page
    .getByRole('button', { name: /Edit Supplier.*EDIT-1.*₹70/ })
    .first()
    .click();
  await expect(detail.getByTestId('bill-edited-from')).toBeVisible();
  await detail.getByRole('button', { name: 'Open the original' }).click();
  await expect(detail.getByTestId('bill-replaced')).toBeVisible();
  // The void original shows its remark, but only the corrected bill carries the "Pending" badge.
  await expect(detail.getByLabel('Pending remarks').getByTestId('remark')).toHaveCount(1);
  await expect(page.getByTestId('list-pending')).toHaveCount(1);
  await expect(detail.getByTestId('edit-bill')).toHaveCount(0);

  await detail.getByRole('link', { name: 'Supplier ledger', exact: true }).click();
  await expect(page.locator('.supplier-ledger')).toContainText('Closing: ₹70.00');
  await page.goto('/inventory');
  await stockTask(page, 'Items');
  await page.getByLabel('Item details').selectOption({ label: 'Edit Rice' });
  await expect(page.getByLabel('item peek')).toContainText('Stock 7 piece');
});
