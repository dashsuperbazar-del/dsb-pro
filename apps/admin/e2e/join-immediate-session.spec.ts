import { test, expect } from '@playwright/test';

// Regression test for a review finding on Task 9: SignupScreen's own
// onSubmit unconditionally called route('/') the instant signUp() resolved
// with an immediate session. Nested inside JoinInviteScreen's signed-out
// branch, that navigation fired before JoinInviteScreen's own useSession()
// ever moved past 'signed-out', unmounting it before its
// `!attempted && token` branch could call acceptInvite(token) — silently
// dropping the invite.
//
// dsb-pro-dev (the real hosted project used elsewhere in this app's e2e
// suite) requires email confirmation, so signUp() never resolves with an
// immediate session there — this exact path can't be exercised against it
// from this machine (no Docker/WSL2 for a local Supabase instance with
// confirmations disabled, which is what CI's fresh instance actually runs).
// This spec exercises the real SignupScreen/JoinInviteScreen code, in a
// real browser, against the real built app — only the network calls to
// Supabase are mocked, standing in for "email confirmation disabled"
// (CI's actual config) without needing a live backend or spending any of
// dsb-pro-dev's (rate-limited) email quota.
test('an immediate-session signup inside the join flow calls accept_invite, not a bare navigation away', async ({ page }) => {
  const token = 'mock-invite-token';
  let acceptInviteCallCount = 0;
  let acceptInviteToken: string | null = null;

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
          email: 'joiner@example.com',
          email_confirmed_at: new Date().toISOString(),
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

  await page.route('**/rest/v1/rpc/accept_invite', async (route) => {
    acceptInviteCallCount += 1;
    acceptInviteToken = route.request().postDataJSON()?.p_token ?? null;
    if (acceptInviteCallCount === 1) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify('fake-tenant-id') });
    } else {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'invite invalid, expired, or already used' }),
      });
    }
  });

  await page.goto(`/join/${token}`);
  await page.getByLabel('Email').fill('joiner@example.com');
  await page.getByLabel('Password', { exact: true }).fill('shop2026pw');
  await page.getByLabel('Confirm password').fill('shop2026pw');
  await page.getByRole('button', { name: 'Sign up' }).click();

  await expect.poll(() => acceptInviteCallCount, { timeout: 10000 }).toBeGreaterThan(0);
  expect(acceptInviteToken).toBe(token);
  expect(new URL(page.url()).pathname).toBe(`/join/${token}`);
});
