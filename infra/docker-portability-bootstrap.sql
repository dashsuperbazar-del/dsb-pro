-- DSB Pro local-Postgres compatibility bootstrap.
-- This is ONLY for the Phase 6 provider-portability drill. It does not emulate GoTrue.
do $roles$
begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
  if not exists(select 1 from pg_roles where rolname='supabase_auth_admin') then create role supabase_auth_admin nologin; end if;
end
$roles$;

create schema if not exists auth;
create table if not exists auth.users(
  id uuid primary key
);

create or replace function auth.uid() returns uuid
language sql stable
as $uid$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$uid$;

create or replace function auth.jwt() returns jsonb
language sql stable
as $jwt$
  select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)
$jwt$;
