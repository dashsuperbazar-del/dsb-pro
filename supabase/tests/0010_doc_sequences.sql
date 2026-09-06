begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

insert into auth.users (id)
values ('f0000000-0000-0000-0000-0000000000b1')
on conflict do nothing;

insert into tenants (id, name, slug, created_by) values ('a0000000-0000-0000-0000-00000000000b', 'Seq Co', 'seq-co', 'f0000000-0000-0000-0000-0000000000b1');
insert into shops (id, tenant_id, name, created_by) values ('e0000000-0000-0000-0000-00000000000b', 'a0000000-0000-0000-0000-00000000000b', 'Seq Shop', 'f0000000-0000-0000-0000-0000000000b1');
insert into tenant_users (tenant_id, user_id, role, shop_ids, created_by) values
  ('a0000000-0000-0000-0000-00000000000b', 'f0000000-0000-0000-0000-0000000000b1', 'owner', '{}', 'f0000000-0000-0000-0000-0000000000b1');

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text, true);

select is(next_doc_no('e0000000-0000-0000-0000-00000000000b', 'INV'), 1::bigint, 'first call returns 1');
select is(next_doc_no('e0000000-0000-0000-0000-00000000000b', 'INV'), 2::bigint, 'second call returns 2, no gap/repeat');
select is(next_doc_no('e0000000-0000-0000-0000-00000000000b', 'PUR'), 1::bigint, 'a different series starts its own count at 1');
reset role;

set role anon;
select throws_ok(
  $$ select * from doc_sequences $$,
  '42501', null,
  'anon has no grant on doc_sequences (permission denied, not empty)'
);
reset role;

select * from finish();
rollback;
