import { test, expect, type Page } from '@playwright/test';
import { setupPosShop, addToCart, toPayment } from './pos-shop-setup';
// D6: Sales history rows (View primary, Void only inside the More menu with a confirm), the day
// reconciliation row starting collapsed, the table scroll cue, and the Sync status summary.

async function sell(page: Page) {
  await page.goto('/pos');
  await expect(page.getByLabel('Find product')).toBeEnabled();
  await addToCart(page, '2');
  await toPayment(page);
  await page.locator('#pos-payment input[type="number"]').first().fill('2400');
  await page.getByRole('button', { name: 'Finalize sale' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Sale finalized' }).first(),
  ).toBeVisible();
}

test('sales history: View is primary, Void sits behind More and is confirmed; reconciliation collapsed', async ({
  page,
}) => {
  test.setTimeout(180000);
  await setupPosShop(page, 'd6sh');
  await sell(page);
  await page.goto('/sales-history');
  const row = page.locator('tbody tr').filter({ hasText: 'INV-' }).first();
  await expect(row.getByRole('button', { name: 'View', exact: true })).toBeVisible();
  // Thousands separators.
  await expect(row).toContainText('₹2,400.00');
  // Void and print are not on the row until More is opened.
  await expect(page.getByRole('button', { name: 'Void sale' })).toHaveCount(0);
  const more = row.getByRole('button', { name: /More actions/ });
  await expect(more).toHaveAttribute('aria-haspopup', 'menu');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  const menu = row.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText(['Print thermal', 'Print A4', 'Void sale']);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  // Void is confirmed (dismissing the confirm voids nothing).
  await more.click();
  page.once('dialog', (d) => void d.dismiss());
  await row.getByRole('menuitem', { name: 'Void sale' }).click();
  await expect(row.getByText('FINALIZED')).toBeVisible();
  await more.click();
  page.once('dialog', (d) => void d.accept());
  await row.getByRole('menuitem', { name: 'Void sale' }).click();
  await expect(page.getByText(/voided\./).first()).toBeVisible();

  // The day reconciliation is one collapsed row until opened.
  const rec = page.locator('section[aria-label="Day reconciliation"]');
  const toggle = rec.getByRole('button', { name: /Day reconciliation/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(rec.getByTestId('day-reconciliation-summary')).toBeHidden();
  await toggle.click();
  await expect(rec.getByTestId('day-reconciliation-summary')).toBeVisible();
});

test('tables that overflow show a scroll cue; Sync leads with a status summary', async ({
  page,
}) => {
  test.setTimeout(180000);
  await setupPosShop(page, 'd6sy');
  // A narrow phone (about 200% zoom): the seven-column Day book cannot fit.
  await page.setViewportSize({ width: 260, height: 700 });
  await page.goto('/reports');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Invariant check: PASS')).toBeVisible();
  // The Day book has seven columns: here it overflows and says so.
  await expect(page.getByTestId('scroll-hint').first()).toContainText('Swipe sideways');
  await expect(page.locator('.scroll-table[data-scrollable="true"]').first()).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/sync');
  await expect(page.getByTestId('sync-headline')).toHaveText('All saved. Nothing waiting.');
  await expect(page.getByTestId('sync-chip-waiting')).toHaveText('0 waiting');
  await expect(page.getByTestId('sync-chip-attention')).toHaveText('0 need attention');
  await expect(page.getByText('Outbox')).toHaveCount(0);
  await expect(page.getByText('Clock drift')).toHaveCount(0);
  // Technical counts sit in a collapsed Details row.
  const details = page.locator('section[aria-label="Sync details"]');
  const toggle = details.getByRole('button', { name: /Details/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(details.getByTestId('sync-outbox-count')).toBeVisible();
});
