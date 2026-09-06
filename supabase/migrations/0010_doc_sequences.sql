-- See spec §4. Server-only counter table: no client_id/deleted_at/updated_at
-- (not client-originated, not soft-deleted) — same approved-exception style as
-- schema_meta/backup_runs/audit_log.

create table doc_sequences (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  shop_id uuid not null references shops(id),
  series text not null,
  next_no bigint not null default 0,
  unique (tenant_id, shop_id, series)
);

alter table doc_sequences enable row level security;
-- No grants, no policies: only next_doc_no() (security definer) touches this
-- table.

create function next_doc_no(p_shop_id uuid, p_series text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := current_tenant_id();
  v_next bigint;
begin
  if v_tenant_id is null then
    raise exception 'user has no tenant';
  end if;

  insert into doc_sequences (tenant_id, shop_id, series, next_no)
  values (v_tenant_id, p_shop_id, p_series, 0)
  on conflict (tenant_id, shop_id, series) do nothing;

  -- A single UPDATE both locks the row and increments it atomically — no
  -- separate SELECT ... FOR UPDATE needed.
  update doc_sequences
  set next_no = next_no + 1
  where tenant_id = v_tenant_id and shop_id = p_shop_id and series = p_series
  returning next_no into v_next;

  return v_next;
end;
$$;

revoke all on function next_doc_no(uuid, text) from public;
grant execute on function next_doc_no(uuid, text) to authenticated;
