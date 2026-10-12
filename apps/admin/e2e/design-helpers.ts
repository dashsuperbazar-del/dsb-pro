import { expect, type Page } from '@playwright/test';
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
