begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

-- Fixture as superuser (bypasses RLS/grants — no policies exist yet anyway).
-- Note: created_by supplied explicitly as superuser context doesn't set auth.uid().
insert into tenants (id, name, slug, created_by) values
  ('11111111-1111-1111-1111-111111111111', 'Test Co', 'test-co', '00000000-0000-0000-0000-000000000000');

select ok(
  (select updated_at from tenants where id = '11111111-1111-1111-1111-111111111111') > 0,
  'tenants_set_updated_at trigger sets a nonzero updated_at on insert'
);

set role anon;
select throws_ok(
  $$ select * from tenants $$,
  '42501', null,
  'anon cannot read tenants (no grant, enforced independent of RLS policies)'
);
select throws_ok(
  $$ select * from shops $$,
  '42501', null,
  'anon cannot read shops (no grant, enforced independent of RLS policies)'
);
select throws_ok(
  $$ select * from tenant_users $$,
  '42501', null,
  'anon cannot read tenant_users (no grant, enforced independent of RLS policies)'
);
select throws_ok(
  $$ select * from invites $$,
  '42501', null,
  'anon cannot read invites (no grant, enforced independent of RLS policies)'
);
select throws_ok(
  $$ select * from devices $$,
  '42501', null,
  'anon cannot read devices (no grant, enforced independent of RLS policies)'
);
reset role;

-- These three now run after 0006_tenancy_rls.sql's SELECT policies exist
-- (every migration through the latest applies before any test runs), so
-- they no longer describe "no policy yet" — they instead genuinely prove
-- that a user with no tenant_users membership at all sees zero rows even
-- though a real per-tenant SELECT policy is in force.
set role authenticated;
select is_empty($$ select * from tenants $$, 'authenticated with no tenant membership sees no tenants (RLS policy resolves to zero rows)');
select is_empty($$ select * from tenant_users $$, 'authenticated with no tenant membership sees no tenant_users rows (RLS policy resolves to zero rows)');
select is_empty($$ select * from devices $$, 'authenticated with no tenant membership sees no devices (RLS policy resolves to zero rows)');
reset role;

select * from finish();
rollback;
