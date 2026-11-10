-- Packet itemrestore (mig 0084): an archived item comes back unless an active item already has its name.
begin;
create extension if not exists pgtap with schema extensions;
select plan(6);
insert into auth.users(id) values ('e8400000-0000-0000-0000-000000000001');
create function pg_temp.act() returns void language sql as
 $$ select set_config('request.jwt.claims','{"sub":"e8400000-0000-0000-0000-000000000001","role":"authenticated"}',true) $$;
create function pg_temp.id(k text) returns uuid language sql as $$ select current_setting('e84.'||k)::uuid $$;
set role authenticated; select pg_temp.act();
select create_tenant('E84','e84-co','E84 Shop','e84-t');
insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'Soap','pc','e84-a'),(current_tenant_id(),'Oil','pc','e84-b');
select set_config('e84.a',(select id::text from items where client_id='e84-a'),false);
select set_config('e84.b',(select id::text from items where client_id='e84-b'),false);
select archive_master('items',pg_temp.id('a'));
reset role;
select ok((select deleted_at is not null and not is_active from items where id=pg_temp.id('a')),'archive marks the item');
set role anon;
select throws_ok($$ select restore_item(pg_temp.id('a')) $$,'42501',null,'anon cannot restore');
reset role; set role authenticated; select pg_temp.act();
select is(restore_item(pg_temp.id('a')),pg_temp.id('a'),'the owner restores it');
reset role;
select ok((select deleted_at is null and is_active from items where id=pg_temp.id('a')),'restored item is active again');
set role authenticated; select pg_temp.act();
-- Archive Oil, make a new active "oil", then the old one must not come back as a second "Oil".
select archive_master('items',pg_temp.id('b'));
insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),' oil ','pc','e84-c');
select throws_like($$ select restore_item(pg_temp.id('b')) $$,'%DSB_ITEM_NAME_TAKEN%','restore refuses a name an active item already uses');
select throws_like($$ select restore_item('00000000-0000-0000-0000-000000000000') $$,'%row not found%','unknown item is refused');
select * from finish();
rollback;
