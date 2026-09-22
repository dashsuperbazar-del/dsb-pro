#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <database-url>" >&2
  exit 2
fi

database_url=$1
base_ok=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c \
  "select to_regclass('public.sync_conflicts') is not null and to_regprocedure('public.phase5_sync_pull(text,uuid,integer,jsonb)') is not null and to_regprocedure('public.phase5_sync_post_sale(text,integer,uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text)') is not null;")
[[ "$base_ok" == "t" ]] || { echo 'Database is not at verified Phase 5; refusing Phase 6 migration.' >&2; exit 1; }

read -r foundation hardening phase65 batcha batchb <<<"$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -F' ' <<'SQL'
with foundation(present) as (
  values
    (to_regclass('public.expenses') is not null),
    (to_regclass('public.stock_counts') is not null),
    (to_regprocedure('public.get_day_book(uuid,date,date)') is not null),
    (to_regprocedure('public.phase6_export_tenant(uuid)') is not null),
    (to_regprocedure('public.check_invariants()') is not null)
), hardening(present) as (
  values
    (to_regprocedure('public.phase6_assert_report_access()') is not null),
    (to_regprocedure('public.phase6_export_tenant_v3_base(uuid)') is not null)
), phase65(present) as (
  values
    (to_regclass('public.sale_returns') is not null),
    (to_regprocedure('public.phase65_sync_post_return(text,integer,text,uuid,date,text,jsonb,text)') is not null),
    (exists(select 1 from information_schema.columns where table_schema='public' and table_name='shops' and column_name='gstin')),
    (exists(select 1 from information_schema.columns where table_schema='public' and table_name='shops' and column_name='allow_negative_stock')),
    (to_regprocedure('public.get_low_stock_report(uuid)') is not null)
), batcha(present) as (
  values
    (regexp_replace(pg_get_functiondef('public.phase5_sync_pull(text,uuid,integer,jsonb)'::regprocedure), E'\\s+', '', 'g')
      like '%(v_can_view_cost_pricesorp.kind<>''cost_last'')%'),
    (regexp_replace(pg_get_functiondef('public.apply_stock_movement()'::regprocedure), E'\\s+', '', 'g')
      like '%ifnew.qty_base<=0andv_on_hand<v_reservedthen%')
), batchb(present) as (
  values
    (to_regprocedure('public.phase65_assert_quantity_lines(jsonb)') is not null),
    (regexp_replace(pg_get_functiondef('public.phase5_sync_post_sale(text,integer,uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text)'::regprocedure), E'\\s+', '', 'g')
      like '%atmost6places%'),
    (regexp_replace(pg_get_functiondef('public.phase5_sync_post_sale(text,integer,uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text)'::regprocedure), E'\\s+', '', 'g')
      like '%''intentFingerprint'',v_intent_fingerprint%')
)
select
  (select count(*) from foundation where present),
  (select count(*) from hardening where present),
  (select count(*) from phase65 where present),
  (select count(*) from batcha where present),
  (select count(*) from batchb where present);
SQL
)"

emit_state() {
  local needs_foundation=$1 needs_hardening=$2 needs_phase65=$3 needs_batcha=$4 needs_batchb=$5
  local needs_upgrade=true
  if [[ "$needs_foundation:$needs_hardening:$needs_phase65:$needs_batcha:$needs_batchb" == "false:false:false:false:false" ]]; then
    needs_upgrade=false
  fi
  printf 'observed_state=%s:%s:%s:%s:%s\n' "$foundation" "$hardening" "$phase65" "$batcha" "$batchb"
  printf 'needs_upgrade=%s\n' "$needs_upgrade"
  printf 'needs_foundation=%s\n' "$needs_foundation"
  printf 'needs_hardening=%s\n' "$needs_hardening"
  printf 'needs_phase65=%s\n' "$needs_phase65"
  printf 'needs_batcha=%s\n' "$needs_batcha"
  printf 'needs_batchb=%s\n' "$needs_batchb"
}

case "$foundation:$hardening:$phase65:$batcha:$batchb" in
  0:0:0:0:0) emit_state true true true true true ;;
  5:0:0:0:0) emit_state false true true true true ;;
  5:2:0:0:0) emit_state false false true true true ;;
  5:2:5:0:0) emit_state false false false true true ;;
  5:2:5:2:0) emit_state false false false false true ;;
  5:2:5:2:3) emit_state false false false false false ;;
  *)
    echo "Partial or out-of-order Phase 6 schema detected ($foundation/5 foundation, $hardening/2 hardening, $phase65/5 Phase 6.5, $batcha/2 Batch A, $batchb/3 Batch B). Refusing migration." >&2
    exit 1
    ;;
esac
