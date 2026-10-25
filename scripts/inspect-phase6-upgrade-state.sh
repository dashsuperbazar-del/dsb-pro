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
  create temp table if not exists _c0_receipt_check (present boolean);
  delete from _c0_receipt_check;
  create temp table if not exists _c1_receipt_check (present boolean);
  delete from _c1_receipt_check;
  create temp table if not exists _c2_receipt_check (present boolean);
  delete from _c2_receipt_check;
  create temp table if not exists _c3_receipt_check (present boolean);
  delete from _c3_receipt_check;
  create temp table if not exists _c3b_receipt_check (present boolean);
  delete from _c3b_receipt_check;
  create temp table if not exists _r0_receipt_check (present boolean);
  delete from _r0_receipt_check;
  create temp table if not exists _d1_receipt_check (present boolean);
  delete from _d1_receipt_check;
  create temp table if not exists _r0b_receipt_check (present boolean);
  delete from _r0b_receipt_check;
  create temp table if not exists _o1_receipt_check (present boolean);
  delete from _o1_receipt_check;
  create temp table if not exists _o2_receipt_check (present boolean);
  delete from _o2_receipt_check;
  create temp table if not exists _d2b_receipt_check (present boolean);
  delete from _d2b_receipt_check;
  create temp table if not exists _d3a_receipt_check (present boolean);
  delete from _d3a_receipt_check;
  if to_regclass('public.app_migration_receipts') is not null then
    insert into _p1_receipt_check
      select exists(select 1 from public.app_migration_receipts where version = '0044');
    insert into _p2_receipt_check
      select exists(select 1 from public.app_migration_receipts where version = '0045');
    insert into _c0_receipt_check
      select exists(select 1 from public.app_migration_receipts where version = '0046');
    insert into _c1_receipt_check
      select exists(select 1 from public.app_migration_receipts where version = '0047');
    insert into _c2_receipt_check
      select exists(select 1 from public.app_migration_receipts where version = '0048');
    insert into _c3_receipt_check
      select exists(select 1 from public.app_migration_receipts where version = '0049');
    insert into _c3b_receipt_check
      select exists(select 1 from public.app_migration_receipts where version = '0050');
    insert into _r0_receipt_check
      select exists(select 1 from public.app_migration_receipts where version = '0051');
    insert into _d1_receipt_check
      select exists(select 1 from public.app_migration_receipts where version = '0052');
    insert into _r0b_receipt_check
      select exists(select 1 from public.app_migration_receipts where version = '0053');
    insert into _o1_receipt_check
      select exists(select 1 from public.app_migration_receipts where version = '0054');
    insert into _o2_receipt_check
      select exists(select 1 from public.app_migration_receipts where version = '0055');
    insert into _d2b_receipt_check
      select exists(select 1 from public.app_migration_receipts where version = '0056');
    insert into _d3a_receipt_check
      select exists(select 1 from public.app_migration_receipts where version = '0057');
  else
    insert into _p1_receipt_check values (false);
    insert into _p2_receipt_check values (false);
    insert into _c0_receipt_check values (false);
    insert into _c1_receipt_check values (false);
    insert into _c2_receipt_check values (false);
    insert into _c3_receipt_check values (false);
    insert into _c3b_receipt_check values (false);
    insert into _r0_receipt_check values (false);
    insert into _d1_receipt_check values (false);
    insert into _r0b_receipt_check values (false);
    insert into _o1_receipt_check values (false);
    insert into _o2_receipt_check values (false);
    insert into _d2b_receipt_check values (false);
    insert into _d3a_receipt_check values (false);
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
    and not coalesce(has_function_privilege('anon', to_regprocedure('public.get_item_sales_report(uuid,date,date)'), 'EXECUTE'), true)) as p2_body,
  (coalesce((select present from _c0_receipt_check), false)) as c0_receipt,
  (to_regclass('public.financial_requests') is not null
    and to_regclass('public.shop_financial_history') is not null
    and to_regprocedure('public.c0_post_sale_body(uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text)') is not null
    and coalesce((select attnotnull from pg_attribute
                  where attrelid = 'public.payment_allocations'::regclass and attname = 'effective_date' and not attisdropped), false)) as c0_schema,
  (coalesce((select present from _c1_receipt_check), false)) as c1_receipt,
  (to_regprocedure('public.record_supplier_payment(uuid,uuid,date,bigint,text,text,jsonb,text)') is not null
    and to_regclass('public.purchase_bill_outstanding') is not null) as c1_schema,
  (coalesce((select present from _c2_receipt_check), false)) as c2_receipt,
  coalesce((select provolatile = 's' and prosrc not like '%_c1_ledger%' from pg_proc
            where oid = to_regprocedure('public.get_party_ledger_v2(uuid,uuid,date,date)')), false) as c2_schema,
  (coalesce((select present from _c3_receipt_check), false)) as c3_receipt,
  (to_regprocedure('public.record_customer_payment_v2(uuid,uuid,date,bigint,text,text,jsonb,text)') is not null
    and to_regprocedure('public.allocate_customer_payment_v2(uuid,jsonb,text)') is not null) as c3_schema,
  (coalesce((select present from _c3b_receipt_check), false)) as c3b_receipt,
  coalesce((select prosrc like '%client_id already used for a different purchase%' from pg_proc
            where oid = to_regprocedure('public.post_purchase(uuid,uuid,text,date,bigint,bigint,text,jsonb,text)')), false) as c3b_schema,
  (coalesce((select present from _r0_receipt_check), false)) as r0_receipt,
  (to_regprocedure('public.r0_sync_post_sale(text,integer,uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text)') is not null and exists(select 1 from information_schema.columns where table_schema='public' and table_name='sale_invoices' and column_name='round_off_paise')) as r0_schema,
  (coalesce((select present from _d1_receipt_check), false)) as d1_receipt,
  (to_regprocedure('public.get_customer_aging_report_v2(uuid,date)') is not null and to_regprocedure('public.get_supplier_aging_report_v2(uuid,date)') is not null) as d1_schema,
  (coalesce((select present from _r0b_receipt_check), false)) as r0b_receipt,
  (exists(select 1 from information_schema.columns where table_schema='public' and table_name='sale_returns' and column_name='round_off_paise')) as r0b_schema,
  (coalesce((select present from _o1_receipt_check), false)) as o1_receipt,
  (to_regclass('public.account_openings') is not null and to_regprocedure('public.record_account_opening(uuid,text,uuid,date,bigint,text,text)') is not null and to_regprocedure('public.void_account_opening(uuid,text)') is not null and to_regprocedure('public.o1_opening_guard()') is not null and exists(select 1 from pg_trigger where tgname='account_openings_guard' and tgrelid=to_regclass('public.account_openings'))) as o1_schema,
  (coalesce((select present from _o2_receipt_check), false)) as o2_receipt,
  (to_regclass('public.opening_settlements') is not null and to_regprocedure('public.settle_opening(uuid,uuid,bigint,text)') is not null and to_regprocedure('public.void_opening_settlement(uuid,text)') is not null and to_regprocedure('public.get_opening_settlement_options(uuid)') is not null and exists(select 1 from pg_trigger where tgname='payment_allocations_o2_within_payment' and tgrelid=to_regclass('public.payment_allocations')) and exists(select 1 from pg_trigger where tgname='payments_o2_void_settlements' and tgrelid=to_regclass('public.payments')) and exists(select 1 from pg_trigger where tgname='opening_settlements_guard' and tgrelid=to_regclass('public.opening_settlements'))) as o2_schema,
  (coalesce((select present from _d2b_receipt_check), false)) as d2b_receipt,
  (regexp_replace(coalesce(pg_get_functiondef(to_regprocedure('public.update_shop_settings(uuid,text,text,text,text,text,text,smallint,boolean)')),''),'\s+','','g') like '%DSB_FISCAL_MONTH_FROZEN%') as d2b_schema,
  (coalesce((select present from _d3a_receipt_check), false)) as d3a_receipt,
  (position('''financialRequests'',coalesce' in coalesce(pg_get_functiondef(to_regprocedure('public.phase6_export_tenant(uuid)')),''))>0 and position('''shopFinancialHistory'',coalesce' in coalesce(pg_get_functiondef(to_regprocedure('public.phase6_export_tenant(uuid)')),''))>0) as d3a_schema;
SQL
)
read -r foundation hardening phase65 batcha batchb p1_shape p1_rls p1_no_grants p1_receipt p2_receipt p2_body c0_receipt c0_schema c1_receipt c1_schema c2_receipt c2_schema c3_receipt c3_schema c3b_receipt c3b_schema r0_receipt r0_schema d1_receipt d1_schema r0b_receipt r0b_schema o1_receipt o1_schema o2_receipt o2_schema d2b_receipt d2b_schema d3a_receipt d3a_schema \
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
# C0 (0046): 0 = not applied, 1 = schema present awaiting its receipt (the
# state every fresh disposable reset passes through before the receipt
# bootstrap; ordinary apply cannot re-run 0046 over it and fails without
# changing anything), 2 = complete. A receipt without the schema is drift.
# A present receipt must match the file bytes.
case "$c0_receipt:$c0_schema" in
  f:f) c0=0 ;;
  f:t) c0=1 ;;
  t:t) c0=2 ;;
  *)
    echo "C0 drift: 0046 receipt=$c0_receipt but schema present=$c0_schema. Refusing migration." >&2
    exit 1
    ;;
esac
if [[ "$c0" == "2" ]]; then
  c0_expected=$(sha256sum "$repo_root/supabase/migrations/0046_finance_requests_and_locking.sql" | cut -d' ' -f1)
  c0_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c \
    "select checksum_sha256 from public.app_migration_receipts where version='0046'")
  if [[ "$c0_recorded" != "$c0_expected" ]]; then
    echo "0046 receipt checksum does not match supabase/migrations/0046_finance_requests_and_locking.sql. Refusing migration." >&2
    exit 1
  fi
fi
# C1 (0047): same 0/1/2 states as C0.
case "$c1_receipt:$c1_schema" in
  f:f) c1=0 ;;
  f:t) c1=1 ;;
  t:t) c1=2 ;;
  *)
    echo "C1 drift: 0047 receipt=$c1_receipt but schema present=$c1_schema. Refusing migration." >&2
    exit 1
    ;;
esac
if [[ "$c1" == "2" ]]; then
  c1_expected=$(sha256sum "$repo_root/supabase/migrations/0047_supplier_payments.sql" | cut -d' ' -f1)
  c1_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c \
    "select checksum_sha256 from public.app_migration_receipts where version='0047'")
  if [[ "$c1_recorded" != "$c1_expected" ]]; then
    echo "0047 receipt checksum does not match supabase/migrations/0047_supplier_payments.sql. Refusing migration." >&2
    exit 1
  fi
fi

# C2 (0048): same 0/1/2 states as C0.
case "$c2_receipt:$c2_schema" in
  f:f) c2=0 ;;
  f:t) c2=1 ;;
  t:t) c2=2 ;;
  *)
    echo "C2 drift: 0048 receipt=$c2_receipt but schema present=$c2_schema. Refusing migration." >&2
    exit 1
    ;;
esac
if [[ "$c2" == "2" ]]; then
  c2_expected=$(sha256sum "$repo_root/supabase/migrations/0048_supplier_ledger_fix.sql" | cut -d' ' -f1)
  c2_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c \
    "select checksum_sha256 from public.app_migration_receipts where version='0048'")
  if [[ "$c2_recorded" != "$c2_expected" ]]; then
    echo "0048 receipt checksum does not match supabase/migrations/0048_supplier_ledger_fix.sql. Refusing migration." >&2
    exit 1
  fi
fi
# C3 (0049): same 0/1/2 states as C0.
case "$c3_receipt:$c3_schema" in
  f:f) c3=0 ;;
  f:t) c3=1 ;;
  t:t) c3=2 ;;
  *)
    echo "C3 drift: 0049 receipt=$c3_receipt but schema present=$c3_schema. Refusing migration." >&2
    exit 1
    ;;
esac
if [[ "$c3" == "2" ]]; then
  c3_expected=$(sha256sum "$repo_root/supabase/migrations/0049_customer_requests.sql" | cut -d' ' -f1)
  c3_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c \
    "select checksum_sha256 from public.app_migration_receipts where version='0049'")
  if [[ "$c3_recorded" != "$c3_expected" ]]; then
    echo "0049 receipt checksum does not match supabase/migrations/0049_customer_requests.sql. Refusing migration." >&2
    exit 1
  fi
fi
# C3b (0050): same 0/1/2 states as C0.
case "$c3b_receipt:$c3b_schema" in
  f:f) c3b=0 ;;
  f:t) c3b=1 ;;
  t:t) c3b=2 ;;
  *)
    echo "C3b drift: 0050 receipt=$c3b_receipt but schema present=$c3b_schema. Refusing migration." >&2
    exit 1
    ;;
esac
if [[ "$c3b" == "2" ]]; then
  c3b_expected=$(sha256sum "$repo_root/supabase/migrations/0050_purchase_retry_verification.sql" | cut -d' ' -f1)
  c3b_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c \
    "select checksum_sha256 from public.app_migration_receipts where version='0050'")
  if [[ "$c3b_recorded" != "$c3b_expected" ]]; then
    echo "0050 receipt checksum does not match supabase/migrations/0050_purchase_retry_verification.sql. Refusing migration." >&2
    exit 1
  fi
fi

# R0 bill round-off (0051): same 0/1/2 states as C0.
case "$r0_receipt:$r0_schema" in
  f:f) r0=0 ;;
  f:t) r0=1 ;;
  t:t) r0=2 ;;
  *)
    echo "R0 bill round-off drift: 0051 receipt=$r0_receipt but schema present=$r0_schema. Refusing migration." >&2
    exit 1
    ;;
esac
if [[ "$r0" == "2" ]]; then
  r0_expected=$(sha256sum "$repo_root/supabase/migrations/0051_bill_round_off.sql" | cut -d' ' -f1)
  r0_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c \
    "select checksum_sha256 from public.app_migration_receipts where version='0051'")
  if [[ "$r0_recorded" != "$r0_expected" ]]; then
    echo "0051 receipt checksum does not match supabase/migrations/0051_bill_round_off.sql. Refusing migration." >&2
    exit 1
  fi
fi

# D1 (0052): same 0/1/2 states as C0.
case "$d1_receipt:$d1_schema" in
  f:f) d1=0 ;;
  f:t) d1=1 ;;
  t:t) d1=2 ;;
  *)
    echo "D1 drift: 0052 receipt=$d1_receipt but schema present=$d1_schema. Refusing migration." >&2
    exit 1
    ;;
esac
if [[ "$d1" == "2" ]]; then
  d1_expected=$(sha256sum "$repo_root/supabase/migrations/0052_aging_as_of.sql" | cut -d' ' -f1)
  d1_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c \
    "select checksum_sha256 from public.app_migration_receipts where version='0052'")
  if [[ "$d1_recorded" != "$d1_expected" ]]; then
    echo "0052 receipt checksum does not match supabase/migrations/0052_aging_as_of.sql. Refusing migration." >&2
    exit 1
  fi
fi

# R0b (0053): same 0/1/2 states as C0.
case "$r0b_receipt:$r0b_schema" in
  f:f) r0b=0 ;;
  f:t) r0b=1 ;;
  t:t) r0b=2 ;;
  *)
    echo "R0b drift: 0053 receipt=$r0b_receipt but schema present=$r0b_schema. Refusing migration." >&2
    exit 1
    ;;
esac
if [[ "$r0b" == "2" ]]; then
  r0b_expected=$(sha256sum "$repo_root/supabase/migrations/0053_return_round_off.sql" | cut -d' ' -f1)
  r0b_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c \
    "select checksum_sha256 from public.app_migration_receipts where version='0053'")
  if [[ "$r0b_recorded" != "$r0b_expected" ]]; then
    echo "0053 receipt checksum does not match supabase/migrations/0053_return_round_off.sql. Refusing migration." >&2
    exit 1
  fi
fi

# O1 (0054): same 0/1/2 states as C0.
case "$o1_receipt:$o1_schema" in
  f:f) o1=0 ;;
  f:t) o1=1 ;;
  t:t) o1=2 ;;
  *)
    echo "O1 drift: 0054 receipt=$o1_receipt but schema present=$o1_schema. Refusing migration." >&2
    exit 1
    ;;
esac
if [[ "$o1" == "2" ]]; then
  o1_expected=$(sha256sum "$repo_root/supabase/migrations/0054_account_openings.sql" | cut -d' ' -f1)
  o1_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c \
    "select checksum_sha256 from public.app_migration_receipts where version='0054'")
  if [[ "$o1_recorded" != "$o1_expected" ]]; then
    echo "0054 receipt checksum does not match supabase/migrations/0054_account_openings.sql. Refusing migration." >&2
    exit 1
  fi
fi

# O2 opening settlements (0055): same 0/1/2 states as C0.
case "$o2_receipt:$o2_schema" in
  f:f) o2=0 ;;
  f:t) o2=1 ;;
  t:t) o2=2 ;;
  *)
    echo "O2 opening settlements drift: 0055 receipt=$o2_receipt but schema present=$o2_schema. Refusing migration." >&2
    exit 1
    ;;
esac
if [[ "$o2" == "2" ]]; then
  o2_expected=$(sha256sum "$repo_root/supabase/migrations/0055_opening_settlements.sql" | cut -d' ' -f1)
  o2_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c \
    "select checksum_sha256 from public.app_migration_receipts where version='0055'")
  if [[ "$o2_recorded" != "$o2_expected" ]]; then
    echo "0055 receipt checksum does not match supabase/migrations/0055_opening_settlements.sql. Refusing migration." >&2
    exit 1
  fi
fi

# D2b shop settings guard (0056): same 0/1/2 states as C0.
case "$d2b_receipt:$d2b_schema" in
  f:f) d2b=0 ;;
  f:t) d2b=1 ;;
  t:t) d2b=2 ;;
  *)
    echo "D2b shop settings guard drift: 0056 receipt=$d2b_receipt but schema present=$d2b_schema. Refusing migration." >&2
    exit 1
    ;;
esac
if [[ "$d2b" == "2" ]]; then
  d2b_expected=$(sha256sum "$repo_root/supabase/migrations/0056_shop_settings_guard.sql" | cut -d' ' -f1)
  d2b_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c \
    "select checksum_sha256 from public.app_migration_receipts where version='0056'")
  if [[ "$d2b_recorded" != "$d2b_expected" ]]; then
    echo "0056 receipt checksum does not match supabase/migrations/0056_shop_settings_guard.sql. Refusing migration." >&2
    exit 1
  fi
fi

# D3a export request ledger (0057): same 0/1/2 states as C0.
case "$d3a_receipt:$d3a_schema" in
  f:f) d3a=0 ;;
  f:t) d3a=1 ;;
  t:t) d3a=2 ;;
  *)
    echo "D3a export request ledger drift: 0057 receipt=$d3a_receipt but schema present=$d3a_schema. Refusing migration." >&2
    exit 1
    ;;
esac
if [[ "$d3a" == "2" ]]; then
  d3a_expected=$(sha256sum "$repo_root/supabase/migrations/0057_export_requests.sql" | cut -d' ' -f1)
  d3a_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c \
    "select checksum_sha256 from public.app_migration_receipts where version='0057'")
  if [[ "$d3a_recorded" != "$d3a_expected" ]]; then
    echo "0057 receipt checksum does not match supabase/migrations/0057_export_requests.sql. Refusing migration." >&2
    exit 1
  fi
fi

# DW2b is an additive classifier field; preserve the historical 19-part observed_state contract.
billdocs_body_md5=$(node "$repo_root/scripts/billdocs-body-md5.mjs")
# 0062 (partymerge) redefines post_purchase; its exact body is also a valid billdocs anchor. The partymerge
# classifier below refuses that body when the rest of 0062 is absent.
partymerge_body_md5=$(node "$repo_root/scripts/partymerge-body-md5.mjs")
billdocs_probe=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -F' ' -v billdocs_body_md5="$billdocs_body_md5" -v partymerge_body_md5="$partymerge_body_md5" <<'SQL'
do $$ begin
 create temp table _billdocs_receipt (present boolean);
 if to_regclass('public.app_migration_receipts') is not null then
   insert into _billdocs_receipt select exists(select 1 from public.app_migration_receipts where version='0058');
 else insert into _billdocs_receipt values(false); end if;
end $$;
select (select present from _billdocs_receipt),
 (select count(*) from (values
   (exists(select 1 from storage.buckets where id='bill-documents' and not public and file_size_limit=5242880
      and allowed_mime_types=array['image/webp','image/jpeg','image/png','application/pdf'])),
   (exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='bill_documents_read')),
   (exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='bill_documents_insert')),
   (exists(select 1 from pg_proc where oid='public.post_purchase(uuid,uuid,text,date,bigint,bigint,text,jsonb,text)'::regprocedure
      and md5(prosrc) in (:'billdocs_body_md5',:'partymerge_body_md5')))
 ) p(ok) where ok);
SQL
)
read -r billdocs_receipt billdocs_anchors <<<"$(tail -n 1 <<<"$billdocs_probe")"
case "$billdocs_receipt:$billdocs_anchors" in
 f:0) billdocs=0; needs_billdocs=true ;;
 f:4) billdocs=1; needs_billdocs=true ;;
 t:4) billdocs=2; needs_billdocs=false ;;
 *) echo "Bill documents partial/drift state ($billdocs_receipt/$billdocs_anchors). Refusing migration." >&2; exit 1 ;;
esac
if [[ "$billdocs" == '2' ]]; then
 billdocs_expected=$(sha256sum "$repo_root/supabase/migrations/0058_bill_documents.sql" | cut -d' ' -f1)
 billdocs_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c "select checksum_sha256 from public.app_migration_receipts where version='0058'")
 [[ "$billdocs_expected" == "$billdocs_recorded" ]] || { echo '0058 receipt checksum mismatch. Refusing migration.' >&2; exit 1; }
fi
# A later packet is not allowed to appear ahead of its predecessor, except a full reset awaiting receipts.
if [[ "$billdocs" != '0' && "$d3a" != '2' && ! ( "$billdocs" == '1' && "$d3a" == '1' ) ]]; then
 echo 'Bill documents appear ahead of completed D3a. Refusing migration.' >&2; exit 1
fi

# Guarded party archive (0059): additive classifier field, like billdocs. Eight anchors, all or nothing.
partyarchive_probe=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -F' ' <<'SQL'
do $$ begin
 create temp table _partyarchive_receipt (present boolean);
 if to_regclass('public.app_migration_receipts') is not null then
   insert into _partyarchive_receipt select exists(select 1 from public.app_migration_receipts where version='0059');
 else insert into _partyarchive_receipt values(false); end if;
end $$;
select (select present from _partyarchive_receipt),
 (select count(*) from (values
   (to_regprocedure('public.archive_party(uuid)') is not null),
   (to_regprocedure('public.archive_customer(uuid)') is not null),
   (exists(select 1 from pg_policies where schemaname='public' and tablename='customers' and policyname='customers_update')
     and not exists(select 1 from pg_policies where schemaname='public' and tablename='customers' and policyname='customers_write')),
   (exists(select 1 from pg_policies where schemaname='public' and tablename='parties' and policyname='parties_update')
     and not exists(select 1 from pg_policies where schemaname='public' and tablename='parties' and policyname='parties_write')),
   (exists(select 1 from pg_proc where oid=to_regprocedure('public.archive_master(text,uuid)') and position('DSB_USE_ARCHIVE_PARTY' in prosrc)>0)),
   (to_regclass('public.parties') is not null and to_regclass('public.customers') is not null
     and not has_column_privilege('authenticated','public.parties','deleted_at','UPDATE')
     and not has_column_privilege('authenticated','public.customers','deleted_at','UPDATE')),
   (exists(select 1 from pg_indexes where schemaname='public' and indexname='customers_live_name_key')
     and not exists(select 1 from pg_constraint where conname='customers_tenant_id_normalized_name_key')),
   ((select count(*) from pg_trigger where tgname='dsb_live_party_guard' and not tgisinternal)=6)
 ) p(ok) where ok);
SQL
)
read -r partyarchive_receipt partyarchive_anchors <<<"$(tail -n 1 <<<"$partyarchive_probe")"
case "$partyarchive_receipt:$partyarchive_anchors" in
 f:0) partyarchive=0; needs_partyarchive=true ;;
 f:8) partyarchive=1; needs_partyarchive=true ;;
 t:8) partyarchive=2; needs_partyarchive=false ;;
 *) echo "Party archive partial/drift state ($partyarchive_receipt/$partyarchive_anchors). Refusing migration." >&2; exit 1 ;;
esac
if [[ "$partyarchive" == '2' ]]; then
 partyarchive_expected=$(sha256sum "$repo_root/supabase/migrations/0059_party_archive.sql" | cut -d' ' -f1)
 partyarchive_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c "select checksum_sha256 from public.app_migration_receipts where version='0059'")
 [[ "$partyarchive_expected" == "$partyarchive_recorded" ]] || { echo '0059 receipt checksum mismatch. Refusing migration.' >&2; exit 1; }
fi
# A later packet is not allowed to appear ahead of its predecessor, except a full reset awaiting receipts.
if [[ "$partyarchive" != '0' && "$billdocs" != '2' && ! ( "$partyarchive" == '1' && "$billdocs" == '1' ) ]]; then
 echo 'Party archive appears ahead of completed bill documents. Refusing migration.' >&2; exit 1
fi

# FIFO profit report (0060): additive classifier field, like billdocs/partyarchive. Four anchors, all or nothing.
profit_probe=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -F' ' <<'SQL'
do $$ begin
 create temp table _profit_receipt (present boolean);
 if to_regclass('public.app_migration_receipts') is not null then
   insert into _profit_receipt select exists(select 1 from public.app_migration_receipts where version='0060');
 else insert into _profit_receipt values(false); end if;
end $$;
select (select present from _profit_receipt),
 (select count(*) from (values
   (to_regprocedure('public.get_profit_report(uuid,date,date)') is not null),
   (exists(select 1 from pg_proc where oid=to_regprocedure('public.get_profit_report(uuid,date,date)')
      and position('DSB_INVALID_PERIOD' in prosrc)>0 and position('profit_line_costs' in prosrc)>0)),
   (case when to_regprocedure('public.get_profit_report(uuid,date,date)') is null then false
     else has_function_privilege('authenticated','public.get_profit_report(uuid,date,date)','execute')
      and not has_function_privilege('anon','public.get_profit_report(uuid,date,date)','execute') end),
   (case when to_regprocedure('public.profit_line_costs(uuid,uuid,date,date)') is null then false
     else not has_function_privilege('authenticated','public.profit_line_costs(uuid,uuid,date,date)','execute')
      and not has_function_privilege('anon','public.profit_line_costs(uuid,uuid,date,date)','execute') end)
 ) p(ok) where ok);
SQL
)
read -r profit_receipt profit_anchors <<<"$(tail -n 1 <<<"$profit_probe")"
case "$profit_receipt:$profit_anchors" in
 f:0) profit=0; needs_profit=true ;;
 f:4) profit=1; needs_profit=true ;;
 t:4) profit=2; needs_profit=false ;;
 *) echo "Profit report partial/drift state ($profit_receipt/$profit_anchors). Refusing migration." >&2; exit 1 ;;
esac
if [[ "$profit" == '2' ]]; then
 profit_expected=$(sha256sum "$repo_root/supabase/migrations/0060_profit_report.sql" | cut -d' ' -f1)
 profit_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c "select checksum_sha256 from public.app_migration_receipts where version='0060'")
 [[ "$profit_expected" == "$profit_recorded" ]] || { echo '0060 receipt checksum mismatch. Refusing migration.' >&2; exit 1; }
fi
# A later packet is not allowed to appear ahead of its predecessor, except a full reset awaiting receipts.
if [[ "$profit" != '0' && "$partyarchive" != '2' && ! ( "$profit" == '1' && "$partyarchive" == '1' ) ]]; then
 echo 'Profit report appears ahead of completed party archive. Refusing migration.' >&2; exit 1
fi

# Supplier payment schedule (0061): additive classifier field. Four anchors, all or nothing.
supplierschedule_probe=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -F' ' <<'SQL'
do $$ begin
 create temp table _supplierschedule_receipt (present boolean);
 if to_regclass('public.app_migration_receipts') is not null then
   insert into _supplierschedule_receipt select exists(select 1 from public.app_migration_receipts where version='0061');
 else insert into _supplierschedule_receipt values(false); end if;
end $$;
select (select present from _supplierschedule_receipt),
 (select count(*) from (values
   (coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.supplier_payment_schedules')),false)),
   (exists(select 1 from pg_proc where oid=to_regprocedure('public.get_supplier_payments_due(uuid,date)')
      and position('DSB_INVALID_SCHEDULE' in prosrc)>0 and position('payments' in prosrc)>0)
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.set_supplier_payment_schedule(uuid,uuid,integer,bigint,text,boolean,text)')
      and position('DSB_INVALID_SCHEDULE' in prosrc)>0)
    and to_regprocedure('public.remove_supplier_payment_schedule(uuid)') is not null),
   (case when to_regclass('public.supplier_payment_schedules') is null
          or to_regprocedure('public.get_supplier_payments_due(uuid,date)') is null
          or to_regprocedure('public.set_supplier_payment_schedule(uuid,uuid,integer,bigint,text,boolean,text)') is null
          or to_regprocedure('public.remove_supplier_payment_schedule(uuid)') is null then false
     else has_function_privilege('authenticated','public.get_supplier_payments_due(uuid,date)','execute')
      and has_function_privilege('authenticated','public.set_supplier_payment_schedule(uuid,uuid,integer,bigint,text,boolean,text)','execute')
      and has_function_privilege('authenticated','public.remove_supplier_payment_schedule(uuid)','execute')
      and not has_function_privilege('anon','public.get_supplier_payments_due(uuid,date)','execute')
      and not has_function_privilege('anon','public.set_supplier_payment_schedule(uuid,uuid,integer,bigint,text,boolean,text)','execute')
      and not has_function_privilege('anon','public.remove_supplier_payment_schedule(uuid)','execute')
      and has_table_privilege('authenticated','public.supplier_payment_schedules','select')
      and not has_table_privilege('authenticated','public.supplier_payment_schedules','insert')
      and not has_table_privilege('authenticated','public.supplier_payment_schedules','update')
      and not has_table_privilege('authenticated','public.supplier_payment_schedules','delete') end),
   (exists(select 1 from pg_indexes where schemaname='public' and indexname='supplier_payment_schedules_one_live')
    and exists(select 1 from pg_trigger where tgname='supplier_payment_schedules_no_delete' and not tgisinternal))
 ) p(ok) where ok);
SQL
)
read -r supplierschedule_receipt supplierschedule_anchors <<<"$(tail -n 1 <<<"$supplierschedule_probe")"
case "$supplierschedule_receipt:$supplierschedule_anchors" in
 f:0) supplierschedule=0; needs_supplierschedule=true ;;
 f:4) supplierschedule=1; needs_supplierschedule=true ;;
 t:4) supplierschedule=2; needs_supplierschedule=false ;;
 *) echo "Supplier payment schedule partial/drift state ($supplierschedule_receipt/$supplierschedule_anchors). Refusing migration." >&2; exit 1 ;;
esac
if [[ "$supplierschedule" == '2' ]]; then
 supplierschedule_expected=$(sha256sum "$repo_root/supabase/migrations/0061_supplier_payment_schedule.sql" | cut -d' ' -f1)
 supplierschedule_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c "select checksum_sha256 from public.app_migration_receipts where version='0061'")
 [[ "$supplierschedule_expected" == "$supplierschedule_recorded" ]] || { echo '0061 receipt checksum mismatch. Refusing migration.' >&2; exit 1; }
fi
# A later packet is not allowed to appear ahead of its predecessor, except a full reset awaiting receipts.
if [[ "$supplierschedule" != '0' && "$profit" != '2' && ! ( "$supplierschedule" == '1' && "$profit" == '1' ) ]]; then
 echo 'Supplier payment schedule appears ahead of completed profit report. Refusing migration.' >&2; exit 1
fi

# Party merge (0062): additive classifier field. Four anchors, all or nothing.
partymerge_probe=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -F' ' -v partymerge_body_md5="$partymerge_body_md5" <<'SQL'
do $$ begin
 create temp table _partymerge_receipt (present boolean);
 if to_regclass('public.app_migration_receipts') is not null then
   insert into _partymerge_receipt select exists(select 1 from public.app_migration_receipts where version='0062');
 else insert into _partymerge_receipt values(false); end if;
end $$;
select (select present from _partymerge_receipt),
 (select count(*) from (values
   (coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.party_merges')),false)),
   (exists(select 1 from pg_proc where oid=to_regprocedure('public.merge_parties(uuid,uuid,text)')
      and position('DSB_MERGE_OPENING_CONFLICT' in prosrc)>0 and position('dsb.party_merge' in prosrc)>0)
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.post_purchase(uuid,uuid,text,date,bigint,bigint,text,jsonb,text)')
      and md5(prosrc)=:'partymerge_body_md5')
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.phase4_payment_guard()')
      and position('dsb_party_merge_move' in prosrc)>0)
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.o1_opening_guard()')
      and position('dsb_party_merge_move' in prosrc)>0)
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.phase65_purchase_return_guard()')
      and position('dsb_party_merge_move' in prosrc)>0)),
   (case when to_regclass('public.party_merges') is null
          or to_regprocedure('public.merge_parties(uuid,uuid,text)') is null
          or to_regprocedure('public.get_supplier_duplicate_bills(uuid,uuid)') is null then false
     else has_function_privilege('authenticated','public.merge_parties(uuid,uuid,text)','execute')
      and has_function_privilege('authenticated','public.get_supplier_duplicate_bills(uuid,uuid)','execute')
      and not has_function_privilege('anon','public.merge_parties(uuid,uuid,text)','execute')
      and not has_function_privilege('anon','public.get_supplier_duplicate_bills(uuid,uuid)','execute')
      and has_table_privilege('authenticated','public.party_merges','select')
      and not has_table_privilege('authenticated','public.party_merges','insert')
      and not has_table_privilege('authenticated','public.party_merges','update')
      and not has_table_privilege('authenticated','public.party_merges','delete') end),
   (exists(select 1 from pg_trigger where tgname='party_merges_immutable' and not tgisinternal)
    and exists(select 1 from pg_constraint where conrelid=to_regclass('public.party_merges') and contype='u'
      and pg_get_constraintdef(oid)='UNIQUE (tenant_id, source_party_id)'))
 ) p(ok) where ok);
SQL
)
read -r partymerge_receipt partymerge_anchors <<<"$(tail -n 1 <<<"$partymerge_probe")"
partymerge_body_present=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -v partymerge_body_md5="$partymerge_body_md5" <<'SQL'
select exists(select 1 from pg_proc where oid=to_regprocedure('public.post_purchase(uuid,uuid,text,date,bigint,bigint,text,jsonb,text)')
  and md5(prosrc)=:'partymerge_body_md5');
SQL
)
if [[ "$partymerge_receipt:$partymerge_anchors" == 'f:0' && "$partymerge_body_present" == 't' ]]; then
 echo 'Party merge purchase wrapper present without the rest of 0062. Refusing migration.' >&2; exit 1
fi
case "$partymerge_receipt:$partymerge_anchors" in
 f:0) partymerge=0; needs_partymerge=true ;;
 f:4) partymerge=1; needs_partymerge=true ;;
 t:4) partymerge=2; needs_partymerge=false ;;
 *) echo "Party merge partial/drift state ($partymerge_receipt/$partymerge_anchors). Refusing migration." >&2; exit 1 ;;
esac
if [[ "$partymerge" == '2' ]]; then
 partymerge_expected=$(sha256sum "$repo_root/supabase/migrations/0062_party_merge.sql" | cut -d' ' -f1)
 partymerge_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c "select checksum_sha256 from public.app_migration_receipts where version='0062'")
 [[ "$partymerge_expected" == "$partymerge_recorded" ]] || { echo '0062 receipt checksum mismatch. Refusing migration.' >&2; exit 1; }
fi
# A later packet is not allowed to appear ahead of its predecessor, except a full reset awaiting receipts.
if [[ "$partymerge" != '0' && "$supplierschedule" != '2' && ! ( "$partymerge" == '1' && "$supplierschedule" == '1' ) ]]; then
 echo 'Party merge appears ahead of completed supplier payment schedule. Refusing migration.' >&2; exit 1
fi

# Item history indexes (0063): additive classifier field. Three anchors (one per index, exact definition),
# all or nothing. An index with the right name but a different definition is drift and is refused.
itemindex_probe=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -F' ' <<'SQL'
do $$ begin
 create temp table _itemindex_receipt (present boolean);
 if to_regclass('public.app_migration_receipts') is not null then
   insert into _itemindex_receipt select exists(select 1 from public.app_migration_receipts where version='0063');
 else insert into _itemindex_receipt values(false); end if;
end $$;
select (select present from _itemindex_receipt),
 (select count(*) from pg_indexes where schemaname='public' and (indexname,indexdef) in (
   ('purchase_bill_items_item_history_idx','CREATE INDEX purchase_bill_items_item_history_idx ON public.purchase_bill_items USING btree (tenant_id, shop_id, item_id, created_at DESC)'),
   ('sale_invoice_items_item_history_idx','CREATE INDEX sale_invoice_items_item_history_idx ON public.sale_invoice_items USING btree (tenant_id, shop_id, item_id, created_at DESC)'),
   ('sale_return_items_item_history_idx','CREATE INDEX sale_return_items_item_history_idx ON public.sale_return_items USING btree (tenant_id, shop_id, item_id, created_at DESC)'))),
 (select count(*) from pg_indexes where schemaname='public' and indexname in
   ('purchase_bill_items_item_history_idx','sale_invoice_items_item_history_idx','sale_return_items_item_history_idx'));
SQL
)
read -r itemindex_receipt itemindex_anchors itemindex_named <<<"$(tail -n 1 <<<"$itemindex_probe")"
if [[ "$itemindex_named" != "$itemindex_anchors" ]]; then
 echo "Item history index definition drift ($itemindex_named named, $itemindex_anchors exact). Refusing migration." >&2; exit 1
fi
case "$itemindex_receipt:$itemindex_anchors" in
 f:0) itemindex=0; needs_itemindex=true ;;
 f:3) itemindex=1; needs_itemindex=true ;;
 t:3) itemindex=2; needs_itemindex=false ;;
 *) echo "Item history index partial/drift state ($itemindex_receipt/$itemindex_anchors). Refusing migration." >&2; exit 1 ;;
esac
if [[ "$itemindex" == '2' ]]; then
 itemindex_expected=$(sha256sum "$repo_root/supabase/migrations/0063_item_history_indexes.sql" | cut -d' ' -f1)
 itemindex_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c "select checksum_sha256 from public.app_migration_receipts where version='0063'")
 [[ "$itemindex_expected" == "$itemindex_recorded" ]] || { echo '0063 receipt checksum mismatch. Refusing migration.' >&2; exit 1; }
fi
# A later packet is not allowed to appear ahead of its predecessor, except a full reset awaiting receipts.
if [[ "$itemindex" != '0' && "$partymerge" != '2' && ! ( "$itemindex" == '1' && "$partymerge" == '1' ) ]]; then
 echo 'Item history indexes appear ahead of completed party merge. Refusing migration.' >&2; exit 1
fi

# Purchase bill extras (0064): additive classifier field. Six anchors, all or nothing. post_purchase (v1) is
# not redefined, so the billdocs/partymerge/c3b body anchors are unaffected.
billextras_probe=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -F' ' <<'SQL'
do $$ begin
 create temp table _billextras_receipt (present boolean);
 if to_regclass('public.app_migration_receipts') is not null then
   insert into _billextras_receipt select exists(select 1 from public.app_migration_receipts where version='0064');
 else insert into _billextras_receipt values(false); end if;
end $$;
select (select present from _billextras_receipt),
 (select count(*) from (values
   (coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.purchase_bill_charges')),false)
    and coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.purchase_bill_images')),false)
    and (select count(*) from pg_policies where schemaname='public' and tablename in ('purchase_bill_charges','purchase_bill_images')
      and position('c1_shop_visible(shop_id)' in qual)>0)=2),
   (exists(select 1 from pg_constraint where conrelid=to_regclass('public.purchase_bills') and contype='c'
      and pg_get_constraintdef(oid)='CHECK ((payment_type = ANY (ARRAY[''credit''::text, ''cash''::text, ''upi''::text])))')
    and exists(select 1 from pg_constraint where conrelid=to_regclass('public.purchase_bill_items')
      and conname='purchase_bill_items_gst_snapshot_check')
    and exists(select 1 from information_schema.columns where table_schema='public' and table_name='purchase_bills' and column_name='notes')
    and exists(select 1 from information_schema.columns where table_schema='public' and table_name='purchase_bill_items' and column_name='discount_bp')
    and exists(select 1 from pg_constraint where conrelid=to_regclass('public.purchase_returns') and contype='c'
      and conname='purchase_returns_round_off_paise_check' and pg_get_constraintdef(oid)='CHECK ((round_off_paise <= 50))')),
   (exists(select 1 from pg_proc where oid=to_regprocedure('public.post_purchase_v2(uuid,text,jsonb)')
      and position('dsb.purchase.v2.payment:' in prosrc)>0 and position('DSB_TOTAL_MISMATCH' in prosrc)>0
      and position('r0_round_off(' in prosrc)>0)
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.phase65_post_return_unlocked(text,uuid,date,text,jsonb,text)')
      and position('v_purchase.round_off_paise<>0' in prosrc)>0 and position('round_off_paise=v_round,posted_at' in prosrc)>0)
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.check_invariants()')
      and position('purchase_return_items i where i.purchase_return_id=r.id)+r.round_off_paise' in prosrc)>0)
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.phase65_purchase_return_guard()')
      and position('new.round_off_paise=old.round_off_paise' in prosrc)>0)
    and exists(select 1 from information_schema.columns where table_schema='public' and table_name='purchase_returns' and column_name='round_off_paise')
    and position('round_off_paise bigint' in coalesce(pg_get_function_result(to_regprocedure('public.get_purchase_register(uuid,date,date)')),''))>0
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.void_paid_purchase(uuid,text,text)')
      and position('void_supplier_payment' in prosrc)>0)
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.bx_purchase_line_total(numeric,bigint,integer,integer)')
      and position('div(' in prosrc)>0)
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.get_financial_request(uuid,text,text)')
      and position('purchase.post.v2' in prosrc)>0)
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.check_invariants()')
      and position('b.extra_charges_paise+b.round_off_paise' in prosrc)>0)
    and exists(select 1 from pg_constraint where conrelid=to_regclass('public.purchase_bills')
      and pg_get_constraintdef(oid)='CHECK (((round_off_paise >= ''-49''::integer) AND (round_off_paise <= 50)))')
    and exists(select 1 from pg_constraint where conname='financial_requests_operation_check'
      and position('purchase.post.v2' in pg_get_constraintdef(oid))>0)),
   (case when to_regclass('public.purchase_bill_charges') is null or to_regclass('public.purchase_bill_images') is null
          or to_regprocedure('public.post_purchase_v2(uuid,text,jsonb)') is null
          or to_regprocedure('public.void_paid_purchase(uuid,text,text)') is null then false
     else has_function_privilege('authenticated','public.post_purchase_v2(uuid,text,jsonb)','execute')
      and has_function_privilege('authenticated','public.void_paid_purchase(uuid,text,text)','execute')
      and not has_function_privilege('anon','public.post_purchase_v2(uuid,text,jsonb)','execute')
      and not has_function_privilege('anon','public.void_paid_purchase(uuid,text,text)','execute')
      and has_table_privilege('authenticated','public.purchase_bill_charges','select')
      and has_table_privilege('authenticated','public.purchase_bill_images','select')
      and not has_table_privilege('authenticated','public.purchase_bill_charges','insert,update,delete')
      and not has_table_privilege('authenticated','public.purchase_bill_images','insert,update,delete') end),
   ((select count(*) from pg_trigger where not tgisinternal and tgname in ('purchase_bill_charges_check','purchase_bill_images_check',
      'purchase_bill_charges_immutable','purchase_bill_images_immutable','purchase_bills_round_off_immutable'))=5),
   (position('''purchaseCharges'',coalesce' in coalesce(pg_get_functiondef(to_regprocedure('public.phase6_export_tenant(uuid)')),''))>0
    and position('''purchaseImages'',coalesce' in coalesce(pg_get_functiondef(to_regprocedure('public.phase6_export_tenant(uuid)')),''))>0)
 ) p(ok) where ok);
SQL
)
read -r billextras_receipt billextras_anchors <<<"$(tail -n 1 <<<"$billextras_probe")"
case "$billextras_receipt:$billextras_anchors" in
 f:0) billextras=0; needs_billextras=true ;;
 f:6) billextras=1; needs_billextras=true ;;
 t:6) billextras=2; needs_billextras=false ;;
 *) echo "Purchase bill extras partial/drift state ($billextras_receipt/$billextras_anchors). Refusing migration." >&2; exit 1 ;;
esac
if [[ "$billextras" == '2' ]]; then
 billextras_expected=$(sha256sum "$repo_root/supabase/migrations/0064_purchase_bill_extras.sql" | cut -d' ' -f1)
 billextras_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c "select checksum_sha256 from public.app_migration_receipts where version='0064'")
 [[ "$billextras_expected" == "$billextras_recorded" ]] || { echo '0064 receipt checksum mismatch. Refusing migration.' >&2; exit 1; }
fi
# A later packet is not allowed to appear ahead of its predecessor, except a full reset awaiting receipts.
if [[ "$billextras" != '0' && "$itemindex" != '2' && ! ( "$billextras" == '1' && "$itemindex" == '1' ) ]]; then
 echo 'Purchase bill extras appear ahead of completed item history indexes. Refusing migration.' >&2; exit 1
fi

# Sale pricing (0065): additive classifier field. Five anchors, all or nothing. phase5_sync_post_sale keeps the
# batchb anchors (six places, intentFingerprint) and post_sale/r0_sync_post_sale are not redefined.
salepricing_probe=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -F' ' <<'SQL'
do $$ begin
 create temp table _salepricing_receipt (present boolean);
 if to_regclass('public.app_migration_receipts') is not null then
   insert into _salepricing_receipt select exists(select 1 from public.app_migration_receipts where version='0065');
 else insert into _salepricing_receipt values(false); end if;
end $$;
select (select present from _salepricing_receipt),
 (select count(*) from (values
   ((select count(*) from information_schema.columns where table_schema='public' and (
      (table_name='sale_invoices' and column_name in ('invoice_type','tax_paise','credit_limit_snapshot_paise','credit_outstanding_snapshot_paise','credit_override_by'))
      or (table_name='sale_invoice_items' and column_name in ('price_source','list_price_snapshot_paise','overridden_by','tax_paise'))
      or (table_name='customers' and column_name='sale_credit_limit_paise')))=10
    and exists(select 1 from pg_constraint where conrelid=to_regclass('public.sale_invoices') and conname='sale_invoices_tax_type_check')
    and exists(select 1 from pg_constraint where conrelid=to_regclass('public.sale_invoice_items') and conname='sale_invoice_items_manual_by_check')),
   (exists(select 1 from pg_proc where oid=to_regprocedure('public.phase4_post_sale_unlocked(uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text)')
      and position('DSB_PRICE_OVERRIDE_NOT_PERMITTED' in prosrc)>0 and position('DSB_CREDIT_LIMIT_EXCEEDED' in prosrc)>0
      and position('DSB_GST_EXTRA_BILL_DISCOUNT' in prosrc)>0 and position('sp_gst_extra_tax(' in prosrc)>0
      and position('if not v_v2 or coalesce(current_setting(''dsb.sale_credit_override''' in prosrc)>0
      and position('if v_v2 and p_customer_id is not null' in prosrc)=0)
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.phase5_sync_post_sale(text,integer,uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text)')
      and position('''sale_v2'',jsonb_build_object' in prosrc)>0)
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.sp_gst_extra_tax(bigint,integer)') and position('div(' in prosrc)>0)
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.get_gst_summary(uuid,date,date)') and position('extra_taxable' in prosrc)>0)),
   (case when to_regprocedure('public.sp_sync_post_sale(text,integer,uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text,text,boolean,bigint)') is null then false
     else exists(select 1 from pg_proc where oid=to_regprocedure('public.sp_sync_post_sale(text,integer,uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text,text,boolean,bigint)')
       and position('DSB_TOTAL_MISMATCH' in prosrc)>0)
      and has_function_privilege('authenticated','public.sp_sync_post_sale(text,integer,uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text,text,boolean,bigint)','execute')
      and not has_function_privilege('anon','public.sp_sync_post_sale(text,integer,uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text,text,boolean,bigint)','execute')
      and coalesce(has_function_privilege('authenticated',to_regprocedure('public.set_item_tax_rate(uuid,integer)'),'execute'),false)
      and not coalesce(has_function_privilege('anon',to_regprocedure('public.set_item_tax_rate(uuid,integer)'),'execute'),true)
      and exists(select 1 from pg_proc where oid=to_regprocedure('public.set_item_tax_rate(uuid,integer)')
        and position('''owner'',''manager''' in prosrc)>0) end),
   ((select count(*) from pg_trigger where not tgisinternal and tgname in ('sp_sale_fields_immutable','sp_customer_credit_limit_guard','sale_items_immutable'))=3),
   (case when to_regprocedure('public.sp_list_price(uuid,uuid,uuid,text,integer)') is null then false
     else not has_function_privilege('authenticated','public.sp_list_price(uuid,uuid,uuid,text,integer)','execute')
      and not has_function_privilege('authenticated','public.phase4_post_sale_unlocked(uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text)','execute') end)
 ) p(ok) where ok);
SQL
)
read -r salepricing_receipt salepricing_anchors <<<"$(tail -n 1 <<<"$salepricing_probe")"
case "$salepricing_receipt:$salepricing_anchors" in
 f:0) salepricing=0; needs_salepricing=true ;;
 f:5) salepricing=1; needs_salepricing=true ;;
 t:5) salepricing=2; needs_salepricing=false ;;
 *) echo "Sale pricing partial/drift state ($salepricing_receipt/$salepricing_anchors). Refusing migration." >&2; exit 1 ;;
esac
if [[ "$salepricing" == '2' ]]; then
 salepricing_expected=$(sha256sum "$repo_root/supabase/migrations/0065_sale_pricing.sql" | cut -d' ' -f1)
 salepricing_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c "select checksum_sha256 from public.app_migration_receipts where version='0065'")
 [[ "$salepricing_expected" == "$salepricing_recorded" ]] || { echo '0065 receipt checksum mismatch. Refusing migration.' >&2; exit 1; }
fi
if [[ "$salepricing" != '0' && "$billextras" != '2' && ! ( "$salepricing" == '1' && "$billextras" == '1' ) ]]; then
 echo 'Sale pricing appears ahead of completed purchase bill extras. Refusing migration.' >&2; exit 1
fi

# Purchase bill edit (0066): additive classifier field. Four anchors, all or nothing. get_financial_request is
# redefined and keeps the billextras anchor ('purchase.post.v2').
billedit_probe=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -F' ' <<'SQL'
do $$ begin
 create temp table _billedit_receipt (present boolean);
 if to_regclass('public.app_migration_receipts') is not null then
   insert into _billedit_receipt select exists(select 1 from public.app_migration_receipts where version='0066');
 else insert into _billedit_receipt values(false); end if;
end $$;
select (select present from _billedit_receipt),
 (select count(*) from (values
   ((select count(*) from information_schema.columns where table_schema='public' and table_name='purchase_bills'
      and column_name in ('edited_from_id','replaced_by_id'))=2
    and exists(select 1 from pg_constraint where conrelid=to_regclass('public.purchase_bills') and conname='purchase_bills_replaced_void_check'
      and pg_get_constraintdef(oid)='CHECK (((replaced_by_id IS NULL) OR (status = ''VOID''::text)))')
    and exists(select 1 from pg_constraint where conrelid=to_regclass('public.purchase_bills') and conname='purchase_bills_edited_from_fk')
    and exists(select 1 from pg_constraint where conrelid=to_regclass('public.purchase_bills') and conname='purchase_bills_replaced_by_fk')
    and to_regclass('public.purchase_bills_edited_from_key') is not null
    and to_regclass('public.purchase_bills_replaced_by_key') is not null),
   (exists(select 1 from pg_proc where oid=to_regprocedure('public.edit_purchase_bill(uuid,text,jsonb)')
      and position('DSB_EDIT_STOCK_CONSUMED' in prosrc)>0 and position('post_purchase_v2(' in prosrc)>0
      and position('void_purchase(' in prosrc)>0 and position('dsb_lock_shop_finance(' in prosrc)>0
      and position('''owner'',''manager''' in prosrc)>0 and position('DSB_EDIT_PAYMENT_GONE' in prosrc)>0)
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.void_paid_purchase(uuid,text,text)')
      and position('v_cur.edited_from_id' in prosrc)>0 and position('void_supplier_payment' in prosrc)>0)
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.get_financial_request(uuid,text,text)')
      and position('purchase.edit.v1' in prosrc)>0 and position('purchase.post.v2' in prosrc)>0)
    and exists(select 1 from pg_constraint where conname='financial_requests_operation_check'
      and position('purchase.edit.v1' in pg_get_constraintdef(oid))>0)),
   (case when to_regprocedure('public.edit_purchase_bill(uuid,text,jsonb)') is null
          or to_regprocedure('public.be_purchase_link_guard()') is null then false
     else has_function_privilege('authenticated','public.edit_purchase_bill(uuid,text,jsonb)','execute')
      and not has_function_privilege('anon','public.edit_purchase_bill(uuid,text,jsonb)','execute')
      and not has_function_privilege('authenticated','public.be_purchase_link_guard()','execute') end),
   (exists(select 1 from pg_trigger where not tgisinternal and tgname='purchase_bills_edit_link_guard'
      and tgrelid=to_regclass('public.purchase_bills') and tgenabled='O'))
 ) p(ok) where ok);
SQL
)
read -r billedit_receipt billedit_anchors <<<"$(tail -n 1 <<<"$billedit_probe")"
case "$billedit_receipt:$billedit_anchors" in
 f:0) billedit=0; needs_billedit=true ;;
 f:4) billedit=1; needs_billedit=true ;;
 t:4) billedit=2; needs_billedit=false ;;
 *) echo "Purchase bill edit partial/drift state ($billedit_receipt/$billedit_anchors). Refusing migration." >&2; exit 1 ;;
esac
if [[ "$billedit" == '2' ]]; then
 billedit_expected=$(sha256sum "$repo_root/supabase/migrations/0066_purchase_bill_edit.sql" | cut -d' ' -f1)
 billedit_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c "select checksum_sha256 from public.app_migration_receipts where version='0066'")
 [[ "$billedit_expected" == "$billedit_recorded" ]] || { echo '0066 receipt checksum mismatch. Refusing migration.' >&2; exit 1; }
fi
if [[ "$billedit" != '0' && "$salepricing" != '2' && ! ( "$billedit" == '1' && "$salepricing" == '1' ) ]]; then
 echo 'Purchase bill edit appears ahead of completed sale pricing. Refusing migration.' >&2; exit 1
fi

# Document remarks (0067): additive classifier field. Four anchors, all or nothing. phase6_export_tenant is
# redefined and keeps the billextras anchors ('purchaseCharges', 'purchaseImages').
remarks_probe=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -F' ' <<'SQL'
do $$ begin
 create temp table _remarks_receipt (present boolean);
 if to_regclass('public.app_migration_receipts') is not null then
   insert into _remarks_receipt select exists(select 1 from public.app_migration_receipts where version='0067');
 else insert into _remarks_receipt values(false); end if;
end $$;
select (select present from _remarks_receipt),
 (select count(*) from (values
   (to_regclass('public.document_remarks') is not null and to_regclass('public.document_remark_events') is not null
    and coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.document_remarks')),false)
    and coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.document_remark_events')),false)
    and exists(select 1 from pg_constraint where conrelid=to_regclass('public.document_remarks') and conname='document_remarks_doc_check')
    and exists(select 1 from pg_constraint where conrelid=to_regclass('public.document_remarks') and conname='document_remarks_settled_check')
    and exists(select 1 from pg_policy where polrelid=to_regclass('public.document_remarks') and polname='document_remarks_read')
    and exists(select 1 from pg_policy where polrelid=to_regclass('public.document_remark_events') and polname='document_remark_events_read')),
   (exists(select 1 from pg_proc where oid=to_regprocedure('public.add_document_remark(uuid,text,uuid,text,text)')
      and position('DSB_PAYLOAD_MISMATCH' in prosrc)>0 and position('dr_can_see(' in prosrc)>0)
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.reopen_document_remark(uuid)')
      and position('''owner'',''manager''' in prosrc)>0)
    and to_regprocedure('public.edit_document_remark(uuid,text,integer)') is not null
    and to_regprocedure('public.settle_document_remark(uuid)') is not null
    and to_regprocedure('public.list_document_remarks(text,uuid)') is not null
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.list_open_remarks(uuid)')
      and (position('dr_current_purchase(' in prosrc)>0 or position('open_chain' in prosrc)>0))
    and position('''documentRemarkEvents'',coalesce' in coalesce(pg_get_functiondef(to_regprocedure('public.phase6_export_tenant(uuid)')),''))>0),
   (case when to_regprocedure('public.add_document_remark(uuid,text,uuid,text,text)') is null
          or to_regprocedure('public.reopen_document_remark(uuid)') is null
          or to_regprocedure('public.dr_remark_history()') is null
          or to_regclass('public.document_remarks') is null or to_regclass('public.document_remark_events') is null then false
     else has_function_privilege('authenticated','public.add_document_remark(uuid,text,uuid,text,text)','execute')
      and not has_function_privilege('anon','public.add_document_remark(uuid,text,uuid,text,text)','execute')
      and not has_function_privilege('anon','public.reopen_document_remark(uuid)','execute')
      and not has_function_privilege('authenticated','public.dr_remark_history()','execute')
      and not has_table_privilege('authenticated','public.document_remarks','insert,update,delete')
      and not has_table_privilege('authenticated','public.document_remark_events','insert,update,delete') end),
   ((select count(*) from pg_trigger where not tgisinternal and tgenabled='O' and (
      (tgrelid=to_regclass('public.document_remarks') and tgname in ('document_remarks_guard','document_remarks_history'))
      or (tgrelid=to_regclass('public.document_remark_events') and tgname='document_remark_events_guard')))=3)
 ) p(ok) where ok);
SQL
)
read -r remarks_receipt remarks_anchors <<<"$(tail -n 1 <<<"$remarks_probe")"
case "$remarks_receipt:$remarks_anchors" in
 f:0) remarks=0; needs_remarks=true ;;
 f:4) remarks=1; needs_remarks=true ;;
 t:4) remarks=2; needs_remarks=false ;;
 *) echo "Document remarks partial/drift state ($remarks_receipt/$remarks_anchors). Refusing migration." >&2; exit 1 ;;
esac
if [[ "$remarks" == '2' ]]; then
 remarks_expected=$(sha256sum "$repo_root/supabase/migrations/0067_document_remarks.sql" | cut -d' ' -f1)
 remarks_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c "select checksum_sha256 from public.app_migration_receipts where version='0067'")
 [[ "$remarks_expected" == "$remarks_recorded" ]] || { echo '0067 receipt checksum mismatch. Refusing migration.' >&2; exit 1; }
fi
if [[ "$remarks" != '0' && "$billedit" != '2' && ! ( "$remarks" == '1' && "$billedit" == '1' ) ]]; then
 echo 'Document remarks appear ahead of completed purchase bill edit. Refusing migration.' >&2; exit 1
fi

# Remarks fixes (0068): additive classifier field. Two anchors, all or nothing: the exact-replay
# edit_document_remark and the set-based list_open_remarks (0067 'remarks' accepts either list body), each
# with its grants (authenticated only).
remarksfix_probe=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -F' ' <<'SQL'
do $$ begin
 create temp table _remarksfix_receipt (present boolean);
 if to_regclass('public.app_migration_receipts') is not null then
   insert into _remarksfix_receipt select exists(select 1 from public.app_migration_receipts where version='0068');
 else insert into _remarksfix_receipt values(false); end if;
end $$;
select (select present from _remarksfix_receipt),
 (select count(*) from (values
   (exists(select 1 from pg_proc where oid=to_regprocedure('public.edit_document_remark(uuid,text,integer)')
      and position('e.action=''EDIT''' in prosrc)>0 and position('p_expected_version is null' in prosrc)>0)
    and has_function_privilege('authenticated','public.edit_document_remark(uuid,text,integer)','execute')
    and not has_function_privilege('anon','public.edit_document_remark(uuid,text,integer)','execute')),
   (exists(select 1 from pg_proc where oid=to_regprocedure('public.list_open_remarks(uuid)')
      and position('open_chain' in prosrc)>0 and position('limit 500' in prosrc)>0)
    and has_function_privilege('authenticated','public.list_open_remarks(uuid)','execute')
    and not has_function_privilege('anon','public.list_open_remarks(uuid)','execute'))
 ) p(ok) where ok);
SQL
)
read -r remarksfix_receipt remarksfix_anchors <<<"$(tail -n 1 <<<"$remarksfix_probe")"
case "$remarksfix_receipt:$remarksfix_anchors" in
 f:0) remarksfix=0; needs_remarksfix=true ;;
 f:2) remarksfix=1; needs_remarksfix=true ;;
 t:2) remarksfix=2; needs_remarksfix=false ;;
 *) echo "Remarks fixes partial/drift state ($remarksfix_receipt/$remarksfix_anchors). Refusing migration." >&2; exit 1 ;;
esac
if [[ "$remarksfix" == '2' ]]; then
 remarksfix_expected=$(sha256sum "$repo_root/supabase/migrations/0068_remarks_fixes.sql" | cut -d' ' -f1)
 remarksfix_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c "select checksum_sha256 from public.app_migration_receipts where version='0068'")
 [[ "$remarksfix_expected" == "$remarksfix_recorded" ]] || { echo '0068 receipt checksum mismatch. Refusing migration.' >&2; exit 1; }
fi
if [[ "$remarksfix" != '0' && "$remarks" != '2' && ! ( "$remarksfix" == '1' && "$remarks" == '1' ) ]]; then
 echo 'Remarks fixes appear ahead of completed document remarks. Refusing migration.' >&2; exit 1
fi

# Bill codes (0069): additive classifier field. Four anchors, all or nothing: the NOT NULL bill_code columns with
# their format checks, the per-shop unique indexes, the two enabled guard triggers (with the collision-checked
# generator body), and the function grants (generator/guard server-only, find_bills_by_code signed-in only).
billcode_probe=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -F' ' <<'SQL'
do $$ begin
 create temp table _billcode_receipt (present boolean);
 if to_regclass('public.app_migration_receipts') is not null then
   insert into _billcode_receipt select exists(select 1 from public.app_migration_receipts where version='0069');
 else insert into _billcode_receipt values(false); end if;
end $$;
select (select present from _billcode_receipt),
 (select count(*) from (values
   ((select count(*) from pg_attribute a where a.attnum>0 and not a.attisdropped and a.attname='bill_code' and a.attnotnull
       and a.atttypid='text'::regtype and a.attrelid in (to_regclass('public.purchase_bills'),to_regclass('public.sale_invoices')))=2
    and (select count(*) from pg_constraint c where c.contype='c' and c.convalidated
       and c.conname in ('purchase_bills_bill_code_format','sale_invoices_bill_code_format'))=2),
   ((select count(*) from pg_index i join pg_class c on c.oid=i.indexrelid
       where i.indisunique and i.indisvalid and i.indpred is null
         and c.relname in ('purchase_bills_bill_code_key','sale_invoices_bill_code_key')
         and pg_get_indexdef(i.indexrelid) like '%(shop_id, bill_code)')=2),
   ((select count(*) from pg_trigger t where not t.tgisinternal and t.tgenabled='O'
       and t.tgfoid=to_regprocedure('public.dsb_bill_code_guard()') and t.tgtype=23
       and ((t.tgrelid=to_regclass('public.purchase_bills') and t.tgname='purchase_bills_bill_code')
         or (t.tgrelid=to_regclass('public.sale_invoices') and t.tgname='sale_invoices_bill_code')))=2
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.dsb_new_bill_code(uuid,boolean)')
       and position('DSB_BILL_CODE_EXHAUSTED' in prosrc)>0 and position('pg_advisory_xact_lock' in prosrc)>0)),
   (case when to_regprocedure('public.dsb_bill_code_candidate()') is null or to_regprocedure('public.dsb_new_bill_code(uuid,boolean)') is null
          or to_regprocedure('public.dsb_bill_code_guard()') is null or to_regprocedure('public.find_bills_by_code(uuid,text)') is null then false
     else has_function_privilege('authenticated','public.find_bills_by_code(uuid,text)','execute')
      and not has_function_privilege('anon','public.find_bills_by_code(uuid,text)','execute')
      and not has_function_privilege('anon','public.dsb_bill_code_candidate()','execute')
      and not has_function_privilege('authenticated','public.dsb_bill_code_candidate()','execute')
      and not has_function_privilege('anon','public.dsb_new_bill_code(uuid,boolean)','execute')
      and not has_function_privilege('authenticated','public.dsb_new_bill_code(uuid,boolean)','execute')
      and not has_function_privilege('anon','public.dsb_bill_code_guard()','execute')
      and not has_function_privilege('authenticated','public.dsb_bill_code_guard()','execute') end)
 ) p(ok) where ok);
SQL
)
read -r billcode_receipt billcode_anchors <<<"$(tail -n 1 <<<"$billcode_probe")"
case "$billcode_receipt:$billcode_anchors" in
 f:0) billcode=0; needs_billcode=true ;;
 f:4) billcode=1; needs_billcode=true ;;
 t:4) billcode=2; needs_billcode=false ;;
 *) echo "Bill codes partial/drift state ($billcode_receipt/$billcode_anchors). Refusing migration." >&2; exit 1 ;;
esac
if [[ "$billcode" == '2' ]]; then
 billcode_expected=$(sha256sum "$repo_root/supabase/migrations/0069_bill_codes.sql" | cut -d' ' -f1)
 billcode_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c "select checksum_sha256 from public.app_migration_receipts where version='0069'")
 [[ "$billcode_expected" == "$billcode_recorded" ]] || { echo '0069 receipt checksum mismatch. Refusing migration.' >&2; exit 1; }
fi
if [[ "$billcode" != '0' && "$remarksfix" != '2' && ! ( "$billcode" == '1' && "$remarksfix" == '1' ) ]]; then
 echo 'Bill codes appear ahead of completed remarks fixes. Refusing migration.' >&2; exit 1
fi

# Backlog (0070): additive classifier field. Four anchors, all or nothing: the free-text line schema (nullable
# item_id, line_kind, validated check), the enabled return guard trigger (server-only function), the redefined
# sale body and void body (server-only), and the manager audit-feed permission with the narrow audit_feed view (raw audit_log owner-only).
backlog_probe=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -F' ' <<'SQL'
do $$ begin
 create temp table _backlog_receipt (present boolean);
 if to_regclass('public.app_migration_receipts') is not null then
   insert into _backlog_receipt select exists(select 1 from public.app_migration_receipts where version='0070');
 else insert into _backlog_receipt values(false); end if;
end $$;
select (select present from _backlog_receipt),
 (select count(*) from (values
   ((select count(*) from pg_attribute a where a.attrelid=to_regclass('public.sale_invoice_items') and a.attnum>0 and not a.attisdropped
       and ((a.attname='item_id' and not a.attnotnull) or (a.attname='line_kind' and a.attnotnull and a.atttypid='text'::regtype)))=2
    and exists(select 1 from pg_constraint c where c.conrelid=to_regclass('public.sale_invoice_items') and c.contype='c' and c.convalidated
       and c.conname='sale_invoice_items_free_text_check')),
   ((select count(*) from pg_trigger t where not t.tgisinternal and t.tgenabled='O' and t.tgname='sale_return_items_free_text_guard'
       and t.tgrelid=to_regclass('public.sale_return_items') and t.tgfoid=to_regprocedure('public.ft_sale_return_guard()'))=1
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.ft_sale_return_guard()') and position('DSB_FREE_TEXT_NOT_RETURNABLE' in prosrc)>0)
    and not has_function_privilege('authenticated','public.ft_sale_return_guard()','execute')
    and not has_function_privilege('anon','public.ft_sale_return_guard()','execute')),
   (exists(select 1 from pg_proc where oid=to_regprocedure('public.phase4_post_sale_unlocked(uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text)')
      and position('DSB_FREE_TEXT_INVALID' in prosrc)>0 and position('''free_text''' in prosrc)>0)
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.c0_void_sale_body(uuid,text)')
      and position('line_kind=''item''' in prosrc)>0)
    and not has_function_privilege('authenticated','public.c0_void_sale_body(uuid,text)','execute')),
   (exists(select 1 from public.role_permissions where role='manager' and code='VIEW_AUDIT_FEED')
    and not exists(select 1 from public.role_permissions where role in ('manager','cashier','accountant') and code='VIEW_AUDIT_LOG')
    and exists(select 1 from pg_class where oid=to_regclass('public.audit_feed') and relkind='v'
      and not coalesce(reloptions,'{}') @> array['security_invoker=true']
      and position('VIEW_AUDIT_FEED' in pg_get_viewdef(oid))>0 and position('current_tenant_id()' in pg_get_viewdef(oid))>0)
    and has_table_privilege('authenticated','public.audit_feed','select')
    and not has_table_privilege('anon','public.audit_feed','select')
    and not has_table_privilege('authenticated','public.audit_feed','insert'))
 ) p(ok) where ok);
SQL
)
read -r backlog_receipt backlog_anchors <<<"$(tail -n 1 <<<"$backlog_probe")"
case "$backlog_receipt:$backlog_anchors" in
 f:0) backlog=0; needs_backlog=true ;;
 f:4) backlog=1; needs_backlog=true ;;
 t:4) backlog=2; needs_backlog=false ;;
 *) echo "Backlog (0070) partial/drift state ($backlog_receipt/$backlog_anchors). Refusing migration." >&2; exit 1 ;;
esac
if [[ "$backlog" == '2' ]]; then
 backlog_expected=$(sha256sum "$repo_root/supabase/migrations/0070_free_text_lines_audit.sql" | cut -d' ' -f1)
 backlog_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c "select checksum_sha256 from public.app_migration_receipts where version='0070'")
 [[ "$backlog_expected" == "$backlog_recorded" ]] || { echo '0070 receipt checksum mismatch. Refusing migration.' >&2; exit 1; }
fi
if [[ "$backlog" != '0' && "$billcode" != '2' && ! ( "$backlog" == '1' && "$billcode" == '1' ) ]]; then
 echo 'Backlog (0070) appears ahead of completed bill codes. Refusing migration.' >&2; exit 1
fi

# Offline items (0071): additive classifier field. 2 anchors, all or nothing.
offlineitems_probe=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -F' ' <<'SQL'
do $$ begin
 create temp table _offlineitems_receipt (present boolean);
 if to_regclass('public.app_migration_receipts') is not null then
   insert into _offlineitems_receipt select exists(select 1 from public.app_migration_receipts where version='0071');
 else insert into _offlineitems_receipt values(false); end if;
end $$;
select (select present from _offlineitems_receipt),
 (select count(*) from (values
   (exists(select 1 from pg_proc where oid=to_regprocedure('public.create_item_v2(uuid,text,jsonb)') and prosecdef and position('DSB_ITEM_NAME_TAKEN' in prosrc)>0 and position('dsb:item-name:' in prosrc)>0 and position('DSB_PAYLOAD_MISMATCH' in prosrc)>0)),
   (coalesce(has_function_privilege('authenticated',to_regprocedure('public.create_item_v2(uuid,text,jsonb)'),'execute'),false) and not coalesce(has_function_privilege('anon',to_regprocedure('public.create_item_v2(uuid,text,jsonb)'),'execute'),false))
 ) p(ok) where ok);
SQL
)
read -r offlineitems_receipt offlineitems_anchors <<<"$(tail -n 1 <<<"$offlineitems_probe")"
case "$offlineitems_receipt:$offlineitems_anchors" in
 f:0) offlineitems=0; needs_offlineitems=true ;;
 f:2) offlineitems=1; needs_offlineitems=true ;;
 t:2) offlineitems=2; needs_offlineitems=false ;;
 *) echo "Offline items (0071) partial/drift state ($offlineitems_receipt/$offlineitems_anchors). Refusing migration." >&2; exit 1 ;;
esac
if [[ "$offlineitems" == '2' ]]; then
 offlineitems_expected=$(sha256sum "$repo_root/supabase/migrations/0071_offline_items.sql" | cut -d' ' -f1)
 offlineitems_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c "select checksum_sha256 from public.app_migration_receipts where version='0071'")
 [[ "$offlineitems_expected" == "$offlineitems_recorded" ]] || { echo '0071 receipt checksum mismatch. Refusing migration.' >&2; exit 1; }
fi
if [[ "$offlineitems" != '0' && "$backlog" != '2' && ! ( "$offlineitems" == '1' && "$backlog" == '1' ) ]]; then
 echo 'Offline items (0071) appears ahead of completed backlog. Refusing migration.' >&2; exit 1
fi

# Offline bill edit and void (0072): additive classifier field. 3 anchors, all or nothing.
offlinebillchange_probe=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -F' ' <<'SQL'
do $$ begin
 create temp table _offlinebillchange_receipt (present boolean);
 if to_regclass('public.app_migration_receipts') is not null then
   insert into _offlinebillchange_receipt select exists(select 1 from public.app_migration_receipts where version='0072');
 else insert into _offlinebillchange_receipt values(false); end if;
end $$;
select (select present from _offlinebillchange_receipt),
 (select count(*) from (values
   (exists(select 1 from pg_proc where oid=to_regprocedure('public.edit_purchase_bill_if_unchanged(uuid,text,jsonb,text)') and prosecdef and position('DSB_BILL_CHANGED' in prosrc)>0 and position('dsb_request_result' in prosrc)>0) and exists(select 1 from pg_proc where oid=to_regprocedure('public.void_purchase_if_unchanged(uuid,text,text,text)') and prosecdef and position('DSB_BILL_CHANGED' in prosrc)>0 and position('DSB_VOID_HAS_PAYMENTS' in prosrc)>0)),
   (coalesce(has_function_privilege('authenticated',to_regprocedure('public.edit_purchase_bill_if_unchanged(uuid,text,jsonb,text)'),'execute'),false) and not coalesce(has_function_privilege('anon',to_regprocedure('public.edit_purchase_bill_if_unchanged(uuid,text,jsonb,text)'),'execute'),false) and coalesce(has_function_privilege('authenticated',to_regprocedure('public.void_purchase_if_unchanged(uuid,text,text,text)'),'execute'),false) and not coalesce(has_function_privilege('anon',to_regprocedure('public.void_purchase_if_unchanged(uuid,text,text,text)'),'execute'),false) and coalesce(has_function_privilege('authenticated',to_regprocedure('public.get_purchase_bill_version(uuid)'),'execute'),false) and not coalesce(has_function_privilege('anon',to_regprocedure('public.get_purchase_bill_version(uuid)'),'execute'),false) and not coalesce(has_function_privilege('authenticated',to_regprocedure('public.obc_bill_version(uuid,uuid)'),'execute'),false)),
   (exists(select 1 from pg_constraint where conrelid=to_regclass('public.financial_requests') and conname='financial_requests_operation_check' and position('purchase.void.offline.v1' in pg_get_constraintdef(oid))>0) and exists(select 1 from pg_proc where oid=to_regprocedure('public.get_financial_request(uuid,text,text)') and position('purchase.void.offline.v1' in prosrc)>0))
 ) p(ok) where ok);
SQL
)
read -r offlinebillchange_receipt offlinebillchange_anchors <<<"$(tail -n 1 <<<"$offlinebillchange_probe")"
case "$offlinebillchange_receipt:$offlinebillchange_anchors" in
 f:0) offlinebillchange=0; needs_offlinebillchange=true ;;
 f:3) offlinebillchange=1; needs_offlinebillchange=true ;;
 t:3) offlinebillchange=2; needs_offlinebillchange=false ;;
 *) echo "Offline bill edit and void (0072) partial/drift state ($offlinebillchange_receipt/$offlinebillchange_anchors). Refusing migration." >&2; exit 1 ;;
esac
if [[ "$offlinebillchange" == '2' ]]; then
 offlinebillchange_expected=$(sha256sum "$repo_root/supabase/migrations/0072_offline_bill_changes.sql" | cut -d' ' -f1)
 offlinebillchange_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c "select checksum_sha256 from public.app_migration_receipts where version='0072'")
 [[ "$offlinebillchange_expected" == "$offlinebillchange_recorded" ]] || { echo '0072 receipt checksum mismatch. Refusing migration.' >&2; exit 1; }
fi
if [[ "$offlinebillchange" != '0' && "$offlineitems" != '2' && ! ( "$offlinebillchange" == '1' && "$offlineitems" == '1' ) ]]; then
 echo 'Offline bill edit and void (0072) appears ahead of completed offlineitems. Refusing migration.' >&2; exit 1
fi

# Item name lock (0073): additive classifier field. 2 anchors, all or nothing.
itemnamelock_probe=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -F' ' <<'SQL'
do $$ begin
 create temp table _itemnamelock_receipt (present boolean);
 if to_regclass('public.app_migration_receipts') is not null then
   insert into _itemnamelock_receipt select exists(select 1 from public.app_migration_receipts where version='0073');
 else insert into _itemnamelock_receipt values(false); end if;
end $$;
select (select present from _itemnamelock_receipt),
 (select count(*) from (values
   (exists(select 1 from pg_proc where oid=to_regprocedure('public.items_name_guard()') and not prosecdef and position('dsb:item-name:' in prosrc)>0 and position('DSB_ITEM_NAME_TAKEN' in prosrc)>0 and position('authenticated' in prosrc)>0)
    and not coalesce(has_function_privilege('authenticated',to_regprocedure('public.items_name_guard()'),'execute'),false)
    and not coalesce(has_function_privilege('anon',to_regprocedure('public.items_name_guard()'),'execute'),false)),
   (exists(select 1 from pg_trigger where tgrelid=to_regclass('public.items') and tgname='items_name_guard' and not tgisinternal and tgenabled='O' and tgfoid=to_regprocedure('public.items_name_guard()')))
 ) p(ok) where ok);
SQL
)
read -r itemnamelock_receipt itemnamelock_anchors <<<"$(tail -n 1 <<<"$itemnamelock_probe")"
case "$itemnamelock_receipt:$itemnamelock_anchors" in
 f:0) itemnamelock=0; needs_itemnamelock=true ;;
 f:2) itemnamelock=1; needs_itemnamelock=true ;;
 t:2) itemnamelock=2; needs_itemnamelock=false ;;
 *) echo "Item name lock (0073) partial/drift state ($itemnamelock_receipt/$itemnamelock_anchors). Refusing migration." >&2; exit 1 ;;
esac
if [[ "$itemnamelock" == '2' ]]; then
 itemnamelock_expected=$(sha256sum "$repo_root/supabase/migrations/0073_item_name_lock.sql" | cut -d' ' -f1)
 itemnamelock_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c "select checksum_sha256 from public.app_migration_receipts where version='0073'")
 [[ "$itemnamelock_expected" == "$itemnamelock_recorded" ]] || { echo '0073 receipt checksum mismatch. Refusing migration.' >&2; exit 1; }
fi
if [[ "$itemnamelock" != '0' && "$offlinebillchange" != '2' && ! ( "$itemnamelock" == '1' && "$offlinebillchange" == '1' ) ]]; then
 echo 'Item name lock (0073) appears ahead of completed offlinebillchange. Refusing migration.' >&2; exit 1
fi

emit_state() {
  local needs_foundation=$1 needs_hardening=$2 needs_phase65=$3 needs_batcha=$4 needs_batchb=$5 needs_p1=$6 needs_p2=$7 needs_c0=$8 needs_c1=$9 needs_c2=${10} needs_c3=${11} needs_c3b=${12} needs_r0=${13} needs_d1=${14} needs_r0b=${15} needs_o1=${16} needs_o2=${17} needs_d2b=${18} needs_d3a=${19}
  local needs_upgrade=true
  if [[ "$needs_foundation:$needs_hardening:$needs_phase65:$needs_batcha:$needs_batchb:$needs_p1:$needs_p2:$needs_c0:$needs_c1:$needs_c2:$needs_c3:$needs_c3b:$needs_r0:$needs_d1:$needs_r0b:$needs_o1:$needs_o2:$needs_d2b:$needs_d3a" == "false:false:false:false:false:false:false:false:false:false:false:false:false:false:false:false:false:false:false" ]]; then
    if [[ "$needs_billdocs" == "false" && "$needs_partyarchive" == "false" && "$needs_profit" == "false" && "$needs_supplierschedule" == "false" && "$needs_partymerge" == "false" && "$needs_itemindex" == "false" && "$needs_billextras" == "false" && "$needs_salepricing" == "false" && "$needs_billedit" == "false" && "$needs_remarks" == "false" && "$needs_remarksfix" == "false" && "$needs_billcode" == "false" && "$needs_backlog" == "false" && "$needs_offlineitems" == "false" && "$needs_offlinebillchange" == "false" && "$needs_itemnamelock" == "false" ]]; then needs_upgrade=false; fi
  fi
  printf 'observed_state=%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s\n' "$foundation" "$hardening" "$phase65" "$batcha" "$batchb" "$p1" "$p2" "$c0" "$c1" "$c2" "$c3" "$c3b" "$r0" "$d1" "$r0b" "$o1" "$o2" "$d2b" "$d3a"
  printf 'needs_upgrade=%s\n' "$needs_upgrade"
  printf 'needs_foundation=%s\n' "$needs_foundation"
  printf 'needs_hardening=%s\n' "$needs_hardening"
  printf 'needs_phase65=%s\n' "$needs_phase65"
  printf 'needs_batcha=%s\n' "$needs_batcha"
  printf 'needs_batchb=%s\n' "$needs_batchb"
  printf 'needs_p1=%s\n' "$needs_p1"
  printf 'needs_p2=%s\n' "$needs_p2"
  printf 'needs_c0=%s\n' "$needs_c0"
  printf 'needs_c1=%s\n' "$needs_c1"
  printf 'needs_c2=%s\n' "$needs_c2"
  printf 'needs_c3=%s\n' "$needs_c3"
  printf 'needs_c3b=%s\n' "$needs_c3b"
  printf 'needs_r0=%s\n' "$needs_r0"
  printf 'needs_d1=%s\n' "$needs_d1"
  printf 'needs_r0b=%s\n' "$needs_r0b"
  printf 'needs_o1=%s\n' "$needs_o1"
  printf 'needs_o2=%s\n' "$needs_o2"
  printf 'needs_d2b=%s\n' "$needs_d2b"
  printf 'needs_d3a=%s\n' "$needs_d3a"
  printf 'billdocs_state=%s\n' "$billdocs"
  printf 'needs_billdocs=%s\n' "$needs_billdocs"
  printf 'partyarchive_state=%s\n' "$partyarchive"
  printf 'needs_partyarchive=%s\n' "$needs_partyarchive"
  printf 'profit_state=%s\n' "$profit"
  printf 'needs_profit=%s\n' "$needs_profit"
  printf 'supplierschedule_state=%s\n' "$supplierschedule"
  printf 'needs_supplierschedule=%s\n' "$needs_supplierschedule"
  printf 'partymerge_state=%s\n' "$partymerge"
  printf 'needs_partymerge=%s\n' "$needs_partymerge"
  printf 'itemindex_state=%s\n' "$itemindex"
  printf 'needs_itemindex=%s\n' "$needs_itemindex"
  printf 'billextras_state=%s\n' "$billextras"
  printf 'needs_billextras=%s\n' "$needs_billextras"
  printf 'salepricing_state=%s\n' "$salepricing"
  printf 'needs_salepricing=%s\n' "$needs_salepricing"
  printf 'billedit_state=%s\n' "$billedit"
  printf 'needs_billedit=%s\n' "$needs_billedit"
  printf 'remarks_state=%s\n' "$remarks"
  printf 'needs_remarks=%s\n' "$needs_remarks"
  printf 'remarksfix_state=%s\n' "$remarksfix"
  printf 'needs_remarksfix=%s\n' "$needs_remarksfix"
  printf 'billcode_state=%s\n' "$billcode"
  printf 'needs_billcode=%s\n' "$needs_billcode"
  printf 'backlog_state=%s\n' "$backlog"
  printf 'needs_backlog=%s\n' "$needs_backlog"
  printf 'offlineitems_state=%s\n' "$offlineitems"
  printf 'needs_offlineitems=%s\n' "$needs_offlineitems"
  printf 'offlinebillchange_state=%s\n' "$offlinebillchange"
  printf 'needs_offlinebillchange=%s\n' "$needs_offlinebillchange"
  printf 'itemnamelock_state=%s\n' "$itemnamelock"
  printf 'needs_itemnamelock=%s\n' "$needs_itemnamelock"
}

# Legacy (0030-0043) classification is unchanged from before Packet P1: the
# same case-statement, the same tuple matches, the same refusal on any
# partial/out-of-order state. Packet P1 (mechanism point 1) only appends a
# zero/false-default p1 column to every already-supported legacy state, plus
# one new terminal state where p1 is also complete. It does not rewrite the
# generic-iteration form (mechanism point 8) because that rewrite could not
# be verified here to preserve the exact existing legacy behavior without a
# live database to test against (see final report for this deviation).
case "$foundation:$hardening:$phase65:$batcha:$batchb:$p1:$p2:$c0:$c1:$c2:$c3:$c3b:$r0:$d1:$r0b:$o1:$o2:$d2b:$d3a" in
  0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0) emit_state true true true true true true true true true true true true true true true true true true true ;;
  5:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0) emit_state false true true true true true true true true true true true true true true true true true true ;;
  5:2:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0) emit_state false false true true true true true true true true true true true true true true true true true ;;
  5:2:5:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0) emit_state false false false true true true true true true true true true true true true true true true true ;;
  5:2:5:2:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0) emit_state false false false false true true true true true true true true true true true true true true true ;;
  5:2:5:2:3:0:0:0:0:0:0:0:0:0:0:0:0:0:0) emit_state false false false false false true true true true true true true true true true true true true true ;;
  5:2:5:2:3:3:0:0:0:0:0:0:0:0:0:0:0:0:0) emit_state false false false false false true true true true true true true true true true true true true true ;;
  # Fresh disposable reset before the receipt bootstrap: every receipt-tracked
  # group's schema exists, no receipts yet.
  5:2:5:2:3:3:0:1:1:1:1:1:1:1:1:1:1:1:1) emit_state false false false false false true true true true true true true true true true true true true true ;;
  5:2:5:2:3:4:0:0:0:0:0:0:0:0:0:0:0:0:0) emit_state false false false false false false true true true true true true true true true true true true true ;;
  5:2:5:2:3:4:1:0:0:0:0:0:0:0:0:0:0:0:0) emit_state false false false false false false false true true true true true true true true true true true true ;;
  5:2:5:2:3:4:1:1:0:0:0:0:0:0:0:0:0:0:0) emit_state false false false false false false false true true true true true true true true true true true true ;;
  5:2:5:2:3:4:1:2:0:0:0:0:0:0:0:0:0:0:0) emit_state false false false false false false false false true true true true true true true true true true true ;;
  5:2:5:2:3:4:1:2:1:0:0:0:0:0:0:0:0:0:0) emit_state false false false false false false false false true true true true true true true true true true true ;;
  5:2:5:2:3:4:1:2:2:0:0:0:0:0:0:0:0:0:0) emit_state false false false false false false false false false true true true true true true true true true true ;;
  5:2:5:2:3:4:1:2:2:1:0:0:0:0:0:0:0:0:0) emit_state false false false false false false false false false true true true true true true true true true true ;;
  5:2:5:2:3:4:1:2:2:2:0:0:0:0:0:0:0:0:0) emit_state false false false false false false false false false false true true true true true true true true true ;;
  5:2:5:2:3:4:1:2:2:2:1:0:0:0:0:0:0:0:0) emit_state false false false false false false false false false false true true true true true true true true true ;;
  5:2:5:2:3:4:1:2:2:2:2:0:0:0:0:0:0:0:0) emit_state false false false false false false false false false false false true true true true true true true true ;;
  5:2:5:2:3:4:1:2:2:2:2:1:0:0:0:0:0:0:0) emit_state false false false false false false false false false false false true true true true true true true true ;;
  5:2:5:2:3:4:1:2:2:2:2:2:0:0:0:0:0:0:0) emit_state false false false false false false false false false false false false true true true true true true true ;;
  5:2:5:2:3:4:1:2:2:2:2:2:1:0:0:0:0:0:0) emit_state false false false false false false false false false false false false true true true true true true true ;;
  5:2:5:2:3:4:1:2:2:2:2:2:2:0:0:0:0:0:0) emit_state false false false false false false false false false false false false false true true true true true true ;;
  5:2:5:2:3:4:1:2:2:2:2:2:2:1:0:0:0:0:0) emit_state false false false false false false false false false false false false false true true true true true true ;;
  5:2:5:2:3:4:1:2:2:2:2:2:2:2:0:0:0:0:0) emit_state false false false false false false false false false false false false false false true true true true true ;;
  5:2:5:2:3:4:1:2:2:2:2:2:2:2:1:0:0:0:0) emit_state false false false false false false false false false false false false false false true true true true true ;;
  5:2:5:2:3:4:1:2:2:2:2:2:2:2:2:0:0:0:0) emit_state false false false false false false false false false false false false false false false true true true true ;;
  5:2:5:2:3:4:1:2:2:2:2:2:2:2:2:1:0:0:0) emit_state false false false false false false false false false false false false false false false true true true true ;;
  5:2:5:2:3:4:1:2:2:2:2:2:2:2:2:2:0:0:0) emit_state false false false false false false false false false false false false false false false false true true true ;;
  5:2:5:2:3:4:1:2:2:2:2:2:2:2:2:2:1:0:0) emit_state false false false false false false false false false false false false false false false false true true true ;;
  5:2:5:2:3:4:1:2:2:2:2:2:2:2:2:2:2:0:0) emit_state false false false false false false false false false false false false false false false false false true true ;;
  5:2:5:2:3:4:1:2:2:2:2:2:2:2:2:2:2:1:0) emit_state false false false false false false false false false false false false false false false false false true true ;;
  5:2:5:2:3:4:1:2:2:2:2:2:2:2:2:2:2:2:0) emit_state false false false false false false false false false false false false false false false false false false true ;;
  5:2:5:2:3:4:1:2:2:2:2:2:2:2:2:2:2:2:1) emit_state false false false false false false false false false false false false false false false false false false true ;;
  5:2:5:2:3:4:1:2:2:2:2:2:2:2:2:2:2:2:2) emit_state false false false false false false false false false false false false false false false false false false false ;;
  *)
    echo "Partial or out-of-order Phase 6 schema detected ($foundation/5 foundation, $hardening/2 hardening, $phase65/5 Phase 6.5, $batcha/2 Batch A, $batchb/3 Batch B, $p1/4 P1, $p2/1 P2, $c0/2 C0, $c1/2 C1, $c2/2 C2, $c3/2 C3, $c3b/2 C3b, $r0/2 R0 bill round-off, $d1/2 D1, $r0b/2 R0b, $o1/2 O1, $o2/2 O2 opening settlements, $d2b/2 D2b shop settings guard, $d3a/2 D3a export request ledger). Refusing migration." >&2
    exit 1
    ;;
esac
