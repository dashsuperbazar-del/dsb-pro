import { test, expect, type Page, type Route } from '@playwright/test';

function uniqueEmail() {
  return `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

const TEST_PASSWORD = 'shop2026pw';

async function fillSignup(page: Page, email: string) {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(TEST_PASSWORD);
  await page.getByLabel('Confirm password').fill(TEST_PASSWORD);
}

type DeviceRow = {
  id: string;
  user_id: string;
  device_id: string;
  label: string | null;
  last_seen: string;
  app_version: string | null;
  revoked_at: string | null;
};

type MockState = { loggedIn: boolean; tenantCreated: boolean; devices: DeviceRow[] };

function setupPageMocks(
  p: Page,
  opts: { email: string; userId: string; tenantId: string; shopId: string; state: MockState },
) {
  const { email, userId, tenantId, shopId, state } = opts;

  p.route('**/auth/v1/signup', async (route: Route) => {
    state.loggedIn = true;
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
          id: userId,
          aud: 'authenticated',
          role: 'authenticated',
          email,
          email_confirmed_at: new Date().toISOString(),
          app_metadata: {},
          user_metadata: {},
          created_at: new Date().toISOString(),
        },
      }),
    });
  });

  p.route('**/rest/v1/rpc/register_device', async (route: Route) => {
    const body = route.request().postDataJSON();
    const existing = state.devices.find((d: DeviceRow) => d.user_id === userId && d.device_id === body.p_device_id);
    if (existing) {
      existing.last_seen = new Date().toISOString();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(existing.id) });
      return;
    }
    const id = `device-${state.devices.length + 1}`;
    state.devices.push({
      id,
      user_id: userId,
      device_id: body.p_device_id,
      label: null,
      last_seen: new Date().toISOString(),
      app_version: body.p_app_version ?? null,
      revoked_at: null,
    } satisfies DeviceRow);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(id) });
  });

  p.route('**/rest/v1/rpc/set_device_label', async (route: Route) => {
    const body = route.request().postDataJSON();
    const device = state.devices.find((d: DeviceRow) => d.id === body.p_id);
    if (device) device.label = body.p_label;
    await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });

  p.route('**/rest/v1/rpc/current_membership', async (route: Route) => {
    const members = state.tenantCreated && state.loggedIn
      ? [{ tenant_id: tenantId, role: 'owner', shop_ids: [shopId] }]
      : [];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(members) });
  });

  p.route('**/rest/v1/rpc/create_tenant', async (route: Route) => {
    state.tenantCreated = true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tenantId) });
  });

  p.route('**/rest/v1/shops**', async (route: Route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: shopId, is_default: true }]) });
  });

  p.route('**/rest/v1/devices**', async (route: Route) => {
    const url = new URL(route.request().url());
    const userFilter = url.searchParams.get('user_id');
    let rows = state.devices as DeviceRow[];
    if (userFilter) {
      const wantedId = userFilter.replace(/^eq\./, '');
      rows = rows.filter((d) => d.user_id === wantedId);
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
  });
}

test('an owner sees their own device, auto-labeled, and can rename it', async ({ page }) => {
  const email = uniqueEmail();
  const state = { loggedIn: false, tenantCreated: false, devices: [] as DeviceRow[] };
  setupPageMocks(page, { email, userId: 'owner-devices-1', tenantId: 'tenant-devices-1', shopId: 'shop-devices-1', state });

  await page.goto('/signup');
  await fillSignup(page, email);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel('Shop name').fill('Devices Test Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await page.getByText(/DSB Pro — Admin/i).waitFor({ timeout: 5000 });

  await page.goto('/devices');
  await expect(page.getByTestId('my-devices')).toContainText(/chrome/i);

  await page.getByRole('button', { name: 'Rename' }).click();
  await page.getByLabel('New name').fill('My laptop');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('my-devices')).toContainText('My laptop');
});

test('device screen states that Phase 5 revocation blocks sync on the next request', async ({ page }) => {
  const email = uniqueEmail();
  const state = { loggedIn: false, tenantCreated: false, devices: [] as DeviceRow[] };
  setupPageMocks(page, { email, userId: 'owner-devices-2', tenantId: 'tenant-devices-2', shopId: 'shop-devices-2', state });

  await page.goto('/signup');
  await fillSignup(page, email);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel('Shop name').fill('Owner Devices Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await page.getByText(/DSB Pro — Admin/i).waitFor({ timeout: 5000 });

  await page.goto('/devices');
  await expect(page.getByText(/blocks that browser from pulling or pushing queued Phase 5 sync work/i)).toBeVisible();
});
