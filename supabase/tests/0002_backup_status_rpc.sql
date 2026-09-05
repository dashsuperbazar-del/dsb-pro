begin;
create extension if not exists pgtap with schema extensions;
select plan(2);

select has_function('public', 'get_latest_backup_status', 'get_latest_backup_status() exists');

set role anon;
select lives_ok(
  $$ select * from get_latest_backup_status() $$,
  'anon can execute get_latest_backup_status()'
);
reset role;

select * from finish();
rollback;
