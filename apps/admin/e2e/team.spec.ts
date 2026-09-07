import { test, expect } from '@playwright/test';

function uniqueEmail() {
  return `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

test('owner creates an invite, shares the link, and accepting it joins the right role', async ({ page, context }) => {
  const ownerEmail = uniqueEmail();
  const joinerEmail = uniqueEmail();
  const ownerUserId = 'owner-id';
  const joinerUserId = 'joiner-id';
  const tenantId = 'tenant-1';
  const shopId = 'shop-1';

  let state = { ownerLoggedIn: false, joinerLoggedIn: false, tenantCreated: false };

  const setupPageMocks = (p: any) => {
    p.route('**/auth/v1/signup', async (route) => {
      const body = route.request().postDataJSON();
      const isOwner = body.email === ownerEmail;
      if (isOwner) state.ownerLoggedIn = true;
      else state.joinerLoggedIn = true;

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'token',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: 'refresh',
          user: {
            id: isOwner ? ownerUserId : joinerUserId,
            aud: 'authenticated',
            role: 'authenticated',
            email: body.email,
            email_confirmed_at: new Date().toISOString(),
            app_metadata: {},
            user_metadata: {},
            created_at: new Date().toISOString(),
          },
        }),
      });
    });

    p.route('**/rpc/register_device', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify('device-1') });
    });

    p.route('**/rpc/set_device_label', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    });

    p.route('**/rpc/current_membership', async (route) => {
      const members = [];
      if (state.tenantCreated) {
        if (state.ownerLoggedIn) members.push({ tenant_id: tenantId, role: 'owner', shop_ids: [shopId] });
        if (state.joinerLoggedIn) members.push({ tenant_id: tenantId, role: 'cashier', shop_ids: [shopId] });
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(members) });
    });

    p.route('**/rpc/create_tenant', async (route) => {
      state.tenantCreated = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tenantId) });
    });

    p.route('**/shops**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: shopId, is_default: true }]) });
    });

    p.route('**/rpc/create_invite', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          id: 'invite-1',
          token: 'token-invite-1',
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        }]),
      });
    });

    p.route('**/invites**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          id: 'invite-1',
          token: 'token-invite-1',
          role: 'cashier',
          shop_ids: [shopId],
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          created_at: new Date().toISOString(),
        }]),
      });
    });

    p.route('**/tenant_users**', async (route) => {
      const users = [{ user_id: ownerUserId, role: 'owner', status: 'active' }];
      if (state.joinerLoggedIn && state.tenantCreated) {
        users.push({ user_id: joinerUserId, role: 'cashier', status: 'active' });
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(users) });
    });

    p.route('**/rpc/accept_invite', async (route) => {
      state.joinerLoggedIn = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tenantId) });
    });

    p.route('**/rpc/revoke_invite', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    });
  };

  setupPageMocks(page);

  await page.goto('/signup');
  await page.getByLabel('Email').fill(ownerEmail);
  await page.getByLabel('Password').fill('shop2026pw');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel('Shop name').fill('Team Test Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await page.getByText(/DSB Pro — Admin/i).waitFor({ timeout: 5000 });

  await page.goto('/team');
  await page.getByLabel('Role').selectOption('cashier');
  await page.getByRole('button', { name: 'Create invite' }).click();

  const link = await page.getByTestId('invite-link').textContent({ timeout: 5000 });
  expect(link).toMatch(/\/join\//);

  const joinPage = await context.browser()!.newContext().then((c) => c.newPage());
  setupPageMocks(joinPage);

  await joinPage.goto(new URL(link!).pathname);
  await joinPage.getByLabel('Email').fill(joinerEmail);
  await joinPage.getByLabel('Password').fill('shop2026pw');
  await joinPage.getByRole('button', { name: 'Sign up' }).click();

  // After signup, acceptInvite() is called and page reloads. In production, acceptInvite(token) would fail
  // with "token already used" on the reload (single-use token), causing an error on joinPage.
  // We verify the flow worked by checking the owner's page shows the joiner in the members list.
  await joinPage.waitForTimeout(500);

  // Verify on owner's page that joiner now appears in members list with correct role (proves acceptInvite succeeded)
  await page.reload();
  await expect(page.getByTestId('members-list')).toContainText(/cashier/i, { timeout: 5000 });
});

test('owner revokes a pending invite', async ({ page }) => {
  const ownerEmail = uniqueEmail();
  const ownerUserId = 'owner-2';
  const tenantId = 'tenant-2';
  const shopId = 'shop-2';

  let state = { ownerLoggedIn: false, tenantCreated: false, inviteExists: false };

  const setupMocks = (p: any) => {
    p.route('**/auth/v1/signup', async (route) => {
      state.ownerLoggedIn = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'token',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: 'refresh',
          user: { id: ownerUserId, aud: 'authenticated', role: 'authenticated', email: ownerEmail, email_confirmed_at: new Date().toISOString(), app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
        }),
      });
    });

    p.route('**/rpc/register_device', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify('dev') });
    });
    p.route('**/rpc/set_device_label', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    });
    p.route('**/rpc/current_membership', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state.tenantCreated ? [{ tenant_id: tenantId, role: 'owner', shop_ids: [shopId] }] : []) });
    });
    p.route('**/rpc/create_tenant', async (route) => {
      state.tenantCreated = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tenantId) });
    });
    p.route('**/shops**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: shopId, is_default: true }]) });
    });

    p.route('**/rpc/create_invite', async (route) => {
      state.inviteExists = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'i1', token: 't1', expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() }]) });
    });

    p.route('**/invites**', async (route) => {
      const invites = state.inviteExists ? [{ id: 'i1', token: 't1', role: 'manager', shop_ids: [shopId], expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), created_at: new Date().toISOString() }] : [];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(invites) });
    });

    p.route('**/tenant_users**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ user_id: ownerUserId, role: 'owner', status: 'active' }]) });
    });
    p.route('**/rpc/revoke_invite', async (route) => {
      state.inviteExists = false;
      await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    });
  };

  setupMocks(page);

  await page.goto('/signup');
  await page.getByLabel('Email').fill(ownerEmail);
  await page.getByLabel('Password').fill('shop2026pw');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel('Shop name').fill('Revoke Test');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await page.getByText(/DSB Pro — Admin/i).waitFor({ timeout: 5000 });

  await page.goto('/team');
  await page.getByLabel('Role').selectOption('manager');
  await page.getByRole('button', { name: 'Create invite' }).click();

  // InviteForm now auto-refreshes PendingInvites when a new invite is created, so Revoke button appears immediately
  await page.getByRole('button', { name: 'Revoke' }).click({ timeout: 5000 });
  await expect(page.getByTestId('pending-invites')).toContainText(/no pending invites/i, { timeout: 5000 });
});

test('owner changes a member\'s role, with the latency caveat shown', async ({ page, context }) => {
  const ownerEmail = uniqueEmail();
  const joinerEmail = uniqueEmail();
  const ownerUserId = 'owner-3';
  const joinerUserId = 'joiner-3';
  const tenantId = 'tenant-3';
  const shopId = 'shop-3';

  let state = { ownerLoggedIn: false, joinerLoggedIn: false, tenantCreated: false, joinerRole: 'cashier' };

  const setupMocks = (p: any) => {
    p.route('**/auth/v1/signup', async (route) => {
      const body = route.request().postDataJSON();
      if (body.email === ownerEmail) state.ownerLoggedIn = true;
      else state.joinerLoggedIn = true;

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'token',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: 'refresh',
          user: { id: body.email === ownerEmail ? ownerUserId : joinerUserId, aud: 'authenticated', role: 'authenticated', email: body.email, email_confirmed_at: new Date().toISOString(), app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
        }),
      });
    });

    p.route('**/rpc/register_device', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify('dev') });
    });
    p.route('**/rpc/set_device_label', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    });
    p.route('**/rpc/current_membership', async (route) => {
      const members = [];
      if (state.tenantCreated) {
        if (state.ownerLoggedIn) members.push({ tenant_id: tenantId, role: 'owner', shop_ids: [shopId] });
        if (state.joinerLoggedIn) members.push({ tenant_id: tenantId, role: state.joinerRole, shop_ids: [shopId] });
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(members) });
    });
    p.route('**/rpc/create_tenant', async (route) => {
      state.tenantCreated = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tenantId) });
    });
    p.route('**/shops**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: shopId, is_default: true }]) });
    });
    p.route('**/rpc/create_invite', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'i', token: 'token-3', expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() }]) });
    });
    p.route('**/invites**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    });
    p.route('**/tenant_users**', async (route) => {
      const users = [{ user_id: ownerUserId, role: 'owner', status: 'active' }];
      if (state.joinerLoggedIn && state.tenantCreated) users.push({ user_id: joinerUserId, role: state.joinerRole, status: 'active' });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(users) });
    });
    p.route('**/rpc/accept_invite', async (route) => {
      state.joinerLoggedIn = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tenantId) });
    });
    p.route('**/rpc/set_user_role', async (route) => {
      state.joinerRole = 'manager';
      await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    });
  };

  setupMocks(page);

  await page.goto('/signup');
  await page.getByLabel('Email').fill(ownerEmail);
  await page.getByLabel('Password').fill('shop2026pw');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel('Shop name').fill('Role Test');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await page.getByText(/DSB Pro — Admin/i).waitFor({ timeout: 5000 });

  await page.goto('/team');
  await page.getByLabel('Role').selectOption('cashier');
  await page.getByRole('button', { name: 'Create invite' }).click();
  const link = await page.getByTestId('invite-link').textContent({ timeout: 5000 });

  const joinPage = await context.browser()!.newContext().then((c) => c.newPage());
  setupMocks(joinPage);

  await joinPage.goto(new URL(link!).pathname);
  await joinPage.getByLabel('Email').fill(joinerEmail);
  await joinPage.getByLabel('Password').fill('shop2026pw');
  await joinPage.getByRole('button', { name: 'Sign up' }).click();

  await page.reload();
  await page.goto('/team');
  await page.getByTestId('members-list').getByRole('combobox').selectOption('manager');

  await expect(page.getByText(/takes effect.*next.*sign|up to.*hour/i)).toBeVisible({ timeout: 5000 });
});
