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

# The DO block below (needed so a pre-P1 database doesn't fail to parse a
# flat reference to app_migration_receipts) prints its own "DO" command tag
# to stdout ahead of the final SELECT's tuple row -- psql prints a command
# tag for every non-SELECT statement in a script/heredoc, regardless of -At
# (which only affects SELECT result formatting, not command-completion
# tags). `read -r ... <<<"$(...)"` only ever consumes the FIRST line of a
# here-string, so without this fix `foundation` would be bound to the
# literal string "DO" and every other field would come out empty. Take the
# LAST line of psql's output instead, which is always the actual tuple row.
# P2 body contract (VF-002): the installed get_item_sales_report body must be
# byte-identical to the body in the immutable 0045 migration. md5(prosrc) is
# the md5 of exactly the text between the function's $$ delimiters, so a
# comment, whitespace or arithmetic change all fail it -- unlike the earlier
# substring check, which a comment naming the helper could satisfy.
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
p2_body_md5=$(node "$repo_root/scripts/p2-body-md5.mjs")

psql_state_output=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -v p2_body_md5="$p2_body_md5" -At -F' ' <<'SQL'
-- PL/pgSQL embeds each command as a separately-prepared SPI statement,
-- resolved only when control flow actually reaches it. That lets the IF
-- branch below reference app_migration_receipts's rows without erroring on
-- a pre-P1 database, where a single flat SQL statement doing the same
-- would fail to parse regardless of which CASE branch would "run".
do $$
begin
  create temp table if not exists _p1_receipt_check (present boolean);
  delete from _p1_receipt_check;
  -- Packet P2 (0045) replaces a function body only, so it has no schema
  -- signal; its receipt is the sole authoritative marker.
  create temp table if not exists _p2_receipt_check (present boolean);
  delete from _p2_receipt_check;
  if to_regclass('public.app_migration_receipts') is not null then
    insert into _p1_receipt_check
      select exists(select 1 from public.app_migration_receipts where version = '0044');
    insert into _p2_receipt_check
      select exists(select 1 from public.app_migration_receipts where version = '0045');
  else
    insert into _p1_receipt_check values (false);
    insert into _p2_receipt_check values (false);
  end if;
end
$$;

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
-- Group p1 (Packet P1)'s four signals are emitted INDIVIDUALLY, not
-- reduced to a count. A count conflates two structurally different
-- 3-of-4 states: (shape, rls, no_grants, NOT receipt) -- the legitimate
-- "schema ready, receipt not yet backfilled" state every fresh disposable
-- reset passes through before scripts/bootstrap-disposable-receipts.mjs
-- runs -- with (shape, rls, NOT no_grants, receipt) -- a stray
-- anon/authenticated grant added AFTER full completion, which is real
-- corruption. Both produce count=3; only checking the actual 4-tuple can
-- tell them apart. All checks use to_regclass()/information_schema, which
-- are safe (return null/no-rows rather than erroring) when the table does
-- not exist yet.
select
  (select count(*) from foundation where present),
  (select count(*) from hardening where present),
  (select count(*) from phase65 where present),
  (select count(*) from batcha where present),
  (select count(*) from batchb where present),
  (to_regclass('public.app_migration_receipts') is not null
    and (select count(*) from information_schema.columns
         where table_schema='public' and table_name='app_migration_receipts'
           and column_name in ('version','checksum_sha256','applied_at','applied_by')) = 4) as p1_shape,
  (to_regclass('public.app_migration_receipts') is not null
    and exists(select 1 from pg_class where oid=to_regclass('public.app_migration_receipts') and relrowsecurity)) as p1_rls,
  (to_regclass('public.app_migration_receipts') is not null
    and not exists(
      select 1 from information_schema.role_table_grants
      where table_schema='public' and table_name='app_migration_receipts'
        and grantee in ('anon','authenticated')
    )) as p1_no_grants,
  (coalesce((select present from _p1_receipt_check), false)) as p1_receipt,
  (coalesce((select present from _p2_receipt_check), false)) as p2_receipt,
  (coalesce((select md5(prosrc) from pg_proc
              where oid = to_regprocedure('public.get_item_sales_report(uuid,date,date)')) = :'p2_body_md5', false)
    and exists(select 1 from pg_index
               where indexrelid = to_regclass('public.sale_invoice_items_sale_invoice_idx')
                 and indrelid = 'public.sale_invoice_items'::regclass and indisvalid
                 and pg_get_indexdef(indexrelid) like '%(sale_invoice_id)')
    and coalesce(has_function_privilege('authenticated', to_regprocedure('public.get_item_sales_report(uuid,date,date)'), 'EXECUTE'), false)
    and not coalesce(has_function_privilege('anon', to_regprocedure('public.get_item_sales_report(uuid,date,date)'), 'EXECUTE'), true)) as p2_body;
SQL
)
read -r foundation hardening phase65 batcha batchb p1_shape p1_rls p1_no_grants p1_receipt p2_receipt p2_body \
  <<<"$(tail -n1 <<<"$psql_state_output")"

# Validate the raw p1 4-tuple against the only three legitimate
# combinations BEFORE reducing it to a count for the legacy switch below.
# Anything else (RLS disabled while the table exists, a stray grant, a
# receipt recorded for a table that doesn't structurally match, etc.) is
# real drift and refuses immediately with a specific reason, rather than
# falling through to the legacy switch's generic "partial or out-of-order"
# message or -- worse -- being silently accepted because it happens to
# share a count with a legitimate state.
case "$p1_shape:$p1_rls:$p1_no_grants:$p1_receipt" in
  f:f:f:f) p1=0 ;;   # not started
  t:t:t:f) p1=3 ;;   # schema ready, receipt not yet backfilled (legitimate)
  t:t:t:t) p1=4 ;;   # fully complete
  *)
    echo "app_migration_receipts schema/grant drift detected (shape=$p1_shape rls=$p1_rls no_grants=$p1_no_grants receipt=$p1_receipt). Refusing migration." >&2
    exit 1
    ;;
esac
# P2 needs both its receipt and the exact 0045 contract (body bytes, index,
# grants). A receipt without it means the function or its index/grants were
# changed after P2 (e.g. an older dump restored over it, or a hand edit):
# refuse rather than report P2 as done.
case "$p2_receipt:$p2_body" in
  f:f|f:t) p2=0 ;;   # f:t = body already fixed but no receipt; applying p2 is idempotent
  t:t) p2=1 ;;
  *)
    echo "get_item_sales_report drift: 0045 receipt present but installed body/index/grants do not match 0045. Refusing migration." >&2
    exit 1
    ;;
esac
# A present receipt must also match the file bytes, or a tampered/stale
# receipt would make needs_p2=false and skip the checksum-checking runner.
if [[ "$p2" == "1" ]]; then
  p2_expected=$(sha256sum "$repo_root/supabase/migrations/0045_item_sales_fix.sql" | cut -d' ' -f1)
  p2_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c \
    "select checksum_sha256 from public.app_migration_receipts where version='0045'")
  if [[ "$p2_recorded" != "$p2_expected" ]]; then
    echo "0045 receipt checksum does not match supabase/migrations/0045_item_sales_fix.sql. Refusing migration." >&2
    exit 1
  fi
fi

emit_state() {
  local needs_foundation=$1 needs_hardening=$2 needs_phase65=$3 needs_batcha=$4 needs_batchb=$5 needs_p1=$6 needs_p2=$7
  local needs_upgrade=true
  if [[ "$needs_foundation:$needs_hardening:$needs_phase65:$needs_batcha:$needs_batchb:$needs_p1:$needs_p2" == "false:false:false:false:false:false:false" ]]; then
    needs_upgrade=false
  fi
  printf 'observed_state=%s:%s:%s:%s:%s:%s:%s\n' "$foundation" "$hardening" "$phase65" "$batcha" "$batchb" "$p1" "$p2"
  printf 'needs_upgrade=%s\n' "$needs_upgrade"
  printf 'needs_foundation=%s\n' "$needs_foundation"
  printf 'needs_hardening=%s\n' "$needs_hardening"
  printf 'needs_phase65=%s\n' "$needs_phase65"
  printf 'needs_batcha=%s\n' "$needs_batcha"
  printf 'needs_batchb=%s\n' "$needs_batchb"
  printf 'needs_p1=%s\n' "$needs_p1"
  printf 'needs_p2=%s\n' "$needs_p2"
}

# Legacy (0030-0043) classification is unchanged from before Packet P1: the
# same case-statement, the same tuple matches, the same refusal on any
# partial/out-of-order state. Packet P1 (mechanism point 1) only appends a
# zero/false-default p1 column to every already-supported legacy state, plus
# one new terminal state where p1 is also complete. It does not rewrite the
# generic-iteration form (mechanism point 8) because that rewrite could not
# be verified here to preserve the exact existing legacy behavior without a
# live database to test against (see final report for this deviation).
case "$foundation:$hardening:$phase65:$batcha:$batchb:$p1:$p2" in
  0:0:0:0:0:0:0) emit_state true true true true true true true ;;
  5:0:0:0:0:0:0) emit_state false true true true true true true ;;
  5:2:0:0:0:0:0) emit_state false false true true true true true ;;
  5:2:5:0:0:0:0) emit_state false false false true true true true ;;
  5:2:5:2:0:0:0) emit_state false false false false true true true ;;
  5:2:5:2:3:0:0) emit_state false false false false false true true ;;
  5:2:5:2:3:3:0) emit_state false false false false false true true ;;
  5:2:5:2:3:4:0) emit_state false false false false false false true ;;
  5:2:5:2:3:4:1) emit_state false false false false false false false ;;
  *)
    echo "Partial or out-of-order Phase 6 schema detected ($foundation/5 foundation, $hardening/2 hardening, $phase65/5 Phase 6.5, $batcha/2 Batch A, $batchb/3 Batch B, $p1/4 P1, $p2/1 P2). Refusing migration." >&2
    exit 1
    ;;
esac
