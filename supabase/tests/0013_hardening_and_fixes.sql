-- Tests for 0013_hardening_and_fixes.sql's fixes. See that migration's
-- header comments for the full rationale behind each.
begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

insert into auth.users (id)
values
  ('f0000000-0000-0000-0000-000000000201'),
  ('f0000000-0000-0000-0000-000000000202')
on conflict do nothing;

-- Fix 1a: idempotency-retry behavior still works after the narrowed
-- exception handler (same shape as Task 5's create_tenant() test 3 in
-- 0007_tenant_lifecycle_rpcs.sql).
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000201', 'role', 'authenticated')::text, true);

select lives_ok(
  $$ select create_tenant('Retry Co', 'retry-co-0013', 'Main Shop', 'retry-client-0013') $$,
  'create_tenant() succeeds on first call'
);
select results_eq(
  $$ select create_tenant('Retry Co', 'retry-co-0013', 'Main Shop', 'retry-client-0013') $$,
  $$ select id from tenants where slug = 'retry-co-0013' $$,
  'create_tenant() idempotent retry (same client_id) still returns the existing tenant, not NULL'
);
reset role;

-- Fix 1b: a genuine slug collision against a DIFFERENT tenant now raises a
-- real error instead of silently returning NULL. f...202 has never called
-- create_tenant() before and uses a fresh client_id, so the constraint that
-- fires is tenants_slug_key, never tenants_created_by_client_id_key (the
-- retry-only constraint the old handler assumed unconditionally).
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000202', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select create_tenant('Collider Co', 'retry-co-0013', 'Other Shop', 'collider-client-0013') $$,
  '23505', null,
  'create_tenant() raises (not NULL) on a slug collision against a different tenant'
);
reset role;

-- Confirm the failed attempt left no trace: the tenants insert that hit
-- tenants_slug_key rolled back before shops/tenant_users were ever touched,
-- so f...202 still has no tenant_users row.
select ok(
  not exists (select 1 from tenant_users where user_id = 'f0000000-0000-0000-0000-000000000202'),
  'the failed slug-collision attempt created no tenant_users row'
);

-- Fix 3: custom_access_token_hook() denies anon/authenticated EXECUTE
-- outright. Highest-stakes case in this migration's function lockdown: it's
-- security definer and takes an arbitrary user_id, so unrestricted call
-- access would be a cross-tenant enumeration vector. The permission check
-- happens before the function body ever runs, so no matching auth.users row
-- is needed for either call below.
set role anon;
select throws_ok(
  $$ select custom_access_token_hook(jsonb_build_object('user_id', gen_random_uuid()::text, 'claims', '{}'::jsonb)) $$,
  '42501', null,
  'anon cannot call custom_access_token_hook() directly'
);
reset role;

set role authenticated;
select throws_ok(
  $$ select custom_access_token_hook(jsonb_build_object('user_id', gen_random_uuid()::text, 'claims', '{}'::jsonb)) $$,
  '42501', null,
  'authenticated cannot call custom_access_token_hook() directly'
);
reset role;

select * from finish();
rollback;
