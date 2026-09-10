#!/usr/bin/env bash
set -euo pipefail

PUBLIC_DUMP="${1:?public custom-format dump required}"
AUTH_DUMP="${2:?auth custom-format dump required}"
TARGET_DB_URL="${3:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

for f in "$PUBLIC_DUMP" "$AUTH_DUMP"; do
  test -f "$f" || { echo "Dump not found: $f" >&2; exit 1; }
done

WORK="$(mktemp -d)"
cleanup(){ rm -rf "$WORK"; }
trap cleanup EXIT

# A fresh Supabase stack already owns schema public. Restore all DSB Pro public
# objects while excluding only the archive's CREATE SCHEMA public entry.
pg_restore -l "$PUBLIC_DUMP" | grep -v ' SCHEMA - public ' > "$WORK/public.list"

# Start from the repository-migrated fresh target, then replace public with the
# exact backed-up public schema/data. Supabase-owned schemas remain untouched.
psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1 <<'SQL'
drop schema public cascade;
create schema public;
grant usage on schema public to postgres, anon, authenticated, service_role;
SQL

pg_restore --dbname="$TARGET_DB_URL" --use-list="$WORK/public.list" --section=pre-data --no-owner --no-privileges "$PUBLIC_DUMP"
pg_restore --dbname="$TARGET_DB_URL" --use-list="$WORK/public.list" --section=data --no-owner --no-privileges "$PUBLIC_DUMP"

# Restore the durable authentication identity needed for account recovery from
# the separately encrypted full Auth artifact. Sessions/refresh tokens are not
# deliberately resurrected: recovered users must sign in again after a DR event.
# Password hashes live on auth.users; provider/email identity lives on
# auth.identities; users may reference auth.instances.
psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1 <<'SQL'
set session_replication_role=replica;
truncate table auth.identities, auth.users, auth.instances cascade;
set session_replication_role=origin;
SQL

pg_restore --dbname="$TARGET_DB_URL" --data-only --no-owner --no-privileges \
  --table=auth.instances --table=auth.users --table=auth.identities "$AUTH_DUMP"

# Public FK/index/trigger creation comes after Auth users exist, so membership,
# device and audit user references are validated by PostgreSQL rather than
# papered over with placeholder identities.
pg_restore --dbname="$TARGET_DB_URL" --use-list="$WORK/public.list" --section=post-data --no-owner --no-privileges "$PUBLIC_DUMP"

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
