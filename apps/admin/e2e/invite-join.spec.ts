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

test('owner creates a real invite and a new user accepts it through the deep link', async ({ page, browser }) => {
  const ownerEmail = uniqueEmail();
  await page.goto('/signup');
  await page.getByLabel('Email').fill(ownerEmail);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel('Shop name').fill('Invite Test Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/DSB Pro — Admin/)).toBeVisible();

  await page.goto('/team');
  await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible();
  await page.getByRole('button', { name: 'Create invite' }).click();
  const inviteLink = await page.getByTestId('invite-link').textContent();
  expect(inviteLink).toMatch(/\/join\/[^/]+$/);

  const invitePage = await browser.newPage();
  await invitePage.goto(inviteLink!);
  await expect(invitePage.getByText(/Sign up or log in to accept this invite/)).toBeVisible();
  await invitePage.getByLabel('Email').fill(uniqueEmail());
  await invitePage.getByLabel('Password').fill(TEST_PASSWORD);
  await invitePage.getByRole('button', { name: 'Sign up' }).click();

  await expect(invitePage.getByText(/DSB Pro — Admin/)).toBeVisible();
  await expect(invitePage.getByText(/role cashier/i)).toBeVisible();
  await invitePage.close();
});

test('invalid invite remains a user-facing error after signed-out signup', async ({ page }) => {
  const ownerEmail = uniqueEmail();
  await page.goto('/signup');
  await page.getByLabel('Email').fill(ownerEmail);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel('Shop name').fill('Invite Error Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/DSB Pro — Admin/)).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();

  await page.goto('/join/not-a-real-token');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('alert')).toContainText(/invalid|expired|already used/i);
});
