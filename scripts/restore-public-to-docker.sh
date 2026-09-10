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

for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U postgres -d "$DB" >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$NAME" pg_isready -U postgres -d "$DB" >/dev/null

docker cp "$ROOT/infra/docker-portability-bootstrap.sql" "$NAME:/bootstrap.sql"
docker cp "$DUMP" "$NAME:/public.pgcustom"
docker exec "$NAME" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -f /bootstrap.sql

# Custom archives place FK creation in post-data. Load schema and rows first,
# then synthesize placeholder auth IDs from the public membership/device rows,
# and only then install FKs/indexes/triggers.
docker exec "$NAME" pg_restore -U postgres -d "$DB" --section=pre-data --no-owner --no-privileges /public.pgcustom
docker exec "$NAME" pg_restore -U postgres -d "$DB" --section=data --no-owner --no-privileges /public.pgcustom
docker exec "$NAME" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
insert into auth.users(id)
select distinct user_id from tenant_users where user_id is not null
union
select distinct user_id from devices where user_id is not null
on conflict do nothing;
SQL
docker exec "$NAME" pg_restore -U postgres -d "$DB" --section=post-data --no-owner --no-privileges /public.pgcustom

docker exec "$NAME" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -At <<'SQL'
select 'tenants='||count(*) from tenants;
select 'shops='||count(*) from shops;
select 'sales='||count(*)||',total='||coalesce(sum(total_paise),0) from sale_invoices where status='FINALIZED';
select 'payments='||count(*)||',total='||coalesce(sum(amount_paise),0) from payments where status='POSTED';
select 'purchases='||count(*)||',total='||coalesce(sum(total_paise),0) from purchase_bills where status='POSTED';
select 'stock_movements='||count(*) from stock_movements;
select 'expenses='||count(*)||',total='||coalesce(sum(amount_paise),0) from expenses where status='POSTED';
SQL

echo "PORTABLE PUBLIC RESTORE: PASS"
echo "Container was temporary and is removed automatically. Set KEEP_CONTAINER=1 is intentionally unsupported: drills should be disposable."
