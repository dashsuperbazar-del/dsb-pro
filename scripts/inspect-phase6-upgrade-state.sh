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
    and coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.purchase_bill_images')),false)),
   (exists(select 1 from pg_constraint where conrelid=to_regclass('public.purchase_bills') and contype='c'
      and pg_get_constraintdef(oid)='CHECK ((payment_type = ANY (ARRAY[''credit''::text, ''cash''::text, ''upi''::text])))')
    and exists(select 1 from pg_constraint where conrelid=to_regclass('public.purchase_bill_items')
      and conname='purchase_bill_items_gst_snapshot_check')
    and exists(select 1 from information_schema.columns where table_schema='public' and table_name='purchase_bills' and column_name='notes')
    and exists(select 1 from information_schema.columns where table_schema='public' and table_name='purchase_bill_items' and column_name='discount_bp')),
   (exists(select 1 from pg_proc where oid=to_regprocedure('public.post_purchase_v2(uuid,text,jsonb)')
      and position('dsb.purchase.v2.payment:' in prosrc)>0 and position('DSB_TOTAL_MISMATCH' in prosrc)>0)
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.void_paid_purchase(uuid,text,text)')
      and position('void_supplier_payment' in prosrc)>0)
    and to_regprocedure('public.bx_purchase_line_total(numeric,bigint,integer,integer)') is not null
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
      'purchase_bill_charges_immutable','purchase_bill_images_immutable'))=4),
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

emit_state() {
  local needs_foundation=$1 needs_hardening=$2 needs_phase65=$3 needs_batcha=$4 needs_batchb=$5 needs_p1=$6 needs_p2=$7 needs_c0=$8 needs_c1=$9 needs_c2=${10} needs_c3=${11} needs_c3b=${12} needs_r0=${13} needs_d1=${14} needs_r0b=${15} needs_o1=${16} needs_o2=${17} needs_d2b=${18} needs_d3a=${19}
  local needs_upgrade=true
  if [[ "$needs_foundation:$needs_hardening:$needs_phase65:$needs_batcha:$needs_batchb:$needs_p1:$needs_p2:$needs_c0:$needs_c1:$needs_c2:$needs_c3:$needs_c3b:$needs_r0:$needs_d1:$needs_r0b:$needs_o1:$needs_o2:$needs_d2b:$needs_d3a" == "false:false:false:false:false:false:false:false:false:false:false:false:false:false:false:false:false:false:false" ]]; then
    if [[ "$needs_billdocs" == "false" && "$needs_partyarchive" == "false" && "$needs_profit" == "false" && "$needs_supplierschedule" == "false" && "$needs_partymerge" == "false" && "$needs_itemindex" == "false" && "$needs_billextras" == "false" ]]; then needs_upgrade=false; fi
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
