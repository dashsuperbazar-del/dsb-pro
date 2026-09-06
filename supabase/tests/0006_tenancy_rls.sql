begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

-- Two tenants, one cashier each.
-- Note: created_by supplied explicitly as superuser context doesn't set auth.uid().
-- First create the test users in auth.users.
insert into auth.users (id)
values ('c0000000-0000-0000-0000-000000000001'), ('c0000000-0000-0000-0000-000000000002')
on conflict do nothing;

insert into tenants (id, name, slug, created_by) values
  ('a0000000-0000-0000-0000-000000000001', 'Tenant A', 'tenant-a', 'a0000000-0000-0000-0000-000000000001'),
  ('a0000000-0000-0000-0000-000000000002', 'Tenant B', 'tenant-b', 'a0000000-0000-0000-0000-000000000002');
insert into shops (id, tenant_id, name, created_by) values
  ('e0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'A Shop', 'a0000000-0000-0000-0000-000000000001'),
  ('e0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002', 'B Shop', 'a0000000-0000-0000-0000-000000000002');
insert into tenant_users (tenant_id, user_id, role, shop_ids, created_by) values
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'cashier', '{}', 'a0000000-0000-0000-0000-000000000001'),
  ('a0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002', 'cashier', '{}', 'a0000000-0000-0000-0000-000000000002');
insert into devices (tenant_id, user_id, device_id, created_by) values
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'device-a', 'a0000000-0000-0000-0000-000000000001'),
  ('a0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002', 'device-b', 'a0000000-0000-0000-0000-000000000002');

-- Fallback path: A's cashier, identified only by sub.
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'c0000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);

select results_eq($$ select id from tenants order by id $$,
  $$ values ('a0000000-0000-0000-0000-000000000001'::uuid) $$,
  'fallback: A''s cashier sees only tenant A in tenants');
select results_eq($$ select id from shops order by id $$,
  $$ values ('e0000000-0000-0000-0000-000000000001'::uuid) $$,
  'fallback: A''s cashier sees only A''s shop');
select results_eq($$ select tenant_id from tenant_users order by tenant_id $$,
  $$ values ('a0000000-0000-0000-0000-000000000001'::uuid) $$,
  'fallback: A''s cashier sees only A''s tenant_users row');
select results_eq($$ select device_id from devices order by device_id $$,
  $$ values ('device-a'::text) $$,
  'fallback: A''s cashier sees only A''s device');
reset role;

-- Claim path: same user, but now with a tenant_id/app_role claim present.
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object(
    'sub', 'c0000000-0000-0000-0000-000000000001', 'role', 'authenticated',
    'tenant_id', 'a0000000-0000-0000-0000-000000000001', 'app_role', 'cashier', 'shop_ids', json_build_array()
  )::text, true);

select results_eq($$ select id from tenants order by id $$,
  $$ values ('a0000000-0000-0000-0000-000000000001'::uuid) $$,
  'claim path: A''s cashier sees only tenant A in tenants');
select results_eq($$ select id from shops order by id $$,
  $$ values ('e0000000-0000-0000-0000-000000000001'::uuid) $$,
  'claim path: A''s cashier sees only A''s shop');
select results_eq($$ select tenant_id from tenant_users order by tenant_id $$,
  $$ values ('a0000000-0000-0000-0000-000000000001'::uuid) $$,
  'claim path: A''s cashier sees only A''s tenant_users row');
select results_eq($$ select device_id from devices order by device_id $$,
  $$ values ('device-a'::text) $$,
  'claim path: A''s cashier sees only A''s device');
reset role;

select * from finish();
rollback;
