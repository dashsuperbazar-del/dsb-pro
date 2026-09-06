begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

-- Fixture: create test user in auth.users as superuser (bypasses RLS).
insert into auth.users (id)
values ('f0000000-0000-0000-0000-0000000000a1')
on conflict do nothing;

insert into tenants (id, name, slug, created_by) values ('a0000000-0000-0000-0000-00000000000a', 'Audit Co', 'audit-co', '00000000-0000-0000-0000-000000000000');
select ok(
  exists(select 1 from audit_log where table_name = 'tenants' and row_id = 'a0000000-0000-0000-0000-00000000000a' and action = 'INSERT'),
  'inserting a tenant writes an audit_log row'
);

update tenants set name = 'Audit Co Renamed' where id = 'a0000000-0000-0000-0000-00000000000a';
select ok(
  exists(
    select 1 from audit_log
    where table_name = 'tenants' and row_id = 'a0000000-0000-0000-0000-00000000000a' and action = 'UPDATE'
      and before->>'name' = 'Audit Co' and after->>'name' = 'Audit Co Renamed'
  ),
  'updating a tenant writes an audit_log row with correct before/after'
);

insert into tenant_users (tenant_id, user_id, role, shop_ids, created_by) values
  ('a0000000-0000-0000-0000-00000000000a', 'f0000000-0000-0000-0000-0000000000a1', 'cashier', '{}', '00000000-0000-0000-0000-000000000000');
select ok(
  exists(select 1 from audit_log where table_name = 'tenant_users' and action = 'INSERT' and tenant_id = 'a0000000-0000-0000-0000-00000000000a'),
  'inserting a tenant_users row writes an audit_log row tagged with the right tenant_id'
);

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
select is_empty(
  $$ select * from audit_log $$,
  'cashier (no VIEW_AUDIT_LOG) cannot read audit_log'
);
reset role;

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object(
    'sub', 'f0000000-0000-0000-0000-0000000000a1', 'role', 'authenticated',
    'tenant_id', 'a0000000-0000-0000-0000-00000000000a', 'app_role', 'owner', 'shop_ids', json_build_array()
  )::text, true);
select isnt_empty(
  $$ select * from audit_log $$,
  'owner (claim path, VIEW_AUDIT_LOG) can read audit_log'
);
reset role;

select * from finish();
rollback;
