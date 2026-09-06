-- Regression test for the CI environment-drift bug this migration fixes:
-- every table below must deny anon regardless of auto_expose_new_tables.
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

set role anon;
select throws_ok($$ select * from permissions $$, '42501', null, 'anon cannot read permissions');
select throws_ok($$ select * from role_permissions $$, '42501', null, 'anon cannot read role_permissions');
select throws_ok($$ select * from doc_sequences $$, '42501', null, 'anon cannot read doc_sequences');
select throws_ok($$ select * from tenants $$, '42501', null, 'anon cannot read tenants');
select throws_ok($$ select * from shops $$, '42501', null, 'anon cannot read shops');
select throws_ok($$ select * from tenant_users $$, '42501', null, 'anon cannot read tenant_users');
select throws_ok($$ select * from invites $$, '42501', null, 'anon cannot read invites');
select throws_ok($$ select * from devices $$, '42501', null, 'anon cannot read devices');
select throws_ok($$ select * from audit_log $$, '42501', null, 'anon cannot read audit_log');
reset role;

select * from finish();
rollback;
