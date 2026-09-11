#!/usr/bin/env bash
set -euo pipefail

PUBLIC_DUMP="${1:?public custom-format dump required}"
AUTH_DUMP="${2:?auth custom-format dump required}"
TARGET_DB_URL="${3:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
PG_IMAGE="${POSTGRES_IMAGE:-postgres:17}"

for f in "$PUBLIC_DUMP" "$AUTH_DUMP"; do
  test -f "$f" || { echo "Dump not found: $f" >&2; exit 1; }
done

PUBLIC_DUMP="$(cd "$(dirname "$PUBLIC_DUMP")" && pwd)/$(basename "$PUBLIC_DUMP")"
AUTH_DUMP="$(cd "$(dirname "$AUTH_DUMP")" && pwd)/$(basename "$AUTH_DUMP")"
WORK="$(mktemp -d)"
cleanup(){ rm -rf "$WORK"; }
trap cleanup EXIT

# Custom-format archives created by PostgreSQL 17 require a PostgreSQL 17+
# pg_restore. GitHub's Ubuntu host client may lag the server/archive version,
# so every archive operation deliberately uses the same postgres:17 image as
# the backup workflow. --network host lets that client reach local Supabase on
# 127.0.0.1:54322 without changing the target connection string.
pg17_restore(){
  local dump="$1"; shift
  docker run --rm --network host -v "$(dirname "$dump"):/archive:ro" "$PG_IMAGE" \
    pg_restore "$@" "/archive/$(basename "$dump")"
}

# Supabase owns its platform-wide default ACLs. A restored local postgres role
# cannot ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin, and those defaults
# are not application state. Keep every per-object ACL (needed for login/RLS)
# while excluding only the schema creation entry and platform default ACLs.
pg17_restore "$PUBLIC_DUMP" -l | grep -v -E ' SCHEMA - public | DEFAULT ACL ' > "$WORK/public.list"

# Select Auth rows through the archive TOC rather than pg_restore --table
# patterns. The latter proved fragile for schema-qualified names in CI and
# silently selected zero user rows. These are the durable identity records
# needed to preserve user IDs, password hashes and provider identities.
pg17_restore "$AUTH_DUMP" -l | grep -E ' TABLE DATA auth (instances|users|identities) ' > "$WORK/auth.list"
grep -q ' TABLE DATA auth users ' "$WORK/auth.list" || { echo 'Auth archive has no users TABLE DATA entry' >&2; exit 1; }
grep -q ' TABLE DATA auth identities ' "$WORK/auth.list" || { echo 'Auth archive has no identities TABLE DATA entry' >&2; exit 1; }

# Start from the repository-migrated fresh target, then replace public with the
# exact backed-up public schema/data. Supabase-owned schemas remain untouched.
psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1 <<'SQL'
drop schema public cascade;
create schema public;
grant usage on schema public to postgres, anon, authenticated, service_role;
do $$begin if not exists(select 1 from pg_roles where rolname='backup_ro') then create role backup_ro nologin; end if; end$$;
SQL

# The use-list file is mounted separately because it lives in the temporary
# work directory rather than beside the archive.
docker run --rm --network host \
  -v "$(dirname "$PUBLIC_DUMP"):/archive:ro" -v "$WORK:/work:ro" "$PG_IMAGE" \
  pg_restore --dbname="$TARGET_DB_URL" --use-list=/work/public.list --section=pre-data --no-owner --no-privileges "/archive/$(basename "$PUBLIC_DUMP")"
docker run --rm --network host \
  -v "$(dirname "$PUBLIC_DUMP"):/archive:ro" -v "$WORK:/work:ro" "$PG_IMAGE" \
  pg_restore --dbname="$TARGET_DB_URL" --use-list=/work/public.list --section=data --no-owner --no-privileges "/archive/$(basename "$PUBLIC_DUMP")"

# Restore durable authentication identity required for account recovery from
# the separate Auth artifact. Sessions/refresh tokens are intentionally not
# resurrected; recovered users establish fresh sessions after a DR event.
psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1 <<'SQL'
create table public._auth_recovery_target_instance (like auth.instances including all);
insert into public._auth_recovery_target_instance select * from auth.instances;
set session_replication_role=replica;
truncate table auth.identities, auth.users, auth.instances cascade;
set session_replication_role=origin;
SQL

docker run --rm --network host \
  -v "$(dirname "$AUTH_DUMP"):/archive:ro" -v "$WORK:/work:ro" "$PG_IMAGE" \
  pg_restore --dbname="$TARGET_DB_URL" --use-list=/work/auth.list --data-only --no-owner --no-privileges "/archive/$(basename "$AUTH_DUMP")"

# auth.instances describes the running GoTrue deployment, not a user account.
# Keep the fresh target's instance row and attach recovered users to it; copying
# the hosted source instance makes the local GoTrue admin and token APIs reject
# otherwise valid restored identities with HTTP 403.
psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1 <<'SQL'
do $$begin
  if not exists(select 1 from public._auth_recovery_target_instance) then
    raise exception 'Fresh Supabase target has no Auth instance row';
  end if;
end$$;
set session_replication_role=replica;
update auth.users
set instance_id=(select id from public._auth_recovery_target_instance order by created_at,id limit 1);
delete from auth.instances;
insert into auth.instances select * from public._auth_recovery_target_instance;
set session_replication_role=origin;
drop table public._auth_recovery_target_instance;
SQL

# Fail before adding public foreign keys if the Auth recovery selected no users.
# This prevents a misleading later FK error from hiding the actual Auth problem.
AUTH_USERS=$(psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1 -At -c 'select count(*) from auth.users')
AUTH_IDENTITIES=$(psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1 -At -c 'select count(*) from auth.identities')
test "$AUTH_USERS" -gt 0 || { echo 'Auth restore produced zero users' >&2; exit 1; }
test "$AUTH_IDENTITIES" -gt 0 || { echo 'Auth restore produced zero identities' >&2; exit 1; }

# Public FK/index/trigger creation comes after Auth users exist so membership,
# device and audit references are validated against recovered real identities.
docker run --rm --network host \
  -v "$(dirname "$PUBLIC_DUMP"):/archive:ro" -v "$WORK:/work:ro" "$PG_IMAGE" \
  pg_restore --dbname="$TARGET_DB_URL" --use-list=/work/public.list --section=post-data --no-owner "/archive/$(basename "$PUBLIC_DUMP")"

# Run the authenticated invariant function once per restored tenant. A direct
# postgres call without tenant claims previously proved only that the function
# existed (and printed PASS in both branches), not that restored data was valid.
psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1 <<'SQL'
do $verify$
declare r record; v_result jsonb;
begin
 for r in
   select distinct on (tu.tenant_id) tu.tenant_id,tu.user_id
   from public.tenant_users tu
   where tu.status='active' and tu.deleted_at is null
   order by tu.tenant_id,(tu.role='owner') desc,tu.created_at
 loop
   perform set_config('request.jwt.claims',jsonb_build_object(
     'sub',r.user_id,'role','authenticated','tenant_id',r.tenant_id,'app_role','owner','shop_ids','[]'::jsonb
   )::text,true);
   v_result:=public.check_invariants();
   if not coalesce((v_result->>'ok')::boolean,false) then
     raise exception 'restored invariant failure for tenant %: %',r.tenant_id,v_result;
   end if;
 end loop;
end $verify$;
SQL

psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1 -At <<'SQL'
select 'auth_users='||count(*) from auth.users;
select 'auth_identities='||count(*) from auth.identities;
select 'tenant_users='||count(*) from public.tenant_users;
select 'missing_membership_users='||count(*)
from public.tenant_users tu left join auth.users u on u.id=tu.user_id
where tu.user_id is not null and u.id is null;
select 'sales='||count(*)||',total='||coalesce(sum(total_paise),0) from public.sale_invoices where status='FINALIZED';
select 'payments='||count(*)||',total='||coalesce(sum(amount_paise),0) from public.payments where status='POSTED';
select 'purchases='||count(*)||',total='||coalesce(sum(total_paise),0) from public.purchase_bills where status='POSTED';
select 'stock_movements='||count(*) from public.stock_movements;
select 'expenses='||count(*)||',total='||coalesce(sum(amount_paise),0) from public.expenses where status='POSTED';
select 'invariants=pass';
SQL

MISSING=$(psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1 -At -c "select count(*) from public.tenant_users tu left join auth.users u on u.id=tu.user_id where tu.user_id is not null and u.id is null")
test "$MISSING" = "0" || { echo "Restored public memberships reference $MISSING missing Auth users" >&2; exit 1; }

echo 'LOCAL SUPABASE PUBLIC + AUTH RESTORE: PASS'
echo 'Recovered Auth users must establish fresh sessions; refresh/session rows are intentionally not restored.'

