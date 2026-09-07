import { makeTenantSlug, type Role } from '@dsb-pro/core';
import { getSupabaseClient } from './client';

export type Membership = { tenantId: string; role: Role; shopIds: string[] };
export type Invite = {
  id: string;
  role: Role;
  shopIds: string[];
  token: string;
  expiresAt: string;
  createdAt: string;
};
export type TenantUser = { userId: string; role: Role; status: 'active' | 'disabled' };

function newClientId(): string {
  return crypto.randomUUID();
}

// create_tenant() (0007_tenant_lifecycle_rpcs.sql) needs three names —
// tenant name, slug, shop name — but the spec (§4) only ever asks the user
// for one: "shop name". Tenant name and shop name are set to the same value;
// the slug is derived + suffixed so it can never collide (packages/core's
// makeTenantSlug).
export async function createTenant(shopName: string): Promise<string> {
  const { data, error } = await getSupabaseClient().rpc('create_tenant', {
    p_name: shopName,
    p_slug: makeTenantSlug(shopName),
    p_shop_name: shopName,
    p_client_id: newClientId(),
  });
  if (error) throw error;
  return data as string;
}

// v1 UI has exactly one shop per tenant (DSB_PRO_BUILD_PLAN.md §11) — this
// looks up the shop create_tenant() marked is_default, so invite creation
// never needs a shop picker (spec §1).
export async function getDefaultShopId(): Promise<string> {
  const { data, error } = await getSupabaseClient()
    .from('shops')
    .select('id')
    .eq('is_default', true)
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function createInvite(role: Role): Promise<Invite> {
  const shopId = await getDefaultShopId();
  const { data, error } = await getSupabaseClient().rpc('create_invite', {
    p_role: role,
    p_shop_ids: [shopId],
  });
  if (error) throw error;
  const row = (data as { id: string; token: string; expires_at: string }[])[0];
  return {
    id: row.id,
    role,
    shopIds: [shopId],
    token: row.token,
    expiresAt: row.expires_at,
    createdAt: new Date().toISOString(),
  };
}

export async function revokeInvite(id: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc('revoke_invite', { p_id: id });
  if (error) throw error;
}

export async function acceptInvite(token: string): Promise<string> {
  const { data, error } = await getSupabaseClient().rpc('accept_invite', {
    p_token: token,
    p_client_id: newClientId(),
  });
  if (error) throw error;
  return data as string;
}

export async function setUserRole(userId: string, role: Role): Promise<void> {
  const { error } = await getSupabaseClient().rpc('set_user_role', { p_user_id: userId, p_role: role });
  if (error) throw error;
}

export async function getCurrentMembership(): Promise<Membership | null> {
  const { data, error } = await getSupabaseClient().rpc('current_membership');
  if (error) throw error;
  const rows = data as { tenant_id: string; role: Role; shop_ids: string[] }[];
  if (!rows.length) return null;
  return { tenantId: rows[0].tenant_id, role: rows[0].role, shopIds: rows[0].shop_ids };
}

export async function listTenantUsers(): Promise<TenantUser[]> {
  const { data, error } = await getSupabaseClient().from('tenant_users').select('user_id, role, status');
  if (error) throw error;
  return (data as { user_id: string; role: Role; status: 'active' | 'disabled' }[]).map((r) => ({
    userId: r.user_id,
    role: r.role,
    status: r.status,
  }));
}

// RLS (invites_select_own, 0007_tenant_lifecycle_rpcs.sql) already restricts
// this to callers with MANAGE_INVITES (owner only) — no client-side role
// check is needed to make this safe, only to decide whether to show the UI
// that calls it.
export async function listInvites(): Promise<Invite[]> {
  const { data, error } = await getSupabaseClient()
    .from('invites')
    .select('id, role, shop_ids, token, expires_at, created_at');
  if (error) throw error;
  return (data as { id: string; role: Role; shop_ids: string[]; token: string; expires_at: string; created_at: string }[]).map(
    (r) => ({
      id: r.id,
      role: r.role,
      shopIds: r.shop_ids,
      token: r.token,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
    }),
  );
}
