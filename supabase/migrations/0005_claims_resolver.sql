-- Claims resolver: JWT custom claims first, tenant_users fallback second.
-- See docs/superpowers/specs/2026-09-06-phase-1-tenancy-auth-rls-design.md §5.
-- Custom claim keys used by the access-token hook (0011_access_token_hook.sql):
-- "tenant_id", "app_role", "shop_ids" — deliberately not "role", which
-- PostgREST/Supabase reserve for the Postgres role name (anon/authenticated/
-- service_role).
--
-- All five functions here are security definer so they can read tenant_users/
-- role_permissions regardless of the calling role's own grants on those tables
-- (neither table grants SELECT to anon/authenticated at all — see 0003, 0004).

create function "current_membership"()
returns table (tenant_id uuid, role text, shop_ids uuid[])
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  claim_tenant_id uuid;
begin
  claim_tenant_id := nullif(auth.jwt() ->> 'tenant_id', '')::uuid;

  if claim_tenant_id is not null then
    return query
      select
        claim_tenant_id,
        auth.jwt() ->> 'app_role',
        coalesce(
          (select array_agg(elem::uuid) from jsonb_array_elements_text(auth.jwt() -> 'shop_ids') as elem),
          '{}'::uuid[]
        );
    return;
  end if;

  return query
    select tu.tenant_id, tu.role, tu.shop_ids
    from tenant_users tu
    where tu.user_id = auth.uid()
      and tu.status = 'active';
end;
$$;

create function "current_tenant_id"() returns uuid
language sql stable security definer set search_path = public
as $$ select tenant_id from "current_membership"() limit 1; $$;

create function "current_role"() returns text
language sql stable security definer set search_path = public
as $$ select role from "current_membership"() limit 1; $$;

create function "current_shop_ids"() returns uuid[]
language sql stable security definer set search_path = public
as $$ select shop_ids from "current_membership"() limit 1; $$;

create function "has_perm"(p_code text) returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from role_permissions rp
    where rp.role = "current_role"() and rp.code = p_code
  );
$$;

revoke all on function "current_membership"() from public;
revoke all on function "current_tenant_id"() from public;
revoke all on function "current_role"() from public;
revoke all on function "current_shop_ids"() from public;
revoke all on function "has_perm"(text) from public;
grant execute on function "current_membership"() to authenticated;
grant execute on function "current_tenant_id"() to authenticated;
grant execute on function "current_role"() to authenticated;
grant execute on function "current_shop_ids"() to authenticated;
grant execute on function "has_perm"(text) to authenticated;
