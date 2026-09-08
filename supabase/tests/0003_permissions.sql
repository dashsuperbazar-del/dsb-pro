begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

select has_table('public', 'permissions', 'permissions table exists');
select has_table('public', 'role_permissions', 'role_permissions table exists');

select ok(
  (select count(*) from permissions where code in ('MANAGE_TENANT_USERS','MANAGE_INVITES','MANAGE_DEVICES','VIEW_AUDIT_LOG')) = 4,
  'original Phase 1 permission codes remain seeded'
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
  not exists(
    select 1 from role_permissions
    where role='cashier' and code in ('MANAGE_TENANT_USERS','MANAGE_INVITES','MANAGE_DEVICES','VIEW_AUDIT_LOG')
  ),
  'cashier never receives Phase 1 administrative permissions'
);

set role anon;
select throws_ok(
  $$ select * from permissions $$,
  '42501', null,
  'anon cannot read permissions (no grant, still enforced after 0012/0013''s explicit revokes)'
);
reset role;

select * from finish();
rollback;
