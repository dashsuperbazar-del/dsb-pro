// O1: opening balances at cutover feed the account balances; a wrong one is voided and re-entered.
import { test, expect } from '@playwright/test';

const PASSWORD = 'TestOnly-2026!pw';
const email = () => `openings-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

test('owner records a supplier opening, sees it in balances, voids it and re-enters it', async ({
  page,
}) => {
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email());
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Openings Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/DSB Pro — Admin/)).toBeVisible();

  await page.getByRole('link', { name: 'Inventory & purchases' }).click();
  await page.getByPlaceholder('Supplier name').fill('Opening Traders');
  await page.getByRole('button', { name: 'Create supplier' }).click();
  await expect(page.getByRole('status')).toContainText('Created supplier Opening Traders');

  await page.goto('/reports');
  await page.getByRole('link', { name: 'Opening balances' }).click();
  await page.getByLabel('Account type').selectOption('SUPPLIER');
  await page
    .getByRole('combobox', { name: 'Account', exact: true })
    .selectOption({ label: 'Opening Traders' });
  await page.getByLabel('Amount ₹').fill('500');
  await page.getByRole('button', { name: 'Record opening' }).click();
  await expect(page.getByRole('status')).toContainText('Opening recorded for Opening Traders');
  const list = page.getByRole('region', { name: 'Openings' });
  await expect(list.locator('tr').filter({ hasText: 'Opening Traders' })).toContainText('₹500.00');

  // A second active opening for the same account is refused.
  await page
    .getByRole('combobox', { name: 'Account', exact: true })
    .selectOption({ label: 'Opening Traders' });
  await page.getByLabel('Amount ₹').fill('10');
  await page.getByRole('button', { name: 'Record opening' }).click();
  await expect(page.getByRole('status')).toContainText('Not recorded');

  await page.goto('/compare');
  const suppliers = page.getByRole('region', { name: 'Supplier balances' });
  await expect(suppliers.locator('tr').filter({ hasText: 'Opening Traders' })).toContainText(
    '₹500.00',
  );

  await page.goto('/openings');
  page.once('dialog', (d) => void d.accept('typed wrong amount'));
  await list.getByRole('button', { name: 'Void' }).click();
  await expect(page.getByRole('status')).toContainText('Opening voided');
  await expect(list).toContainText('Voided: typed wrong amount');

  await page.getByLabel('Account type').selectOption('SUPPLIER');
  await page
    .getByRole('combobox', { name: 'Account', exact: true })
    .selectOption({ label: 'Opening Traders' });
  await page.getByLabel('Amount ₹').fill('450');
  await page.getByRole('button', { name: 'Record opening' }).click();
  await expect(page.getByRole('status')).toContainText('Opening recorded');

  await page.goto('/compare');
  await expect(suppliers.locator('tr').filter({ hasText: 'Opening Traders' })).toContainText(
    '₹450.00',
  );
});
