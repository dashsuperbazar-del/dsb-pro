-- Device registration/revocation. See spec §5-§6. revoked_at is audit-only this
-- phase — nothing yet checks it against incoming requests (no per-request
-- device identity until Phase 5's sync layer).

grant insert on devices to authenticated;

create policy devices_insert_own on devices for insert
  with check (user_id = auth.uid() and tenant_id = current_tenant_id());

create function register_device(p_device_id text, p_app_version text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := current_tenant_id();
  v_id uuid;
begin
  if v_tenant_id is null then
    raise exception 'user has no tenant';
  end if;

  insert into devices (tenant_id, user_id, device_id, app_version, last_seen)
  values (v_tenant_id, auth.uid(), p_device_id, p_app_version, now())
  on conflict (tenant_id, user_id, device_id)
  do update set last_seen = now(), app_version = excluded.app_version
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function register_device(text, text) from public;
grant execute on function register_device(text, text) to authenticated;

create function revoke_device(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device devices%rowtype;
begin
  select * into v_device from devices
  where id = p_id and tenant_id = current_tenant_id();

  if not found then
    raise exception 'device not found';
  end if;

  if v_device.user_id <> auth.uid() and not has_perm('MANAGE_DEVICES') then
    raise exception 'not permitted';
  end if;

  update devices set revoked_at = now() where id = p_id;
end;
$$;

revoke all on function revoke_device(uuid) from public;
grant execute on function revoke_device(uuid) to authenticated;
