-- Phase 1 final hardening: complete device labels and keep owner privilege boundaries server-side.

alter table devices add column if not exists label text;

create or replace function set_device_label(p_id uuid, p_label text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device devices%rowtype;
begin
  select * into v_device
  from devices
  where id = p_id and tenant_id = current_tenant_id();

  if not found then
    raise exception 'device not found';
  end if;

  if v_device.user_id <> auth.uid() and not has_perm('MANAGE_DEVICES') then
    raise exception 'not permitted';
  end if;

  update devices
  set label = nullif(trim(p_label), '')
  where id = p_id;
end;
$$;

revoke all on function set_device_label(uuid, text) from public;
grant execute on function set_device_label(uuid, text) to authenticated;

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

create or replace function set_user_role(p_user_id uuid, p_role text)
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

  if p_role not in ('manager', 'cashier', 'accountant') then
    raise exception 'role must be manager, cashier, or accountant';
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
