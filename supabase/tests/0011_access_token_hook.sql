begin;
create extension if not exists pgtap with schema extensions;
select plan(3);

select has_function('public', 'custom_access_token_hook', array['jsonb'], 'custom_access_token_hook() exists');

insert into auth.users (id)
values ('f0000000-0000-0000-0000-0000000000c1')
on conflict do nothing;

insert into tenants (id, name, slug, created_by) values ('a0000000-0000-0000-0000-00000000000c', 'Hook Co', 'hook-co', '00000000-0000-0000-0000-000000000000');
insert into tenant_users (tenant_id, user_id, role, shop_ids, created_by) values
  ('a0000000-0000-0000-0000-00000000000c', 'f0000000-0000-0000-0000-0000000000c1', 'manager', array['e0000000-0000-0000-0000-00000000000c']::uuid[], '00000000-0000-0000-0000-000000000000');

select is(
  (
    custom_access_token_hook(
      jsonb_build_object('user_id', 'f0000000-0000-0000-0000-0000000000c1', 'claims', jsonb_build_object('sub', 'f0000000-0000-0000-0000-0000000000c1'))
    ) -> 'claims' ->> 'app_role'
  ),
  'manager',
  'hook injects app_role for a user with a tenant_users row'
);

select is(
  (
    custom_access_token_hook(
      jsonb_build_object('user_id', 'f0000000-0000-0000-0000-000000000fff', 'claims', jsonb_build_object('sub', 'f0000000-0000-0000-0000-000000000fff'))
    ) -> 'claims' ->> 'app_role'
  ),
  null,
  'hook leaves claims unmodified for a user with no tenant yet'
);

select * from finish();
rollback;
