-- Tenant/invite/membership lifecycle RPCs. See spec §6. All security definer,
-- all recompute/validate server-side per CLAUDE.md's "Privileged ops via
-- Postgres RPC" rule. tenant_users has no direct client insert/update grant at
-- all (0004) — these RPCs are the only way in.

create policy invites_select_own on invites for select
  using (tenant_id = current_tenant_id() and has_perm('MANAGE_INVITES'));

create function create_tenant(p_name text, p_slug text, p_shop_name text, p_client_id text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_tenant_id uuid;
  v_tenant_id uuid;
  v_shop_id uuid;
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
    select t.id into v_tenant_id
    from tenants t
    where t.created_by = auth.uid() and t.client_id = p_client_id;
    return v_tenant_id;
end;
$$;

revoke all on function create_tenant(text, text, text, text) from public;
grant execute on function create_tenant(text, text, text, text) to authenticated;

create function create_invite(p_role text, p_shop_ids uuid[])
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

  -- pgcrypto lives in the "extensions" schema on this project (see \dx), not
  -- public, so it must be schema-qualified under this function's
  -- search_path = public.
  v_token := encode(extensions.gen_random_bytes(16), 'hex');

  insert into invites (tenant_id, role, shop_ids, token, expires_at)
  values (v_tenant_id, p_role, p_shop_ids, v_token, v_expires_at)
  returning invites.id into v_id;

  return query select v_id, v_token, v_expires_at;
end;
$$;

revoke all on function create_invite(text, uuid[]) from public;
grant execute on function create_invite(text, uuid[]) to authenticated;

create function revoke_invite(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_tenant_id() is null or not has_perm('MANAGE_INVITES') then
    raise exception 'not permitted';
  end if;

  update invites set revoked_at = now()
  where id = p_id and tenant_id = current_tenant_id() and revoked_at is null and accepted_at is null;

  if not found then
    raise exception 'invite not found or already used/revoked';
  end if;
end;
$$;

revoke all on function revoke_invite(uuid) from public;
grant execute on function revoke_invite(uuid) to authenticated;

create function accept_invite(p_token text, p_client_id text)
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
    and expires_at > now();

  if not found then
    raise exception 'invite invalid, expired, or already used';
  end if;

  insert into tenant_users (tenant_id, user_id, role, shop_ids, status, client_id)
  values (v_invite.tenant_id, auth.uid(), v_invite.role, v_invite.shop_ids, 'active', p_client_id);

  update invites set accepted_at = now() where id = v_invite.id;

  return v_invite.tenant_id;
end;
$$;

revoke all on function accept_invite(text, text) from public;
grant execute on function accept_invite(text, text) to authenticated;

create function set_user_role(p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id = auth.uid() then
    raise exception 'cannot change your own role';
  end if;

  if current_tenant_id() is null or not has_perm('MANAGE_TENANT_USERS') then
    raise exception 'not permitted';
  end if;

  update tenant_users set role = p_role
  where user_id = p_user_id and tenant_id = current_tenant_id();

  if not found then
    raise exception 'user not found in this tenant';
  end if;
end;
$$;

revoke all on function set_user_role(uuid, text) from public;
grant execute on function set_user_role(uuid, text) to authenticated;
