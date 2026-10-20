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
export async function reviewPayment(page: Page) {
  await expect(page.getByRole('heading', { name: 'Sales POS', exact: true })).toBeVisible();
  const payment = page.locator('#pos-payment');
  if (!(await payment.isVisible()))
    await page.getByRole('button', { name: 'Review payment →', exact: true }).click();
  await expect(page.locator('#pos-payment')).toBeVisible();
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
