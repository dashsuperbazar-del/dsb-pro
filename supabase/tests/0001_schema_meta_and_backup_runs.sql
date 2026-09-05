begin;
create extension if not exists pgtap with schema extensions;

select plan(4);

-- backup_runs: RLS must deny anon and authenticated SELECT (default-deny, no
-- policies). anon/authenticated hold the table-level SELECT grant (see
-- migration), so RLS itself is what's actually under test here.
set role anon;
select is_empty(
  $$ select * from backup_runs $$,
  'anon cannot read backup_runs (RLS default-deny)'
);
reset role;

set role authenticated;
select is_empty(
  $$ select * from backup_runs $$,
  'authenticated cannot read backup_runs (RLS default-deny)'
);
reset role;

-- schema_meta: singleton constraint rejects a second row.
select throws_ok(
  $$ insert into schema_meta (id, current_version, min_supported_version) values (true, 2, 1) $$,
  '23505',
  null,
  'schema_meta rejects a second row (id primary key collision)'
);

select throws_ok(
  $$ insert into schema_meta (id, current_version, min_supported_version) values (false, 2, 1) $$,
  '23514',
  null,
  'schema_meta rejects id = false (singleton check constraint)'
);

select * from finish();
rollback;
