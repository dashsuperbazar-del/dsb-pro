begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

-- Shape: standard-column-exception control table, per docs/COMPLETE_REMAINING_BUILD_PLAN.md
-- §4 P1 ("This is an explicit global control-table standard-column exception, like schema_meta").
select has_table('public', 'app_migration_receipts', 'app_migration_receipts table exists');
select has_column('public', 'app_migration_receipts', 'version', 'has version column');
select has_column('public', 'app_migration_receipts', 'checksum_sha256', 'has checksum_sha256 column');
select has_column('public', 'app_migration_receipts', 'applied_at', 'has applied_at column');
select has_column('public', 'app_migration_receipts', 'applied_by', 'has applied_by column');
select col_is_pk('public', 'app_migration_receipts', 'version', 'version is the primary key');

-- A receipt for 0044 itself exists. In THIS job (pgtap, via `supabase db
-- reset` + the disposable-only backfill bootstrap), that receipt was
-- written by scripts/bootstrap-disposable-receipts.mjs, not by the atomic
-- Node transaction runner -- this assertion proves the row's shape and
-- presence, not same-transaction atomicity. Atomicity (the runner commits
-- schema + receipt together, or rolls back both) is proven separately by
-- the phase6_db_upgrade_proof job's live apply/no-op-rerun/checksum-tamper
-- CI steps against scripts/apply-migrations-with-receipts.mjs directly.
select ok(
  exists(select 1 from app_migration_receipts where version = '0044'),
  'receipt for 0044 itself is recorded'
);

-- RLS is enabled and, unlike schema_meta, there are no grants at all to
-- anon or authenticated: this is control-table data, not a cashier-visible
-- version banner.
select ok(
  (select relrowsecurity from pg_class where oid = 'public.app_migration_receipts'::regclass),
  'row level security is enabled'
);
select ok(
  not exists(
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'app_migration_receipts'
      and grantee in ('anon', 'authenticated')
  ),
  'no table grants exist for anon or authenticated'
);

set role anon;
select throws_ok(
  $$select * from app_migration_receipts$$,
  '42501',
  null,
  'anon cannot select app_migration_receipts'
);
reset role;

insert into auth.users(id) values ('af000000-0000-0000-0000-000000000002') on conflict do nothing;
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','af000000-0000-0000-0000-000000000002','role','authenticated')::text, true);
select throws_ok(
  $$select * from app_migration_receipts$$,
  '42501',
  null,
  'authenticated cannot select app_migration_receipts'
);
reset role;

select * from finish();
rollback;
