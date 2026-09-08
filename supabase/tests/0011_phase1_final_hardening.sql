begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

-- Reuse the Phase 1 fixture owner and a non-owner member.
insert into auth.users (id)
values
  ('f0000000-0000-0000-0000-000000000001'),
  ('f0000000-0000-0000-0000-000000000002')
on conflict do nothing;

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);

select throws_ok(
  $$ select create_invite('owner', '{}') $$,
  null, 'invite role must be manager, cashier, or accountant',
  'create_invite() cannot mint an owner invite'
);

select lives_ok(
  $$ select create_invite('manager', '{}') $$,
  'create_invite() accepts an allowed role'
);

select lives_ok(
  $$ select set_device_label((select id from devices where user_id = auth.uid() order by created_at desc limit 1), 'Front counter') $$,
  'device owner can set their device label'
);

select ok(
  exists (select 1 from devices where user_id = auth.uid() and label = 'Front counter'),
  'device label is persisted'
);

select throws_ok(
  $$ select set_user_role('f0000000-0000-0000-0000-000000000002', 'owner') $$,
  null, 'role must be manager, cashier, or accountant',
  'set_user_role() cannot promote a member to owner'
);

reset role;

-- Ensure the label RPC rejects a cross-tenant device through its tenant check.
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select set_device_label((select id from devices where user_id = 'f0000000-0000-0000-0000-000000000001' limit 1), 'hijack') $$,
  null, 'device not found',
  'set_device_label() cannot access another tenant''s device'
);
reset role;

select * from finish();
rollback;
