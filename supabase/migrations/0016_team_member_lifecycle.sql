-- Complete the approved Phase 1 Team UI contract with owner-only member
-- listing/status/removal RPCs. Membership lifecycle is enforced in Postgres;
-- clients never receive direct tenant_users UPDATE/DELETE grants.

-- Even when the access-token hook has populated tenant claims, validate the
-- current database membership on every request. This makes role/status/removal
-- changes effective immediately instead of trusting a stale JWT until expiry.
create or replace function current_membership()
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

  return query
    select tu.tenant_id, tu.role, tu.shop_ids
    from tenant_users tu
    where tu.user_id = auth.uid()
      and tu.status = 'active'
      and tu.deleted_at is null
      and (claim_tenant_id is null or tu.tenant_id = claim_tenant_id)
    limit 1;
end;
$$;

revoke all on function current_membership() from public;
revoke execute on function current_membership() from anon, authenticated;
grant execute on function current_membership() to authenticated;

create or replace function list_tenant_users_admin()
returns table (
  user_id uuid,
  email text,
  display_name text,
  role text,
  status text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if public.current_role() <> 'owner' then
    raise exception 'not permitted';
  end if;

  return query
    select
      tu.user_id,
      u.email::text,
      coalesce(
        nullif(u.raw_user_meta_data ->> 'full_name', ''),
        nullif(u.raw_user_meta_data ->> 'name', '')
      )::text,
      tu.role,
      tu.status
    from tenant_users tu
    join auth.users u on u.id = tu.user_id
    where tu.tenant_id = public.current_tenant_id()
      and tu.deleted_at is null
    order by case when tu.role = 'owner' then 0 else 1 end, u.email nulls last, tu.created_at;
end;
$$;

revoke all on function list_tenant_users_admin() from public;
revoke execute on function list_tenant_users_admin() from anon, authenticated;
grant execute on function list_tenant_users_admin() to authenticated;

create function set_user_status(p_user_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target tenant_users%rowtype;
begin
  if public.current_role() <> 'owner' then
    raise exception 'not permitted';
  end if;
  if p_status not in ('active', 'disabled') then
    raise exception 'invalid status';
  end if;

  select * into v_target
  from tenant_users
  where tenant_id = public.current_tenant_id()
    and user_id = p_user_id
    and deleted_at is null
  for update;

  if not found then
    raise exception 'member not found';
  end if;
  if v_target.role = 'owner' or v_target.user_id = auth.uid() then
    raise exception 'owner status cannot be changed';
  end if;

  update tenant_users
  set status = p_status
  where id = v_target.id;
end;
$$;

revoke all on function set_user_status(uuid, text) from public;
revoke execute on function set_user_status(uuid, text) from anon, authenticated;
grant execute on function set_user_status(uuid, text) to authenticated;

create function remove_tenant_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target tenant_users%rowtype;
begin
  if public.current_role() <> 'owner' then
    raise exception 'not permitted';
  end if;

  select * into v_target
  from tenant_users
  where tenant_id = public.current_tenant_id()
    and user_id = p_user_id
    and deleted_at is null
  for update;

  if not found then
    raise exception 'member not found';
  end if;
  if v_target.role = 'owner' or v_target.user_id = auth.uid() then
    raise exception 'owner cannot be removed';
  end if;

  update tenant_users
  set status = 'disabled',
      deleted_at = (extract(epoch from clock_timestamp()) * 1000)::bigint
  where id = v_target.id;
end;
$$;

revoke all on function remove_tenant_user(uuid) from public;
revoke execute on function remove_tenant_user(uuid) from anon, authenticated;
grant execute on function remove_tenant_user(uuid) to authenticated;

-- Allow a previously removed login to accept a new invite while preserving the
-- soft-deleted membership row/audit history required by the build plan.
create or replace function accept_invite(p_token text, p_client_id text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite invites%rowtype;
  v_existing tenant_users%rowtype;
begin
  select * into v_invite
  from invites
  where token = p_token
    and revoked_at is null
    and accepted_at is null
    and deleted_at is null
    and expires_at > now()
  for update;

  if not found then
    raise exception 'invite invalid, expired, or already used';
  end if;

  select * into v_existing
  from tenant_users
  where user_id = auth.uid()
  for update;

  if found and v_existing.deleted_at is null then
    raise exception 'user already belongs to a tenant';
  end if;

  if found then
    update tenant_users
    set tenant_id = v_invite.tenant_id,
        role = v_invite.role,
        shop_ids = v_invite.shop_ids,
        status = 'active',
        deleted_at = null,
        client_id = p_client_id,
        created_by = auth.uid()
    where id = v_existing.id;
  else
    insert into tenant_users (tenant_id, user_id, role, shop_ids, status, created_by, client_id)
    values (v_invite.tenant_id, auth.uid(), v_invite.role, v_invite.shop_ids, 'active', auth.uid(), p_client_id);
  end if;

  update invites set accepted_at = now() where id = v_invite.id;
  return v_invite.tenant_id;
end;
$$;

revoke all on function accept_invite(text, text) from public;
revoke execute on function accept_invite(text, text) from anon, authenticated;
grant execute on function accept_invite(text, text) to authenticated;
