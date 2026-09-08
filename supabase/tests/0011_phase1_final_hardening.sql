begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

insert into auth.users (id)
values
  ('f0000000-0000-0000-0000-000000000001'),
  ('f0000000-0000-0000-0000-000000000002'),
  ('f0000000-0000-0000-0000-000000000003')
on conflict do nothing;

-- Build a self-contained owner/member/foreign-user fixture.
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'f0000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
select lives_ok($$ select create_tenant('Hardening Co', 'hardening-co', 'Main Shop', 'final-hardening-client') $$, 'fixture tenant exists');
select lives_ok($$ select register_device('owner-device', '1.0.0') $$, 'fixture device exists');
select set_config('app.owner_device_id', (select id::text from devices where user_id = auth.uid() order by created_at desc limit 1), false);
select lives_ok($$ select create_invite('cashier', '{}') $$, 'fixture member invite exists');
select set_config('app.member_invite_token', (select token from invites where tenant_id = current_tenant_id() order by created_at desc limit 1), false);
reset role;

set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'f0000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
select lives_ok($$ select accept_invite(current_setting('app.member_invite_token'), 'final-member') $$, 'fixture member joins');
reset role;

set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'f0000000-0000-0000-0000-000000000003', 'role', 'authenticated')::text, true);
select lives_ok($$ select create_tenant('Foreign Co', 'foreign-co', 'Foreign Shop', 'final-foreign-client') $$, 'foreign tenant exists');
reset role;

set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'f0000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
select throws_ok($$ select create_invite('owner', '{}') $$, null, 'invite role must be manager, cashier, or accountant', 'create_invite() cannot mint an owner invite');
select lives_ok($$ select create_invite('manager', '{}') $$, 'create_invite() accepts an allowed role');
select lives_ok($$ select set_device_label(current_setting('app.owner_device_id')::uuid, 'Front counter') $$, 'device owner can set their device label');
select ok(exists (select 1 from devices where id = current_setting('app.owner_device_id')::uuid and label = 'Front counter'), 'device label is persisted');
select throws_ok($$ select set_user_role('f0000000-0000-0000-0000-000000000002', 'owner') $$, null, 'role must be manager, cashier, or accountant', 'set_user_role() cannot promote a member to owner');
reset role;

-- Foreign tenant user cannot reach the owner's device through the label RPC.
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'f0000000-0000-0000-0000-000000000003', 'role', 'authenticated')::text, true);
select throws_ok($$ select set_device_label(current_setting('app.owner_device_id')::uuid, 'hijack') $$, null, 'device not found', 'set_device_label() cannot access another tenant''s device');
reset role;

select * from finish();
rollback;
