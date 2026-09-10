-- Parallel table-isolated pulls must not serialize on a device-row lock for
-- the full duration of every response. Device liveness is persisted by the
-- acknowledgement at the end of a successful cycle.

create or replace function phase5_assert_sync_device(p_device_id text) returns uuid
language plpgsql stable security definer set search_path=public as $$
declare
  v_tenant uuid:=current_tenant_id();
  v_id uuid;
  v_revoked timestamptz;
begin
  if v_tenant is null then raise exception 'not authenticated'; end if;
  if p_device_id is null or btrim(p_device_id)='' then raise exception 'device id required'; end if;
  if not exists(
    select 1 from tenant_users tu
    where tu.tenant_id=v_tenant and tu.user_id=auth.uid() and tu.status='active' and tu.deleted_at is null
  ) then raise exception 'membership inactive'; end if;
  select d.id,d.revoked_at into v_id,v_revoked
  from devices d
  where d.tenant_id=v_tenant and d.user_id=auth.uid() and d.device_id=p_device_id;
  if v_id is null then raise exception 'device not registered'; end if;
  if v_revoked is not null then raise exception 'device revoked'; end if;
  return v_id;
end $$;
revoke all on function phase5_assert_sync_device(text) from public,anon,authenticated;

create or replace function phase5_sync_ack(p_device_id text,p_schema_version integer,p_cursors jsonb) returns void
language plpgsql security definer set search_path=public as $$
declare v_device uuid;
begin
  perform phase5_assert_schema(p_schema_version);
  v_device:=phase5_assert_sync_device(p_device_id);
  if p_cursors is null or jsonb_typeof(p_cursors)<>'object' then raise exception 'sync cursors must be an object'; end if;
  update devices set sync_cursors=p_cursors,schema_version=p_schema_version,last_sync_at=now(),last_seen=now()
  where id=v_device;
end $$;
revoke all on function phase5_sync_ack(text,integer,jsonb) from public,anon;
grant execute on function phase5_sync_ack(text,integer,jsonb) to authenticated;
