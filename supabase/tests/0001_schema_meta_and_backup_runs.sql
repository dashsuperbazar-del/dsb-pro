begin;
create extension if not exists pgtap with schema extensions;

select plan(4);

-- backup_runs: anon/authenticated must not be able to read it at all. On this
-- project, the default table privileges don't grant anon/authenticated SELECT
-- in the first place (verified: only TRUNCATE/REFERENCES/TRIGGER are granted
-- by default), so the query is rejected at the grant level (42501) before RLS
-- is even evaluated — a stricter default-deny than an RLS policy filtering to
-- zero rows would be. RLS being enabled with no policies is defense in depth
-- on top of that, not the only thing standing in the way.
set role anon;
select throws_ok(
  $$ select * from backup_runs $$,
  '42501',
  null,
  'anon cannot read backup_runs (no SELECT grant)'
);
reset role;

set role authenticated;
select throws_ok(
  $$ select * from backup_runs $$,
  '42501',
  null,
  'authenticated cannot read backup_runs (no SELECT grant)'
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
