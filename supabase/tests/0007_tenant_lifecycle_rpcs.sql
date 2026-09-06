begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

-- Test users must exist in auth.users to satisfy tenant_users/invites'
-- foreign keys (see 0006_tenancy_rls.sql's test for the same pattern).
insert into auth.users (id)
values
  ('f0000000-0000-0000-0000-000000000001'),
  ('f0000000-0000-0000-0000-000000000002'),
  ('f0000000-0000-0000-0000-000000000003'),
  ('f0000000-0000-0000-0000-000000000004')
on conflict do nothing;

-- create_tenant(): fresh user with no tenant_users row.
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);

select lives_ok(
  $$ select create_tenant('New Co', 'new-co', 'Main Shop', 'client-1') $$,
  'create_tenant() succeeds for a user with no tenant'
);
select ok(
  (select role from tenant_users where user_id = 'f0000000-0000-0000-0000-000000000001') = 'owner',
  'create_tenant() makes the caller owner'
);
select results_eq(
  $$ select create_tenant('New Co', 'new-co', 'Main Shop', 'client-1') $$,
  $$ select id from tenants where created_by = 'f0000000-0000-0000-0000-000000000001'::uuid $$,
  'create_tenant() retried with the same client_id returns the same tenant, no duplicate'
);
select throws_ok(
  $$ select create_tenant('Another Co', 'another-co', 'Shop', 'client-2') $$,
  null, 'user already belongs to a tenant',
  'create_tenant() rejects a user who already belongs to a tenant'
);
reset role;

-- Owner creates an invite for a cashier.
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
select lives_ok(
  $$ select token from create_invite('cashier', '{}') $$,
  'owner can create an invite'
);
-- invites_select_own restricts SELECT on invites to members with
-- MANAGE_INVITES (the owner who just created it), not the not-yet-a-member
-- invitee — so the accepting user below cannot look the token up themselves.
-- In real use the token reaches them out-of-band (e.g. a link); here, capture
-- it into a session GUC while still in the owner's context that can see it.
select set_config('app.cashier_invite_token',
  (select token from invites where role = 'cashier' and tenant_id = current_tenant_id()
   order by created_at desc limit 1),
  false);
reset role;

-- A second, unrelated user accepts it.
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
select lives_ok(
  $$ select accept_invite(current_setting('app.cashier_invite_token'), 'client-3') $$,
  'accept_invite() succeeds with a valid token'
);
select ok(
  (select role from tenant_users where user_id = 'f0000000-0000-0000-0000-000000000002') = 'cashier',
  'accept_invite() grants the invite''s role'
);
reset role;

-- Retried by a *different*, still-tenant-less user (not the one who just
-- accepted): accept_invite() checks "caller already belongs to a tenant"
-- before checking invite validity, so re-running this as f...0002 (now a
-- member) would always hit that first check instead of the one this
-- assertion targets — a third party is what actually exercises "already used".
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000004', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select accept_invite(current_setting('app.cashier_invite_token'), 'client-4') $$,
  null, 'invite invalid, expired, or already used',
  'accept_invite() rejects a token already used'
);
reset role;

-- Cashier cannot escalate: no direct grant, and set_user_role() blocked both ways.
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ update tenant_users set role = 'owner' where user_id = 'f0000000-0000-0000-0000-000000000002' $$,
  '42501', null,
  'cashier cannot UPDATE tenant_users directly (no grant)'
);
select throws_ok(
  $$ select set_user_role('f0000000-0000-0000-0000-000000000002', 'owner') $$,
  null, 'cannot change your own role',
  'cashier cannot self-promote via set_user_role() (self-target blocked first)'
);
select throws_ok(
  $$ select set_user_role('f0000000-0000-0000-0000-000000000001', 'cashier') $$,
  null, 'not permitted',
  'cashier cannot demote the owner via set_user_role() (has_perm denies)'
);
select throws_ok(
  $$ select create_invite('owner', '{}') $$,
  null, 'not permitted',
  'cashier cannot create_invite() (has_perm denies)'
);
reset role;

-- Owner can change the cashier's role.
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
select lives_ok(
  $$ select set_user_role('f0000000-0000-0000-0000-000000000002', 'manager') $$,
  'owner can change another member''s role'
);

-- revoke_invite(): owner creates a fresh invite, a cashier cannot revoke it,
-- the owner can, and the revoked token can no longer be accepted.
select lives_ok(
  $$ select token from create_invite('accountant', '{}') $$,
  'owner can create a second invite (to be revoked)'
);
-- Same visibility gap as above: capture the accountant invite's id/token
-- while still owner (who can see it), for use by later, non-owner contexts.
select set_config('app.accountant_invite_id',
  (select id::text from invites where role = 'accountant' and tenant_id = current_tenant_id()
   order by created_at desc limit 1),
  false);
select set_config('app.accountant_invite_token',
  (select token from invites where role = 'accountant' and tenant_id = current_tenant_id()
   order by created_at desc limit 1),
  false);
reset role;

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select revoke_invite(current_setting('app.accountant_invite_id')::uuid) $$,
  null, 'not permitted',
  'cashier cannot revoke_invite() (has_perm denies)'
);
reset role;

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
select lives_ok(
  $$ select revoke_invite(current_setting('app.accountant_invite_id')::uuid) $$,
  'owner can revoke_invite()'
);
reset role;

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000003', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select accept_invite(current_setting('app.accountant_invite_token'), 'client-5') $$,
  null, 'invite invalid, expired, or already used',
  'accept_invite() rejects a revoked token'
);
reset role;

select * from finish();
rollback;
