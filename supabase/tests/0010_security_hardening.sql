begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

insert into auth.users (id)
values
  ('f0000000-0000-0000-0000-000000000003'),
  ('f0000000-0000-0000-0000-000000000004')
on conflict do nothing;

-- Build a second tenant and capture its shop as a foreign scope.
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000003', 'role', 'authenticated')::text, true);
select lives_ok(
  $$ select create_tenant('Other Co', 'other-co', 'Other Shop', 'hardening-client-1') $$,
  'second user can create an isolated tenant'
);
select set_config('app.foreign_shop_id',
  (select id::text from shops where tenant_id = current_tenant_id() and is_default order by created_at desc limit 1),
  false);
reset role;

-- The original owner must not be able to smuggle a different tenant's shop into an invite.
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select create_invite('cashier', array[current_setting('app.foreign_shop_id')::uuid]) $$,
  null, 'one or more shops are not in the current tenant',
  'create_invite() rejects a shop belonging to another tenant'
);
select lives_ok(
  $$ select create_invite('cashier', '{}') $$,
  'create_invite() still accepts an empty shop scope'
);
reset role;

-- A slug collision must not be swallowed as an idempotent retry and return NULL.
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000004', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select create_tenant('Collision Co', 'new-co', 'Collision Shop', 'hardening-client-2') $$,
  null, 'tenant slug already exists',
  'create_tenant() rejects an unrelated slug collision'
);
reset role;

select * from finish();
rollback;
