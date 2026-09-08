-- Phase 1 final privilege boundary: owners cannot be created through member-management RPCs.

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
