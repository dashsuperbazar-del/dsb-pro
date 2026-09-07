import { describe, expect, it, vi, beforeEach } from 'vitest';
import { __setSupabaseClientForTest } from './client';
import {
  createTenant,
  getDefaultShopId,
  createInvite,
  revokeInvite,
  acceptInvite,
  setUserRole,
  getCurrentMembership,
  listTenantUsers,
  listInvites,
} from './tenancy';

function makeMockClient(rpcResults: Record<string, unknown> = {}, fromResults: Record<string, unknown> = {}) {
  return {
    rpc: vi.fn((fn: string) => Promise.resolve({ data: rpcResults[fn] ?? null, error: null })),
    from: vi.fn((table: string) => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: (fromResults[table] as unknown[])?.[0] ?? null, error: null }),
          then: (resolve: (r: unknown) => void) =>
            resolve({ data: fromResults[table] ?? [], error: null }),
        }),
        then: (resolve: (r: unknown) => void) =>
          resolve({ data: fromResults[table] ?? [], error: null }),
      }),
    })),
  };
}

describe('tenancy adapter', () => {
  beforeEach(() => {
    __setSupabaseClientForTest(makeMockClient() as never);
  });

  it('createTenant calls create_tenant with a generated slug, matching shop name, and a client_id', async () => {
    const client = makeMockClient({ create_tenant: 'tenant-1' });
    __setSupabaseClientForTest(client as never);
    const id = await createTenant("Ramesh's Store");
    expect(id).toBe('tenant-1');
    const call = client.rpc.mock.calls[0];
    expect(call[0]).toBe('create_tenant');
    expect(call[1].p_name).toBe("Ramesh's Store");
    expect(call[1].p_shop_name).toBe("Ramesh's Store");
    expect(call[1].p_slug).toMatch(/^ramesh-s-store-[a-z0-9]{4}$/);
    expect(typeof call[1].p_client_id).toBe('string');
  });

  it('createInvite looks up the default shop then calls create_invite', async () => {
    const client = makeMockClient(
      { create_invite: [{ id: 'inv-1', token: 'tok', expires_at: '2026-09-13T00:00:00Z' }] },
      { shops: [{ id: 'shop-1' }] },
    );
    __setSupabaseClientForTest(client as never);
    const invite = await createInvite('cashier');
    expect(invite).toEqual({
      id: 'inv-1',
      role: 'cashier',
      shopIds: ['shop-1'],
      token: 'tok',
      expiresAt: '2026-09-13T00:00:00Z',
      createdAt: expect.any(String),
    });
  });

  it('revokeInvite calls revoke_invite with the id', async () => {
    const client = makeMockClient({ revoke_invite: null });
    __setSupabaseClientForTest(client as never);
    await revokeInvite('inv-1');
    expect(client.rpc).toHaveBeenCalledWith('revoke_invite', { p_id: 'inv-1' });
  });

  it('acceptInvite calls accept_invite with the token and a client_id', async () => {
    const client = makeMockClient({ accept_invite: 'tenant-2' });
    __setSupabaseClientForTest(client as never);
    const tenantId = await acceptInvite('abc123');
    expect(tenantId).toBe('tenant-2');
    const call = client.rpc.mock.calls[0];
    expect(call[1].p_token).toBe('abc123');
    expect(typeof call[1].p_client_id).toBe('string');
  });

  it('setUserRole calls set_user_role with user id and role', async () => {
    const client = makeMockClient({ set_user_role: null });
    __setSupabaseClientForTest(client as never);
    await setUserRole('user-1', 'manager');
    expect(client.rpc).toHaveBeenCalledWith('set_user_role', { p_user_id: 'user-1', p_role: 'manager' });
  });

  it('getCurrentMembership maps the RPC row to camelCase, or null if empty', async () => {
    const client = makeMockClient({
      current_membership: [{ tenant_id: 't1', role: 'owner', shop_ids: ['s1'] }],
    });
    __setSupabaseClientForTest(client as never);
    await expect(getCurrentMembership()).resolves.toEqual({ tenantId: 't1', role: 'owner', shopIds: ['s1'] });

    const emptyClient = makeMockClient({ current_membership: [] });
    __setSupabaseClientForTest(emptyClient as never);
    await expect(getCurrentMembership()).resolves.toBeNull();
  });

  it('listTenantUsers and listInvites map rows to camelCase', async () => {
    const client = makeMockClient(
      {},
      {
        tenant_users: [{ user_id: 'u1', role: 'cashier', status: 'active' }],
        invites: [{ id: 'i1', role: 'manager', shop_ids: ['s1'], token: 't', expires_at: 'e', created_at: 'c' }],
      },
    );
    __setSupabaseClientForTest(client as never);
    await expect(listTenantUsers()).resolves.toEqual([{ userId: 'u1', role: 'cashier', status: 'active' }]);
    await expect(listInvites()).resolves.toEqual([
      { id: 'i1', role: 'manager', shopIds: ['s1'], token: 't', expiresAt: 'e', createdAt: 'c' },
    ]);
  });
});
