import { test, expect } from '@playwright/test';

function uniqueEmail() {
  return `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

test('unverified email shows a dismissible reminder banner, not a block', async ({ page }) => {
  const email = uniqueEmail();

  await page.route('**/auth/v1/signup', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: 'fake-access-token',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: 'fake-refresh-token',
        user: {
          id: 'fake-user-id',
          aud: 'authenticated',
          role: 'authenticated',
          email,
          email_confirmed_at: null,
          app_metadata: {},
          user_metadata: {},
          created_at: new Date().toISOString(),
        },
      }),
    });
  });

  await page.route('**/rest/v1/rpc/register_device', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify('fake-device-id') });
  });
  await page.route('**/rest/v1/rpc/set_device_label', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });
  await page.route('**/rest/v1/rpc/current_membership', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('shop2026pw');
  await page.getByLabel('Confirm password').fill('shop2026pw');
  await page.getByRole('button', { name: 'Sign up' }).click();

  const banner = page.getByRole('status', { name: 'Email verification reminder' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/verify your email/i);
  await expect(page.getByLabel('Shop name')).toBeEnabled();

  await banner.getByRole('button', { name: 'Dismiss' }).click();
  await expect(banner).toBeHidden();
});
