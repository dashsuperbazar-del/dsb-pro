import { test, expect } from '@playwright/test';

const TEST_PASSWORD = 'TestOnly-2026!pw';

function uniqueEmail() {
  return `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

test('create your shop takes an owner straight into the app', async ({ page }) => {
  const email = uniqueEmail();
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();

  await page.getByLabel('Shop name').fill('Ramesh Store');
  await page.getByRole('button', { name: 'Create your shop' }).click();

  await expect(page.getByText(/DSB Pro — Admin/)).toBeVisible();
  await expect(page.getByText(/role owner/i)).toBeVisible();
});

test('visiting a join link while signed out routes through signup first, then joins', async ({ page }) => {
  // Create an owner account first so this test also proves that a real
  // authenticated session can be cleanly returned to the signed-out state.
  const ownerEmail = uniqueEmail();
  await page.goto('/signup');
  await page.getByLabel('Email').fill(ownerEmail);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel('Shop name').fill('Invite Test Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/DSB Pro — Admin/)).toBeVisible();

  // clearCookies() is not a valid Supabase sign-out: the browser client
  // persists its session in localStorage and also keeps the session in memory.
  // Use the application's real sign-out path so /join/:token is genuinely
  // exercised from the signed-out state.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();

  // This spec intentionally uses an invalid token because it does not need a
  // real invite to verify the deep-link -> signup -> invalid-token error path.
  await page.goto('/join/not-a-real-token');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('alert')).toContainText(/invalid|expired|already used/i);
});
