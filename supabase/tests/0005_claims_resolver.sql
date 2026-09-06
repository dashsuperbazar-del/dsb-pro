begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

-- Fixture as superuser (bypasses RLS — no policies target this yet).
-- Note: created_by supplied explicitly as superuser context doesn't set auth.uid().
-- First create the test user in auth.users.
insert into auth.users (id)
values ('c0000000-0000-0000-0000-000000000001')
on conflict do nothing;

insert into tenants (id, name, slug, created_by) values
  ('a0000000-0000-0000-0000-000000000001', 'Tenant A', 'tenant-a', '00000000-0000-0000-0000-000000000000');
insert into tenant_users (id, tenant_id, user_id, role, shop_ids, created_by)
values (
  'b0000000-0000-0000-0000-000000000001',
  'a0000000-0000-0000-0000-000000000001',
  'c0000000-0000-0000-0000-000000000001',
  'cashier',
  array['d0000000-0000-0000-0000-000000000001']::uuid[],
  '00000000-0000-0000-0000-000000000000'
);

-- Fallback path: authenticate via sub claim only, no tenant_id/app_role claim.
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'c0000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text,
  true);

select is("current_tenant_id"(), 'a0000000-0000-0000-0000-000000000001'::uuid,
  'fallback: current_tenant_id() resolves via tenant_users when no claim present');
select is("current_role"(), 'cashier',
  'fallback: current_role() resolves via tenant_users when no claim present');
select is("current_shop_ids"(), array['d0000000-0000-0000-0000-000000000001']::uuid[],
  'fallback: current_shop_ids() resolves via tenant_users when no claim present');
select ok("has_perm"('MANAGE_DEVICES') = false,
  'fallback: cashier has_perm(MANAGE_DEVICES) is false');
reset role;

-- Claim path: same user, but tenant_id/app_role/shop_ids now present as custom
-- claims — current_membership() must trust them without touching tenant_users.
-- Deliberately uses 'owner' here (the row underneath is 'cashier') to prove the
-- claim is what's trusted, not a silent re-derive from the table.
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object(
    'sub', 'c0000000-0000-0000-0000-000000000001',
    'role', 'authenticated',
    'tenant_id', 'a0000000-0000-0000-0000-000000000001',
    'app_role', 'owner',
    'shop_ids', json_build_array('d0000000-0000-0000-0000-000000000001')
  )::text,
  true);

select is("current_tenant_id"(), 'a0000000-0000-0000-0000-000000000001'::uuid,
  'claim path: current_tenant_id() resolves from JWT claim');
select is("current_role"(), 'owner',
  'claim path: current_role() resolves from JWT claim, not the underlying cashier row');
select is("current_shop_ids"(), array['d0000000-0000-0000-0000-000000000001']::uuid[],
  'claim path: current_shop_ids() resolves from JWT claim');
select ok("has_perm"('MANAGE_DEVICES') = true,
  'claim path: owner has_perm(MANAGE_DEVICES) is true');
reset role;

select * from finish();
rollback;
