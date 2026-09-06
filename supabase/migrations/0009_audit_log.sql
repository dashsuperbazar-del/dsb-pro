-- Append-only audit trail. See spec §4/§6.
-- Approved exception to "every table gets full standard columns": this is a
-- control/log table like Phase 0's schema_meta/backup_runs — insert-only, never
-- updated or deleted by anyone, so it skips client_id/deleted_at/updated_at.
-- tenant_id is added beyond §7.4's literal column list because RLS needs it for
-- per-tenant isolation.

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  user_id uuid,
  device_id uuid,
  table_name text not null,
  row_id uuid not null,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);

alter table audit_log enable row level security;
grant select on audit_log to authenticated;

create policy audit_log_select_own on audit_log for select
  using (tenant_id = current_tenant_id() and has_perm('VIEW_AUDIT_LOG'));
-- No insert/update/delete grants: only audit_row_change() (below, security
-- definer) writes this table.

create function audit_row_change() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row_id uuid := coalesce((to_jsonb(new)->>'id')::uuid, (to_jsonb(old)->>'id')::uuid);
  v_tenant_id uuid;
begin
  if TG_TABLE_NAME = 'tenants' then
    v_tenant_id := v_row_id;
  else
    v_tenant_id := coalesce(
      (to_jsonb(new)->>'tenant_id')::uuid,
      (to_jsonb(old)->>'tenant_id')::uuid
    );
  end if;

  insert into audit_log (tenant_id, user_id, table_name, row_id, action, before, after)
  values (
    v_tenant_id,
    auth.uid(),
    TG_TABLE_NAME,
    v_row_id,
    TG_OP,
    case when TG_OP = 'INSERT' then null else to_jsonb(old) end,
    case when TG_OP = 'DELETE' then null else to_jsonb(new) end
  );

  return coalesce(new, old);
end;
$$;

create trigger audit_tenants after insert or update or delete on tenants
  for each row execute function audit_row_change();
create trigger audit_shops after insert or update or delete on shops
  for each row execute function audit_row_change();
create trigger audit_tenant_users after insert or update or delete on tenant_users
  for each row execute function audit_row_change();
create trigger audit_invites after insert or update or delete on invites
  for each row execute function audit_row_change();
create trigger audit_devices after insert or update or delete on devices
  for each row execute function audit_row_change();
