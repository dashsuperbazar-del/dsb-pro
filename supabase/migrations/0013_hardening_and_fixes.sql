-- Post-hoc hardening + bug fixes from the final whole-branch review of Phase 1
-- (tenancy/auth/RLS), after all 11 original tasks were done, reviewed, and
-- merged. Forward-only: this migration supersedes buggy function bodies via
-- `create or replace function` rather than editing 0004/0007/0011 in place,
-- and adds plain revoke/grant/index/comment statements for everything else.
-- See docs/HANDOVER.md and this task's SDD report for the full findings list.

-- ============================================================================
-- Fix 4: indexes on every tenant_id column RLS policies filter on.
-- ============================================================================
create index if not exists shops_tenant_id_idx on shops (tenant_id);
create index if not exists tenant_users_tenant_id_idx on tenant_users (tenant_id);
create index if not exists devices_tenant_id_idx on devices (tenant_id);
create index if not exists audit_log_tenant_id_created_at_idx on audit_log (tenant_id, created_at);

-- ============================================================================
-- Fix 1: create_tenant() idempotency must only recover the intended unique
-- constraint. A different tenant's slug collision must remain an error.
-- ============================================================================
create or replace function create_tenant(p_name text, p_slug text, p_shop_name text, p_client_id text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_tenant_id uuid;
  v_tenant_id uuid;
  v_shop_id uuid;
  v_constraint text;
begin
  select t.id into v_existing_tenant_id
  from tenants t
  where t.created_by = auth.uid() and t.client_id = p_client_id;

  if v_existing_tenant_id is not null then
    return v_existing_tenant_id;
  end if;

  if exists (select 1 from tenant_users where user_id = auth.uid()) then
    raise exception 'user already belongs to a tenant';
  end if;

  insert into tenants (name, slug, client_id)
  values (p_name, p_slug, p_client_id)
  returning id into v_tenant_id;

  insert into shops (tenant_id, name, is_default)
  values (v_tenant_id, p_shop_name, true)
  returning id into v_shop_id;

  insert into tenant_users (tenant_id, user_id, role, shop_ids, status)
  values (v_tenant_id, auth.uid(), 'owner', array[v_shop_id], 'active');

  return v_tenant_id;
exception
  when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint is distinct from 'tenants_created_by_client_id_key' then
      raise;
    end if;

    select t.id into v_tenant_id
    from tenants t
    where t.created_by = auth.uid() and t.client_id = p_client_id;

    if v_tenant_id is null then
      raise;
    end if;

    return v_tenant_id;
end;
$$;

-- ============================================================================
-- Fix 2: accept_invite() must serialize single-use redemption.
-- ============================================================================
create or replace function accept_invite(p_token text, p_client_id text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite invites%rowtype;
begin
  if exists (select 1 from tenant_users where user_id = auth.uid()) then
    raise exception 'user already belongs to a tenant';
  end if;

  select * into v_invite from invites
  where token = p_token
    and revoked_at is null
    and accepted_at is null
    and expires_at > now()
  for update;

  if not found then
    raise exception 'invite invalid, expired, or already used';
  end if;

  insert into tenant_users (tenant_id, user_id, role, shop_ids, status, client_id)
  values (v_invite.tenant_id, auth.uid(), v_invite.role, v_invite.shop_ids, 'active', p_client_id);

  update invites set accepted_at = now() where id = v_invite.id;

  return v_invite.tenant_id;
end;
$$;

-- ============================================================================
-- Fix 3: trigger/hook hardening and deliberate function EXECUTE grants.
-- ============================================================================
create or replace function set_updated_at() returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  return new;
end;
$$;

create or replace function custom_access_token_hook(event jsonb)
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

  v_claims := coalesce(event->'claims', '{}'::jsonb);

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

revoke execute on function set_updated_at() from anon, authenticated;
revoke execute on function "current_membership"() from anon, authenticated;
grant execute on function "current_membership"() to authenticated;
revoke execute on function "current_tenant_id"() from anon, authenticated;
grant execute on function "current_tenant_id"() to authenticated;
revoke execute on function "current_role"() from anon, authenticated;
grant execute on function "current_role"() to authenticated;
revoke execute on function "current_shop_ids"() from anon, authenticated;
grant execute on function "current_shop_ids"() to authenticated;
revoke execute on function "has_perm"(text) from anon, authenticated;
grant execute on function "has_perm"(text) to authenticated;
revoke execute on function create_tenant(text, text, text, text) from anon, authenticated;
grant execute on function create_tenant(text, text, text, text) to authenticated;
revoke execute on function create_invite(text, uuid[]) from anon, authenticated;
grant execute on function create_invite(text, uuid[]) to authenticated;
revoke execute on function revoke_invite(uuid) from anon, authenticated;
grant execute on function revoke_invite(uuid) to authenticated;
revoke execute on function accept_invite(text, text) from anon, authenticated;
grant execute on function accept_invite(text, text) to authenticated;
revoke execute on function set_user_role(uuid, text) from anon, authenticated;
grant execute on function set_user_role(uuid, text) to authenticated;
revoke execute on function register_device(text, text) from anon, authenticated;
grant execute on function register_device(text, text) to authenticated;
revoke execute on function revoke_device(uuid) from anon, authenticated;
grant execute on function revoke_device(uuid) to authenticated;
revoke execute on function audit_row_change() from anon, authenticated;
revoke execute on function next_doc_no(uuid, text) from anon, authenticated;
grant execute on function next_doc_no(uuid, text) to authenticated;
revoke execute on function custom_access_token_hook(jsonb) from anon, authenticated;
grant usage on schema public to supabase_auth_admin;

comment on function "current_role"() is
  'Name collides with the reserved SQL keyword / role-inspection built-in; must be double-quoted at every definition and call site.';
comment on function next_doc_no(uuid, text) is
  'Caller should verify p_shop_id belongs to the caller tenant; future phases should enforce this at the function boundary.';

-- ============================================================================
-- create_invite() must validate caller role and every requested shop against
-- the current tenant at the security-definer RPC boundary.
-- ============================================================================
create or replace function create_invite(p_role text, p_shop_ids uuid[])
returns table (id uuid, token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := current_tenant_id();
  v_id uuid;
  v_token text;
  v_expires_at timestamptz := now() + interval '7 days';
begin
  if v_tenant_id is null or not has_perm('MANAGE_INVITES') then
    raise exception 'not permitted';
  end if;

  if p_role not in ('manager', 'cashier', 'accountant') then
    raise exception 'invite role must be manager, cashier, or accountant';
  end if;

  if exists (
    select 1
    from unnest(coalesce(p_shop_ids, '{}'::uuid[])) as requested_shop_id
    where requested_shop_id is null
       or not exists (
         select 1 from shops s
         where s.id = requested_shop_id
           and s.tenant_id = v_tenant_id
       )
  ) then
    raise exception 'one or more shops are not in the current tenant';
  end if;

  v_token := encode(extensions.gen_random_bytes(16), 'hex');

  insert into invites (tenant_id, role, shop_ids, token, expires_at)
  values (v_tenant_id, p_role, p_shop_ids, v_token, v_expires_at)
  returning invites.id into v_id;

  return query select v_id, v_token, v_expires_at;
end;
$$;

revoke all on function create_invite(text, uuid[]) from public;
grant execute on function create_invite(text, uuid[]) to authenticated;
