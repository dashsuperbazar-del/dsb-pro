begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

-- Test users must exist in auth.users to satisfy devices' foreign key.
insert into auth.users (id)
values
  ('f0000000-0000-0000-0000-000000000010'),
  ('f0000000-0000-0000-0000-000000000011')
on conflict do nothing;

insert into tenants (id, name, slug, created_by) values ('a0000000-0000-0000-0000-000000000009', 'Tenant Z', 'tenant-z', 'f0000000-0000-0000-0000-000000000010');
insert into tenant_users (tenant_id, user_id, role, shop_ids, created_by) values
  ('a0000000-0000-0000-0000-000000000009', 'f0000000-0000-0000-0000-000000000010', 'cashier', '{}', 'f0000000-0000-0000-0000-000000000010'),
  ('a0000000-0000-0000-0000-000000000009', 'f0000000-0000-0000-0000-000000000011', 'manager', '{}', 'f0000000-0000-0000-0000-000000000010');

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000010', 'role', 'authenticated')::text, true);
select lives_ok(
  $$ select register_device('phone-1', '0.1.0') $$,
  'cashier can register their own device'
);
reset role;

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000011', 'role', 'authenticated')::text, true);
select lives_ok(
  $$ select register_device('tablet-1', '0.1.0') $$,
  'manager can register their own device'
);
reset role;

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000010', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select revoke_device((select id from devices where user_id = 'f0000000-0000-0000-0000-000000000011')) $$,
  null, 'not permitted',
  'cashier cannot revoke another user''s device (has_perm denies, not the device owner) — but note the row IS visible internally since revoke_device() is security definer'
);
reset role;

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000011', 'role', 'authenticated')::text, true);
select lives_ok(
  $$ select revoke_device((select id from devices where user_id = 'f0000000-0000-0000-0000-000000000010')) $$,
  'manager can revoke the cashier''s device (has_perm MANAGE_DEVICES)'
);
select ok(
  (select revoked_at is not null from devices where user_id = 'f0000000-0000-0000-0000-000000000010'),
  'revoked_at is set after manager revokes'
);
reset role;

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000010', 'role', 'authenticated')::text, true);
select lives_ok(
  $$ select revoke_device((select id from devices where user_id = 'f0000000-0000-0000-0000-000000000010')) $$,
  'cashier can revoke their own already-revoked device (self is always allowed)'
);
reset role;

select * from finish();
rollback;
