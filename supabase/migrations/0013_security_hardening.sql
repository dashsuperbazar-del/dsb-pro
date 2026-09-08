-- Phase 1 security/data-integrity hardening.
-- RPCs are security definer, so validate caller-supplied scope at the database boundary.

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
    select t.id into v_existing_tenant_id
    from tenants t
    where t.created_by = auth.uid() and t.client_id = p_client_id;

    if v_existing_tenant_id is not null then
      return v_existing_tenant_id;
    end if;

    raise exception 'tenant slug already exists';
end;
$$;

revoke all on function create_tenant(text, text, text, text) from public;
grant execute on function create_tenant(text, text, text, text) to authenticated;

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
