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
  'anon cannot read tenants (no grant)'
);
select throws_ok(
  $$ select * from shops $$,
  '42501', null,
  'anon cannot read shops (no grant)'
);
select throws_ok(
  $$ select * from tenant_users $$,
  '42501', null,
  'anon cannot read tenant_users (no grant)'
);
select throws_ok(
  $$ select * from invites $$,
  '42501', null,
  'anon cannot read invites (no grant)'
);
select throws_ok(
  $$ select * from devices $$,
  '42501', null,
  'anon cannot read devices (no grant)'
);
reset role;

set role authenticated;
select is_empty($$ select * from tenants $$, 'authenticated cannot read tenants (no policy yet)');
select is_empty($$ select * from tenant_users $$, 'authenticated cannot read tenant_users (no policy yet)');
select is_empty($$ select * from devices $$, 'authenticated cannot read devices (no policy yet)');
reset role;

select * from finish();
rollback;
