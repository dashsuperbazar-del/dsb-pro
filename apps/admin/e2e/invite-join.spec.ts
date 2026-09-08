import { test, expect, type Page } from '@playwright/test';

const TEST_PASSWORD = 'TestOnly-2026!pw';

function uniqueEmail() {
  return `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

async function fillSignup(page: Page, email: string) {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(TEST_PASSWORD);
  await page.getByLabel('Confirm password').fill(TEST_PASSWORD);
}

test('create your shop takes an owner straight into the app', async ({ page }) => {
  const email = uniqueEmail();
  await page.goto('/signup');
  await fillSignup(page, email);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel('Shop name').fill('Ramesh Store');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/DSB Pro — Admin/)).toBeVisible();
  await expect(page.getByText(/role owner/i)).toBeVisible();
});

test('owner creates a real invite and a new user accepts it through the deep link', async ({ page, browser }) => {
  const ownerEmail = uniqueEmail();
  await page.goto('/signup');
  await fillSignup(page, ownerEmail);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel('Shop name').fill('Invite Test Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/DSB Pro — Admin/)).toBeVisible();

  await page.goto('/team');
  await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible();
  await page.getByRole('button', { name: 'Create invite' }).click();
  const inviteLink = await page.getByTestId('invite-link').textContent();
  expect(inviteLink).toMatch(/\/join\/[^/]+$/);

  // A separate browser context is required so the invitee has no owner's
  // Supabase localStorage/session state.
  const inviteContext = await browser.newContext();
  const invitePage = await inviteContext.newPage();
  await invitePage.goto(inviteLink!);
  await expect(invitePage.getByText(/Sign up or log in to accept this invite/)).toBeVisible();
  await fillSignup(invitePage, uniqueEmail());
  await invitePage.getByRole('button', { name: 'Sign up' }).click();

  await expect(invitePage.getByText(/DSB Pro — Admin/)).toBeVisible();
  await expect(invitePage.getByText(/role cashier/i)).toBeVisible();
  await inviteContext.close();
});

test('invalid invite remains a user-facing error after signed-out signup', async ({ page }) => {
  const ownerEmail = uniqueEmail();
  await page.goto('/signup');
  await fillSignup(page, ownerEmail);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel('Shop name').fill('Invite Error Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/DSB Pro — Admin/)).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();

  await page.goto('/join/not-a-real-token');
  await fillSignup(page, uniqueEmail());
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('alert')).toContainText(/invalid|expired|already used/i);
});
