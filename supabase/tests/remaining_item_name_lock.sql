-- Packet itemnamelock (mig 0073): online and offline item creates share one lock and one rule.
-- The app's online create now uses create_item_v2; a direct client insert (older app) takes the same
-- advisory lock (tenant, lower(trimmed name)) and refuses any active same-name item. Existing duplicates
-- are untouched; definer paths (create_item_v2, import, restore) are not affected by the guard.
begin;
create extension if not exists pgtap with schema extensions;
select plan(16);
insert into auth.users(id) values
 ('e7300000-0000-0000-0000-000000000001'),  -- owner
 ('e7300000-0000-0000-0000-000000000002');  -- owner of another tenant
create function pg_temp.act(p_user text) returns void language sql as
 $$ select set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true) $$;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select current_setting('e73.'||p_key)::uuid $$;
-- Is the advisory lock create_item_v2 uses for this name held by this transaction?
create function pg_temp.name_locked(p_name text) returns boolean language sql as $$
 select exists(select 1 from pg_locks l, (select hashtextextended('dsb:item-name:'||current_setting('e73.tenant')||':'||lower(btrim(p_name)),0) k) h
  where l.locktype='advisory' and l.pid=pg_backend_pid() and l.granted and l.objsubid=1
    and l.classid::bigint=((h.k>>32)&4294967295) and l.objid::bigint=(h.k&4294967295)) $$;

set role authenticated;
select pg_temp.act('e7300000-0000-0000-0000-000000000002');
select create_tenant('E73 Other','e73-other','E73 Other Shop','e73-other-tenant');
insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'E73 Rice','bag','e73-foreign-rice');
select pg_temp.act('e7300000-0000-0000-0000-000000000001');
select create_tenant('E73 Co','e73-co','E73 Shop','e73-tenant');
select set_config('e73.tenant',current_tenant_id()::text,false);
reset role;
-- Duplicates that already exist (as live data may): written by a definer/admin path, never touched.
insert into items(tenant_id,name,unit1,client_id) values
 (pg_temp.id('tenant'),'E73 Dal','bag','e73-dal-1'),(pg_temp.id('tenant'),'e73 dal ','bag','e73-dal-2');
select ok(not exists(select 1 from pg_indexes where tablename='items' and indexdef ilike '%unique%lower%name%'),
  'no unique name index (live duplicates must not fail the apply)');
select ok(exists(select 1 from pg_trigger where tgrelid='public.items'::regclass and tgname='items_name_guard' and not tgisinternal),
  'guard trigger installed');
select ok(not has_function_privilege('authenticated','items_name_guard()','execute')
  and not has_function_privilege('anon','items_name_guard()','execute'),'guard function is not callable by clients');

set role authenticated;
select pg_temp.act('e7300000-0000-0000-0000-000000000001');
-- Online create (create_item_v2) then the same item offline: one item.
select is(create_item_v2('a7300000-0000-4000-8000-000000000001','b7300000-0000-4000-8000-000000000001',
  '{"name":"E73 Tea","unit1":"box","unit2":"pack","conv1":10}')->>'created','true','online create writes the item');
select is(create_item_v2('a7300000-0000-4000-8000-000000000002','b7300000-0000-4000-8000-000000000002',
  '{"name":" e73 TEA ","unit1":"box","unit2":"pack","conv1":10}')->>'itemId','a7300000-0000-4000-8000-000000000001',
  'offline create of the same name and units reuses it');
select throws_like($$select create_item_v2('a7300000-0000-4000-8000-000000000003','b7300000-0000-4000-8000-000000000003','{"name":"E73 Tea","unit1":"box"}')$$,
  'DSB_ITEM_NAME_TAKEN%','same name with other units refused');
-- A direct insert (older app) of a taken name is refused, whatever the units or case.
select throws_like($$insert into items(tenant_id,name,unit1,unit2,conv1,client_id) values(current_tenant_id(),'E73 TEA','box','pack',10,'e73-direct-1')$$,
  'DSB_ITEM_NAME_TAKEN%','direct insert of a taken name refused');
select is((select count(*)::int from items where tenant_id=pg_temp.id('tenant') and lower(btrim(name))='e73 tea'),1,'one E73 Tea item');
-- A direct insert of a new name works and takes the same lock create_item_v2 takes for that name.
select ok(not pg_temp.name_locked('E73 Salt'),'lock for a new name not yet held');
insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'E73 Salt','kg','e73-direct-salt');
select ok(pg_temp.name_locked(' e73 salt'),'direct insert holds the create_item_v2 name lock until commit');
select is(create_item_v2('a7300000-0000-4000-8000-000000000004','b7300000-0000-4000-8000-000000000004',
  '{"name":"E73 Salt","unit1":"kg"}')->>'mapped','true','offline create after a direct insert reuses it');
-- Existing duplicates: untouched, and a new same-name create (either path) is refused, not added.
select throws_like($$select create_item_v2('a7300000-0000-4000-8000-000000000005','b7300000-0000-4000-8000-000000000005','{"name":"E73 Dal","unit1":"bag"}')$$,
  'DSB_ITEM_NAME_TAKEN%','two existing same-name items: create refused (no guess)');
select throws_like($$insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'E73 Dal','bag','e73-direct-dal')$$,
  'DSB_ITEM_NAME_TAKEN%','direct insert next to existing duplicates refused');
select is((select string_agg(client_id,',' order by client_id) from items where tenant_id=pg_temp.id('tenant') and lower(btrim(name))='e73 dal'),
  'e73-dal-1,e73-dal-2','existing duplicates untouched');
-- Tenants are separate: another tenant's same name never blocks.
insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'E73 Rice','bag','e73-rice');
select is((select count(*)::int from items where client_id='e73-rice'),1,'same name in another tenant does not block');
reset role;
-- Definer/admin paths (import, restore) keep reproducing data exactly.
insert into items(tenant_id,name,unit1,client_id) values(pg_temp.id('tenant'),'E73 Rice','bag','e73-rice-restore');
select is((select count(*)::int from items where tenant_id=pg_temp.id('tenant') and name='E73 Rice'),2,'non-client insert is not guarded');
select * from finish();
rollback;
