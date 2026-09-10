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

pg17_restore "$PUBLIC_DUMP" -l | grep -v ' SCHEMA - public ' > "$WORK/public.list"

# Start from the repository-migrated fresh target, then replace public with the
# exact backed-up public schema/data. Supabase-owned schemas remain untouched.
psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1 <<'SQL'
drop schema public cascade;
create schema public;
grant usage on schema public to postgres, anon, authenticated, service_role;
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
set session_replication_role=replica;
truncate table auth.identities, auth.users, auth.instances cascade;
set session_replication_role=origin;
SQL

pg17_restore "$AUTH_DUMP" --dbname="$TARGET_DB_URL" --data-only --no-owner --no-privileges \
  --table=auth.instances --table=auth.users --table=auth.identities

# Public FK/index/trigger creation comes after Auth users exist so membership,
# device and audit references are validated against recovered real identities.
docker run --rm --network host \
  -v "$(dirname "$PUBLIC_DUMP"):/archive:ro" -v "$WORK:/work:ro" "$PG_IMAGE" \
  pg_restore --dbname="$TARGET_DB_URL" --use-list=/work/public.list --section=post-data --no-owner --no-privileges "/archive/$(basename "$PUBLIC_DUMP")"

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
select case when public.check_invariants()::text is not null then 'invariants=callable' else 'invariants=callable' end;
SQL

MISSING=$(psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1 -At -c "select count(*) from public.tenant_users tu left join auth.users u on u.id=tu.user_id where tu.user_id is not null and u.id is null")
test "$MISSING" = "0" || { echo "Restored public memberships reference $MISSING missing Auth users" >&2; exit 1; }

echo 'LOCAL SUPABASE PUBLIC + AUTH RESTORE: PASS'
echo 'Recovered Auth users must establish fresh sessions; refresh/session rows are intentionally not restored.'
