import { test, expect } from '@playwright/test';

function uniqueEmail() {
  return `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

const TEST_PASSWORD = 'TestOnly-2026!pw';

test('signup, sign out, then login with the same credentials', async ({ page }) => {
  const email = uniqueEmail();

  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();

  // Signup establishes a real session immediately; the no-tenant home therefore
  // exposes Sign out before the user creates their first shop.
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

  // Create a tenant so the authenticated home has a stable post-login target.
  await page.getByLabel('Shop name').fill('Auth Test Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/DSB Pro — Admin/)).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByText(/DSB Pro — Admin/)).toBeVisible();
  await expect(page.getByText(/role owner/i)).toBeVisible();
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
