-- Complete the one-click tenant export with tenant control and idempotency data.
set local search_path = public, pg_temp;

alter function phase6_export_tenant(uuid) rename to phase6_export_tenant_v3_base;
revoke all on function phase6_export_tenant_v3_base(uuid) from public, anon, authenticated;

create function phase6_export_tenant(p_shop_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare
  v_base jsonb;
  v_tenant uuid;
begin
  -- The base function enforces EXPORT_DATA and validates shop membership.
  v_base := phase6_export_tenant_v3_base(p_shop_id);
  v_tenant := (v_base->>'tenantId')::uuid;
  return v_base || jsonb_build_object(
    'invites',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from invites where tenant_id=v_tenant) x),'[]'::jsonb),
    'permissions',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from permissions order by code) x),'[]'::jsonb),
    'rolePermissions',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from role_permissions order by role,code) x),'[]'::jsonb),
    'syncIdempotencyKeys',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from sync_idempotency_keys where tenant_id=v_tenant) x),'[]'::jsonb),
    'schemaMeta',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from schema_meta) x),'[]'::jsonb)
  );
end $$;

revoke all on function phase6_export_tenant(uuid) from public, anon;
grant execute on function phase6_export_tenant(uuid) to authenticated;

do $backup$
begin
  if exists(select 1 from pg_roles where rolname='backup_ro') then
    execute 'grant select on table invites,permissions,role_permissions,sync_idempotency_keys,schema_meta to backup_ro';
  end if;
end
$backup$;
