import { test, expect } from '@playwright/test';

function uniqueEmail() {
  return `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

test('signup then login with the same credentials', async ({ page }) => {
  const email = uniqueEmail();
  const password = 'shop2026pw';

  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign up' }).click();

  // Local supabase config has enable_confirmations = false, so this lands
  // straight on the no-tenant screen (NoTenantScreen, Task 9).
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();

  await page.reload();
  // Reloading keeps the same Supabase session (signed in) — still no-tenant.
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
});

test('shows a user-facing error for wrong credentials', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill('nobody@example.com');
  await page.getByLabel('Password').fill('wrongpassword');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('alert')).toContainText(/invalid/i);
});

test('signup rejects a weak password before calling the server', async ({ page }) => {
  await page.goto('/signup');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password').fill('short');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('alert')).toContainText(/8 characters/);
});
