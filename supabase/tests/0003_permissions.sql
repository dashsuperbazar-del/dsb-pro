begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

select has_table('public', 'permissions', 'permissions table exists');
select has_table('public', 'role_permissions', 'role_permissions table exists');

select results_eq(
  $$ select count(*)::int from permissions $$,
  $$ values (4) $$,
  'four permission codes seeded'
);

select ok(
  exists(select 1 from role_permissions where role = 'owner' and code = 'MANAGE_TENANT_USERS'),
  'owner holds MANAGE_TENANT_USERS'
);
select ok(
  exists(select 1 from role_permissions where role = 'manager' and code = 'MANAGE_DEVICES'),
  'manager holds MANAGE_DEVICES'
);
select ok(
  not exists(select 1 from role_permissions where role = 'cashier'),
  'cashier holds no permissions this phase'
);

set role anon;
select throws_ok(
  $$ select * from permissions $$,
  'permission denied for table permissions',
  'anon cannot read permissions directly (no grant)'
);
reset role;

select * from finish();
rollback;
