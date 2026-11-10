import { expect, type Locator, type Page } from '@playwright/test';
export async function stockTask(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: 'Stock tasks' })
    .getByRole('button', { name, exact: true })
    .click();
}
export async function addItemForm(page: Page) {
  await stockTask(page, 'Items');
  const details = page
    .locator('details')
    .filter({ has: page.locator('summary').filter({ hasText: /^Add item$/ }) });
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
}
// D8: Home's workspace link list lives in the collapsed "All screens" row; open it (idempotent).
export async function openAllScreens(page: Page) {
  const toggle = page.locator('.home-row-toggle').filter({ hasText: /^All screens/ });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}
export async function reviewPayment(page: Page) {
  await expect(page.getByRole('heading', { name: 'Sales POS', exact: true })).toBeVisible();
  const payment = page.locator('#pos-payment');
  if (!(await payment.isVisible()))
    await page.getByRole('button', { name: 'Review payment →', exact: true }).click();
  await expect(page.locator('#pos-payment')).toBeVisible();
}
// D4: on a phone the POS "Bill options" row (invoice type, discounts, hold label) starts closed.
export async function openBillOptions(page: Page) {
  const toggle = page.locator('.home-row-toggle').filter({ hasText: /^Bill options/ });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}
// D5: the Purchases list filters sit behind a collapsed "Filter" row; open it before using them.
export async function openPurchaseFilter(page: Page) {
  await closeBillSheet(page);
  const toggle = page.locator('.home-row-toggle').filter({ hasText: /^Filter/ });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}
// Old-DSB popup: "Delete Bill" opens the void panel (reason + Void bill); a bill is voided, never deleted.
export async function openVoidPanel(detail: Locator) {
  await detail.getByRole('button', { name: 'Delete Bill', exact: true }).click();
}
export async function addCustomerForm(page: Page) {
  const details = page
    .locator('details')
    .filter({ has: page.locator('summary').filter({ hasText: /^Add customer$/ }) });
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
}
// Purchase bill entry cards: fills card n (adding it with "+ Add item" when it is not there yet).
export async function fillBillItem(
  purchase: Locator,
  n: number,
  item: string,
  qty: string,
  cost: string,
  opts: { unit?: string; total?: boolean } = {},
) {
  if ((await purchase.getByRole('region', { name: /^Item \d+$/ }).count()) < n)
    await purchase.getByRole('button', { name: '+ Add item', exact: true }).click();
  await purchase.getByLabel(`Item ${n} name`, { exact: true }).fill(item);
  await purchase
    .getByRole('group', { name: `Matches for item ${n}`, exact: true })
    .getByRole('button', { name: item, exact: true })
    .click();
  if (opts.unit)
    await purchase
      .getByRole('group', { name: `Item ${n} purchased in`, exact: true })
      .getByRole('button', { name: opts.unit, exact: true })
      .click();
  await purchase.getByLabel(`Item ${n} quantity`, { exact: true }).fill(qty);
  if (opts.total) {
    await purchase
      .getByRole('group', { name: `Item ${n} cost entered as`, exact: true })
      .getByRole('button', { name: 'Total', exact: true })
      .click();
    await purchase.getByLabel(`Item ${n} total ₹`, { exact: true }).fill(cost);
  } else await purchase.getByLabel(`Item ${n} rate ₹`, { exact: true }).fill(cost);
}
// Fast bill entry: the closed parts of the purchase form.
export async function openBillDetails(purchase: Locator) {
  const toggle = purchase.locator('.bill-details-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}
export async function openItemMore(purchase: Locator, n: number) {
  const more = purchase.getByRole('button', { name: `More for item ${n}`, exact: true });
  if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
}

/** The bill detail is a popup sheet over the list (old-DSB layout): close it before using the list again. */
export async function closeBillSheet(page: Page) {
  const close = page.getByRole('button', { name: 'Close detail' });
  if (await close.isVisible()) await close.click();
}
