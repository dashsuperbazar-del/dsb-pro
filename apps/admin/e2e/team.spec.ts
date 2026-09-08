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
  joinerStatus: 'active' | 'disabled';
  joinerRemoved: boolean;
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
        access_token: 'token', token_type: 'bearer', expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'refresh',
        user: {
          id: isOwner ? ownerUserId : joinerUserId,
          aud: 'authenticated', role: 'authenticated', email: body.email,
          email_confirmed_at: new Date().toISOString(), app_metadata: {}, user_metadata: {},
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
      else if (state.joinerLoggedIn && !state.joinerRemoved && state.joinerStatus === 'active') {
        rows.push({ tenant_id: tenantId, role: state.joinerRole, shop_ids: [shopId] });
      }
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
      status: 200, contentType: 'application/json',
      body: JSON.stringify([{ id: `invite-${suffix}`, token: `token-${suffix}`, expires_at: new Date(Date.now() + 604800000).toISOString() }]),
    });
  });
  page.route('**/invites**', async (route) => {
    const rows = state.inviteExists ? [{
      id: `invite-${suffix}`, token: `token-${suffix}`, role: state.joinerRole, shop_ids: [shopId],
      expires_at: new Date(Date.now() + 604800000).toISOString(), created_at: new Date().toISOString(),
    }] : [];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
  });
  page.route('**/rpc/list_tenant_users_admin', async (route) => {
    const rows = [{ user_id: ownerUserId, email: state.ownerEmail, display_name: null, role: 'owner', status: 'active' }];
    if (state.joinerLoggedIn && !state.joinerRemoved) {
      rows.push({ user_id: joinerUserId, email: state.joinerEmail ?? 'joiner@example.com', display_name: null, role: state.joinerRole, status: state.joinerStatus });
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
  });
  page.route('**/rpc/accept_invite', async (route) => {
    state.joinerLoggedIn = true;
    state.joinerRemoved = false;
    state.joinerStatus = 'active';
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
  page.route('**/rpc/set_user_status', async (route) => {
    state.joinerStatus = route.request().postDataJSON().p_status;
    await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });
  page.route('**/rpc/remove_tenant_user', async (route) => {
    state.joinerRemoved = true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });
}

function baseState(overrides: Partial<State> = {}): State {
  return {
    ownerEmail: uniqueEmail(), joinerEmail: uniqueEmail(), ownerLoggedIn: false, joinerLoggedIn: false,
    tenantCreated: false, inviteExists: false, joinerRole: 'cashier', joinerStatus: 'active', joinerRemoved: false,
    ...overrides,
  };
}

async function signup(page: Page, email: string) {
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
}

async function createOwnerShop(page: Page, state: State, name: string) {
  await signup(page, state.ownerEmail);
  await page.getByLabel('Shop name').fill(name);
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await page.getByText(/DSB Pro — Admin/i).waitFor({ timeout: 5000 });
}

test('owner creates an invite and a new user accepts the shared deep link', async ({ page, browser }) => {
  const state = baseState();
  setupMocks(page, state, '1');
  await createOwnerShop(page, state, 'Team Test Shop');
  await page.goto('/team');
  await page.getByRole('button', { name: 'Create invite' }).click();
  const link = await page.getByTestId('invite-link').textContent();
  expect(link).toMatch(/\/join\//);

  state.ownerLoggedIn = false;
  const context = await browser.newContext();
  const joinPage = await context.newPage();
  setupMocks(joinPage, state, '1');
  await joinPage.goto(new URL(link!).pathname);
  await joinPage.getByLabel('Email').fill(state.joinerEmail!);
  await joinPage.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await joinPage.getByLabel('Confirm password').fill(PASSWORD);
  await joinPage.getByRole('button', { name: 'Sign up' }).click();
  await expect(joinPage.getByText(/role cashier/i)).toBeVisible({ timeout: 5000 });
  await context.close();
});

test('owner revokes a pending invite', async ({ page }) => {
  const state = baseState({ joinerRole: 'manager' });
  setupMocks(page, state, '2');
  await createOwnerShop(page, state, 'Revoke Test');
  await page.goto('/team');
  await page.getByLabel('Role').selectOption('manager');
  await page.getByRole('button', { name: 'Create invite' }).click();
  await page.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByTestId('pending-invites')).toContainText(/no pending invites/i);
});

test('owner can change role, disable, reactivate, and remove a member', async ({ page }) => {
  const state = baseState();
  setupMocks(page, state, '3');
  await createOwnerShop(page, state, 'Member Lifecycle Test');

  // The member exists in the owner's tenant, but is not the browser's current
  // login. Model that independently from auth state, then use the app's own
  // Team navigation so this test exercises SPA routing instead of relying on a
  // mocked access token surviving a synthetic hard reload.
  state.joinerLoggedIn = true;
  await page.getByRole('link', { name: 'Team' }).click();

  const members = page.getByTestId('members-list');
  await expect(members).toContainText(state.joinerEmail!);
  await members.getByRole('combobox').selectOption('manager');
  await expect(members.getByRole('combobox')).toHaveValue('manager');
  await members.getByRole('button', { name: 'Disable' }).click();
  await expect(members).toContainText('disabled');
  await members.getByRole('button', { name: 'Reactivate' }).click();
  await expect(members).toContainText('active');
  await members.getByRole('button', { name: 'Remove' }).click();
  await expect(members).not.toContainText(state.joinerEmail!);
});