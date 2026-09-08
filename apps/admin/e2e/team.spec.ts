import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'shop2026pw';

function uniqueEmail() {
  return `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

type State = {
  ownerEmail: string;
  joinerEmail?: string;
  ownerLoggedIn: boolean;
  joinerLoggedIn: boolean;
  tenantCreated: boolean;
  inviteExists: boolean;
  joinerRole: 'cashier' | 'manager';
};

function setupMocks(page: Page, state: State, suffix: string) {
  const tenantId = `tenant-${suffix}`;
  const shopId = `shop-${suffix}`;
  const ownerUserId = `owner-${suffix}`;
  const joinerUserId = `joiner-${suffix}`;

  page.route('**/auth/v1/signup', async (route) => {
    const body = route.request().postDataJSON();
    const isOwner = body.email === state.ownerEmail;
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

  page.route('**/rpc/register_device', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(`device-${suffix}`) });
  });
  page.route('**/rpc/set_device_label', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });
  page.route('**/rpc/current_membership', async (route) => {
    const rows = [];
    if (state.tenantCreated) {
      if (state.ownerLoggedIn) rows.push({ tenant_id: tenantId, role: 'owner', shop_ids: [shopId] });
      else if (state.joinerLoggedIn) rows.push({ tenant_id: tenantId, role: state.joinerRole, shop_ids: [shopId] });
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
  });
  page.route('**/rpc/create_tenant', async (route) => {
    state.tenantCreated = true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tenantId) });
  });
  page.route('**/shops**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: shopId, is_default: true }]) });
  });
  page.route('**/rpc/create_invite', async (route) => {
    state.inviteExists = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: `invite-${suffix}`, token: `token-${suffix}`, expires_at: new Date(Date.now() + 604800000).toISOString() }]),
    });
  });
  page.route('**/invites**', async (route) => {
    const rows = state.inviteExists
      ? [{
          id: `invite-${suffix}`,
          token: `token-${suffix}`,
          role: state.joinerRole,
          shop_ids: [shopId],
          expires_at: new Date(Date.now() + 604800000).toISOString(),
          created_at: new Date().toISOString(),
        }]
      : [];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
  });
  page.route('**/tenant_users**', async (route) => {
    const rows = [{ user_id: ownerUserId, role: 'owner', status: 'active' }];
    if (state.joinerLoggedIn) rows.push({ user_id: joinerUserId, role: state.joinerRole, status: 'active' });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
  });
  page.route('**/rpc/accept_invite', async (route) => {
    state.joinerLoggedIn = true;
    state.inviteExists = false;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tenantId) });
  });
  page.route('**/rpc/revoke_invite', async (route) => {
    state.inviteExists = false;
    await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });
  page.route('**/rpc/set_user_role', async (route) => {
    state.joinerRole = 'manager';
    await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });
}

async function signup(page: Page, email: string) {
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
}

async function createOwnerShop(page: Page, email: string, name: string) {
  await signup(page, email);
  await page.getByLabel('Shop name').fill(name);
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await page.getByText(/DSB Pro — Admin/i).waitFor({ timeout: 5000 });
}

test('owner creates an invite, shares the link, and accepting it joins the right role', async ({ page, browser }) => {
  const state: State = {
    ownerEmail: uniqueEmail(),
    joinerEmail: uniqueEmail(),
    ownerLoggedIn: false,
    joinerLoggedIn: false,
    tenantCreated: false,
    inviteExists: false,
    joinerRole: 'cashier',
  };
  setupMocks(page, state, '1');
  await createOwnerShop(page, state.ownerEmail, 'Team Test Shop');

  await page.goto('/team');
  await page.getByLabel('Role').selectOption('cashier');
  await page.getByRole('button', { name: 'Create invite' }).click();
  const link = await page.getByTestId('invite-link').textContent();
  expect(link).toMatch(/\/join\//);

  // The mock state represents one signed-in browser at a time.
  state.ownerLoggedIn = false;
  const context = await browser.newContext();
  const joinPage = await context.newPage();
  setupMocks(joinPage, state, '1');
  await joinPage.goto(new URL(link!).pathname);
  await joinPage.getByLabel('Email').fill(state.joinerEmail!);
  await joinPage.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await joinPage.getByLabel('Confirm password').fill(PASSWORD);
  await joinPage.getByRole('button', { name: 'Sign up' }).click();
  await expect(joinPage.getByText(/DSB Pro — Admin/i)).toBeVisible({ timeout: 5000 });
  await expect(joinPage.getByText(/role cashier/i)).toBeVisible();
  await context.close();
});

test('owner revokes a pending invite', async ({ page }) => {
  const state: State = {
    ownerEmail: uniqueEmail(), ownerLoggedIn: false, joinerLoggedIn: false,
    tenantCreated: false, inviteExists: false, joinerRole: 'manager',
  };
  setupMocks(page, state, '2');
  await createOwnerShop(page, state.ownerEmail, 'Revoke Test');

  await page.goto('/team');
  await page.getByLabel('Role').selectOption('manager');
  await page.getByRole('button', { name: 'Create invite' }).click();
  await page.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByTestId('pending-invites')).toContainText(/no pending invites/i);
});

test('owner changes a member role, with the latency caveat shown', async ({ page }) => {
  const state: State = {
    ownerEmail: uniqueEmail(), ownerLoggedIn: true, joinerLoggedIn: true,
    tenantCreated: true, inviteExists: false, joinerRole: 'cashier',
  };
  setupMocks(page, state, '3');
  await page.goto('/team');
  await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible();
  await page.getByTestId('members-list').getByRole('combobox').selectOption('manager');
  await expect(page.getByText(/takes effect.*next.*sign|up to.*hour/i)).toBeVisible();
});
