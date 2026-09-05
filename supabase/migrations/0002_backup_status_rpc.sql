-- Narrow, non-sensitive read path onto backup_runs for apps/admin's health panel.
-- backup_runs itself stays fully locked down by RLS (0001_init.sql — anon and
-- authenticated hold the table's SELECT grant, but RLS has no policies, so a
-- direct query returns nothing); this function is security definer, so it
-- runs as its owner (the table owner), who is exempt from RLS by default and
-- can read the real rows. Returns only operational metadata — never `error`
-- or `manifest`, which could carry more detail than we want exposed pre-auth
-- (Phase 1 adds real auth).
create function get_latest_backup_status()
returns table (
  status text,
  finished_at timestamptz,
  destinations jsonb,
  app_version text,
  schema_version integer
)
language sql
security definer
set search_path = public
stable
as $$
  select status, finished_at, destinations, app_version, schema_version
  from backup_runs
  order by created_at desc
  limit 1;
$$;

revoke all on function get_latest_backup_status() from public;
grant execute on function get_latest_backup_status() to anon, authenticated;
