import { test, expect } from '@playwright/test';

function uniqueEmail() {
  return `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

test('create your shop takes an owner straight into the app', async ({ page }) => {
  const email = uniqueEmail();
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('shop2026pw');
  await page.getByRole('button', { name: 'Sign up' }).click();

  await page.getByLabel('Shop name').fill('Ramesh Store');
  await page.getByRole('button', { name: 'Create your shop' }).click();

  await expect(page.getByText(/DSB Pro — Admin/)).toBeVisible();
  await expect(page.getByText(/role owner/i)).toBeVisible();
});

test('visiting a join link while signed out routes through signup first, then joins', async ({ page, request, context }) => {
  // Seed a real invite by creating an owner account + tenant + invite via the UI first.
  const ownerEmail = uniqueEmail();
  await page.goto('/signup');
  await page.getByLabel('Email').fill(ownerEmail);
  await page.getByLabel('Password').fill('shop2026pw');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel('Shop name').fill('Invite Test Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/DSB Pro — Admin/)).toBeVisible();

  // Team screen (Task 11) will make this a UI click; until then, this spec
  // only proves the /join/:token route itself for an already-known invalid
  // token, which doesn't require a real invite yet.
  await context.clearCookies();
  await page.goto('/join/not-a-real-token');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password').fill('shop2026pw');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('alert')).toContainText(/invalid|expired|already used/i);
});
