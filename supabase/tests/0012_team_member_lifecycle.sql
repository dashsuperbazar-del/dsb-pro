begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

insert into auth.users (id, email) values
  ('f1000000-0000-0000-0000-000000000001', 'owner@example.com'),
  ('f1000000-0000-0000-0000-000000000002', 'cashier@example.com')
on conflict do nothing;

insert into tenants (id, name, slug, created_by)
values ('a1000000-0000-0000-0000-000000000001', 'Lifecycle Tenant', 'lifecycle-tenant', 'f1000000-0000-0000-0000-000000000001');
insert into shops (id, tenant_id, name, is_default, created_by)
values ('b1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'Main', true, 'f1000000-0000-0000-0000-000000000001');
insert into tenant_users (tenant_id, user_id, role, shop_ids, created_by) values
  ('a1000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'owner', array['b1000000-0000-0000-0000-000000000001'::uuid], 'f1000000-0000-0000-0000-000000000001'),
  ('a1000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000002', 'cashier', array['b1000000-0000-0000-0000-000000000001'::uuid], 'f1000000-0000-0000-0000-000000000001');

set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','f1000000-0000-0000-0000-000000000002','role','authenticated','tenant_id','a1000000-0000-0000-0000-000000000001','app_role','cashier','shop_ids',json_build_array('b1000000-0000-0000-0000-000000000001'))::text, true);
select throws_ok($$ select * from list_tenant_users_admin() $$, null, 'not permitted', 'cashier cannot list owner team admin data');
select throws_ok($$ select set_user_status('f1000000-0000-0000-0000-000000000001','disabled') $$, null, 'not permitted', 'cashier cannot change member status');
select throws_ok($$ select remove_tenant_user('f1000000-0000-0000-0000-000000000001') $$, null, 'not permitted', 'cashier cannot remove members');
reset role;

set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','f1000000-0000-0000-0000-000000000001','role','authenticated','tenant_id','a1000000-0000-0000-0000-000000000001','app_role','owner','shop_ids',json_build_array('b1000000-0000-0000-0000-000000000001'))::text, true);
select is((select count(*)::int from list_tenant_users_admin()), 2, 'owner can list active team rows');
select is((select email from list_tenant_users_admin() where user_id='f1000000-0000-0000-0000-000000000002'), 'cashier@example.com', 'owner list returns member email');
select lives_ok($$ select set_user_status('f1000000-0000-0000-0000-000000000002','disabled') $$, 'owner can disable cashier');
select throws_ok($$ select set_user_status('f1000000-0000-0000-0000-000000000001','disabled') $$, null, 'owner status cannot be changed', 'owner cannot disable self');
reset role;

-- Phase 1 deliberately permits stale custom claims until token refresh when the
-- optional hook is enabled. The correctness fallback (no custom tenant claim)
-- must reject a disabled membership immediately.
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','f1000000-0000-0000-0000-000000000002','role','authenticated')::text, true);
select is((select count(*)::int from current_membership()), 0, 'disabled member is rejected by the table fallback path');
reset role;

set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','f1000000-0000-0000-0000-000000000001','role','authenticated','tenant_id','a1000000-0000-0000-0000-000000000001','app_role','owner','shop_ids',json_build_array('b1000000-0000-0000-0000-000000000001'))::text, true);
select lives_ok($$ select set_user_status('f1000000-0000-0000-0000-000000000002','active') $$, 'owner can reactivate cashier');
select lives_ok($$ select remove_tenant_user('f1000000-0000-0000-0000-000000000002') $$, 'owner can soft-remove cashier');
select is((select count(*)::int from list_tenant_users_admin()), 1, 'removed member disappears from owner team list');
select throws_ok($$ select remove_tenant_user('f1000000-0000-0000-0000-000000000001') $$, null, 'owner cannot be removed', 'owner cannot remove self');
select lives_ok($$ select create_invite('cashier', array['b1000000-0000-0000-0000-000000000001'::uuid]) $$, 'owner can create rejoin invite');
reset role;

-- Build the SQL while running as the test owner/postgres so RLS on invites does
-- not hide the token from the removed user; accept_invite itself still derives
-- the invitee identity from the authenticated JWT claims below.
select set_config('request.jwt.claims', json_build_object('sub','f1000000-0000-0000-0000-000000000002','role','authenticated')::text, true);
select lives_ok(format('select accept_invite(%L, %L)', (select token from invites where tenant_id='a1000000-0000-0000-0000-000000000001' order by created_at desc limit 1), 'rejoin-client'), 'removed member can rejoin through a fresh invite');

select * from finish();
rollback;
