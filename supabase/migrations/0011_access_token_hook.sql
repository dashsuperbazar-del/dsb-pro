-- Custom Access Token Hook. See spec §5. Function signature and claim-injection
-- pattern required by Supabase Auth Hooks. Wiring Auth to actually call this
-- function is a manual Dashboard step (Authentication → Hooks → Custom Access
-- Token) — see docs/HANDOVER.md for the exact steps handed to the operator.
-- A user with no tenant_users row yet is left with unmodified claims — no
-- tenant_id claim means every tenant-scoped RLS policy resolves to zero rows,
-- per CLAUDE.md's "fresh user has no tenant until create_tenant()" rule.

create function custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_membership record;
  v_claims jsonb;
begin
  select tenant_id, role, shop_ids into v_membership
  from tenant_users
  where user_id = (event->>'user_id')::uuid
    and status = 'active';

  v_claims := event->'claims';

  if v_membership.tenant_id is not null then
    v_claims := v_claims
      || jsonb_build_object(
        'tenant_id', v_membership.tenant_id,
        'app_role', v_membership.role,
        'shop_ids', to_jsonb(v_membership.shop_ids)
      );
  end if;

  return jsonb_set(event, '{claims}', v_claims);
end;
$$;

revoke all on function custom_access_token_hook(jsonb) from public;
grant execute on function custom_access_token_hook(jsonb) to supabase_auth_admin;
