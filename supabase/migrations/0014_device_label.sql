-- Adds a human-readable label to devices, needed by the login/signup/invite/
-- device UI spec (docs/superpowers/specs/2026-09-06-login-signup-invite-device-ui-design.md
-- §5): Phase 1 shipped devices with no name/label column, but the UI's
-- "auto-name on register, rename later" behavior needs somewhere to store it.
-- Mirrors revoke_device()'s permission shape exactly (0008_device_rpcs.sql):
-- a device's own user can always act on it; anyone else needs MANAGE_DEVICES.

alter table devices add column label text;

create function set_device_label(p_id uuid, p_label text)
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

  update devices set label = p_label where id = p_id;
end;
$$;

revoke all on function set_device_label(uuid, text) from public;
revoke execute on function set_device_label(uuid, text) from anon, authenticated;
grant execute on function set_device_label(uuid, text) to authenticated;
