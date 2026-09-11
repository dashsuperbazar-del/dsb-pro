#!/usr/bin/env bash
set -euo pipefail

# Restore a decrypted DSB Pro PUBLIC custom-format dump into vanilla Postgres 17.
# Usage: ./scripts/restore-public-to-docker.sh /path/to/public.pgcustom [container-name]
DUMP="${1:?decrypted public .pgcustom path required}"
NAME="${2:-dsb-pro-drill}"
IMAGE="${POSTGRES_IMAGE:-postgres:17}"
DB="${POSTGRES_DB:-dsbpro_drill}"
PASSWORD="${POSTGRES_PASSWORD:-drill-only-password}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

test -f "$DUMP" || { echo "Dump not found: $DUMP" >&2; exit 1; }
DUMP="$(cd "$(dirname "$DUMP")" && pwd)/$(basename "$DUMP")"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB="$DB" -p 127.0.0.1::5432 "$IMAGE" >/dev/null

cleanup(){ docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

stable_ready=0
for _ in $(seq 1 90); do
  # The official image briefly accepts connections through its temporary init
  # server before restarting into the final server. Require three consecutive
  # SQL successes so a restore cannot race that restart.
  if docker exec "$NAME" psql -U postgres -d "$DB" -Atqc 'select 1' >/dev/null 2>&1; then
    stable_ready=$((stable_ready+1))
    if [ "$stable_ready" -ge 3 ]; then break; fi
  else
    stable_ready=0
  fi
  sleep 1
done
test "$stable_ready" -ge 3 || { docker logs "$NAME" >&2; echo 'PostgreSQL did not become stably ready' >&2; exit 1; }

docker cp "$ROOT/infra/docker-portability-bootstrap.sql" "$NAME:/bootstrap.sql"
docker cp "$DUMP" "$NAME:/public.pgcustom"
docker exec "$NAME" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -f /bootstrap.sql

# PostgreSQL creates schema public in every fresh database. A pg_dump --schema=public
# archive also carries a CREATE SCHEMA public TOC entry, so exclude only that one
# entry rather than accepting an ignored restore error. Everything inside public
# (tables, functions, data, indexes, constraints and triggers) remains selected.
docker exec "$NAME" sh -c "pg_restore -l /public.pgcustom | grep -v ' SCHEMA - public ' > /restore.list"

# Custom archives place FK creation in post-data. Load schema and rows first,
# then synthesize placeholder auth IDs from the public membership/device rows,
# and only then install FKs/indexes/triggers.
docker exec "$NAME" pg_restore -U postgres -d "$DB" --use-list=/restore.list --section=pre-data --no-owner --no-privileges /public.pgcustom
docker exec "$NAME" pg_restore -U postgres -d "$DB" --use-list=/restore.list --section=data --no-owner --no-privileges /public.pgcustom
docker exec -i "$NAME" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
insert into auth.users(id)
select distinct user_id from tenant_users where user_id is not null
union
select distinct user_id from devices where user_id is not null
on conflict do nothing;
SQL
docker exec "$NAME" pg_restore -U postgres -d "$DB" --use-list=/restore.list --section=post-data --no-owner --no-privileges /public.pgcustom

if [ -n "${POST_RESTORE_SQL:-}" ]; then
  test -f "$POST_RESTORE_SQL" || { echo "Post-restore SQL not found: $POST_RESTORE_SQL" >&2; exit 1; }
  docker cp "$POST_RESTORE_SQL" "$NAME:/post-restore.sql"
  docker exec "$NAME" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -f /post-restore.sql
fi

if [ -n "${ROUNDTRIP_DUMP:-}" ]; then
  docker exec "$NAME" pg_dump -U postgres -d "$DB" --format=custom --schema=public > "$ROUNDTRIP_DUMP"
  test "$(stat -c%s "$ROUNDTRIP_DUMP")" -ge 1000
fi

docker exec -i "$NAME" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -At <<'SQL'
select 'tenants='||count(*) from tenants;
select 'shops='||count(*) from shops;
select 'sales='||count(*)||',total='||coalesce(sum(total_paise),0) from sale_invoices where status='FINALIZED';
select 'payments='||count(*)||',total='||coalesce(sum(amount_paise),0) from payments where status='POSTED';
select 'purchases='||count(*)||',total='||coalesce(sum(total_paise),0) from purchase_bills where status='POSTED';
select 'stock_movements='||count(*) from stock_movements;
select 'expenses='||count(*)||',total='||coalesce(sum(amount_paise),0) from expenses where status='POSTED';
select 'fixture_sales='||count(*) from sale_invoices where id='f6000000-0000-0000-0000-000000000005';
select 'fixture_payments='||count(*) from payments where id='f6000000-0000-0000-0000-000000000007';
select 'fixture_purchases='||count(*) from purchase_bills where id='f6000000-0000-0000-0000-000000000003';
select 'fixture_stock_movements='||count(*) from stock_movements where id in ('f6000000-0000-0000-0000-000000000009','f6000000-0000-0000-0000-00000000000a');
select 'fixture_expenses='||count(*) from expenses where id='f6000000-0000-0000-0000-000000000008';
SQL

echo "PORTABLE PUBLIC RESTORE: PASS"
echo "Container was temporary and is removed automatically. Set KEEP_CONTAINER=1 is intentionally unsupported: drills should be disposable."
