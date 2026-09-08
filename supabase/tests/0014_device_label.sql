begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

insert into auth.users (id)
values
  ('f0000000-0000-0000-0000-000000000020'),
  ('f0000000-0000-0000-0000-000000000021')
on conflict do nothing;

insert into tenants (id, name, slug, created_by) values ('a0000000-0000-0000-0000-000000000010', 'Tenant Label', 'tenant-label', 'f0000000-0000-0000-0000-000000000020');
insert into tenant_users (tenant_id, user_id, role, shop_ids, created_by) values
  ('a0000000-0000-0000-0000-000000000010', 'f0000000-0000-0000-0000-000000000020', 'cashier', '{}', 'f0000000-0000-0000-0000-000000000020'),
  ('a0000000-0000-0000-0000-000000000010', 'f0000000-0000-0000-0000-000000000021', 'manager', '{}', 'f0000000-0000-0000-0000-000000000020');

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000020', 'role', 'authenticated')::text, true);
select lives_ok(
  $$ select register_device('phone-label-1', '0.1.0') $$,
  'cashier registers a device to label'
);
select lives_ok(
  $$ select set_device_label((select id from devices where device_id = 'phone-label-1'), 'My Phone') $$,
  'cashier can label their own device'
);
select is(
  (select label from devices where device_id = 'phone-label-1'),
  'My Phone',
  'label persisted'
);
reset role;

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000021', 'role', 'authenticated')::text, true);
select lives_ok(
  $$ select set_device_label((select id from devices where device_id = 'phone-label-1'), 'Relabeled by manager') $$,
  'manager can relabel the cashier''s device too (has_perm MANAGE_DEVICES, same rule as revoke_device)'
);
select lives_ok(
  $$ select register_device('tablet-label-1', '0.1.0') $$,
  'manager registers their own device'
);
reset role;

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000020', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select set_device_label((select id from devices where device_id = 'tablet-label-1'), 'Hijacked') $$,
  null, 'not permitted',
  'cashier cannot relabel the manager''s device (not the owner, no MANAGE_DEVICES)'
);
reset role;

select * from finish();
rollback;
