-- Packet storefront (mig 0077): online shop settings and published items. Owner/manager write, cashier reads
-- (MANAGE_ORDERS) but cannot write, anon sees nothing, another tenant cannot touch or read, slugs are unique and
-- validated, a shop is OFF by default, items of another tenant are refused, rows are never deleted.
begin;
create extension if not exists pgtap with schema extensions;
select plan(18);
insert into auth.users(id) values
 ('e7700000-0000-0000-0000-000000000001'),('e7700000-0000-0000-0000-000000000003'),('e7700000-0000-0000-0000-000000000004');
create function pg_temp.act(p_user text) returns void language sql as
 $$ select set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true) $$;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select current_setting('e77.'||p_key)::uuid $$;

set role authenticated;
select pg_temp.act('e7700000-0000-0000-0000-000000000004');
select create_tenant('E77 Other','e77-other','E77 Other Shop','e77-other-tenant');
select set_config('e77.othershop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'E77 Foreign','pc','e77-f');
select set_config('e77.foreign',(select id::text from items where client_id='e77-f'),false);
select set_storefront_settings(pg_temp.id('othershop'),'{"slug":"taken-one","displayName":"Other"}','e77-o1');
select pg_temp.act('e7700000-0000-0000-0000-000000000001');
select create_tenant('E77 Co','e77-co','E77 Shop','e77-tenant');
select set_config('e77.tenant',current_tenant_id()::text,false);
select set_config('e77.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'E77 Rice','kg','e77-a');
select set_config('e77.a',(select id::text from items where client_id='e77-a'),false);
reset role;
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id) values
 (pg_temp.id('tenant'),'e7700000-0000-0000-0000-000000000003','cashier',array[pg_temp.id('shop')],'active','e77-cash');

select ok(not has_function_privilege('anon','set_storefront_settings(uuid,jsonb,text)','execute')
  and not has_function_privilege('anon','set_storefront_items(uuid,jsonb,text)','execute'),'anon cannot call the setters');
select ok(not has_table_privilege('anon','storefront_settings','select') and not has_table_privilege('anon','storefront_items','select'),'anon cannot read the tables');

set role authenticated;
select pg_temp.act('e7700000-0000-0000-0000-000000000001');
select lives_ok($$ select set_storefront_settings(pg_temp.id('shop'),
  '{"slug":"E77-Shop","displayName":" E77 Kirana ","deliveryEnabled":true,"deliveryFeePaise":3000,"minOrderPaise":20000,"freeDeliveryAbovePaise":50000,"deliverySlots":["9-11 am"," 5-7 pm "]}','e77-s1') $$,'owner saves settings');
select is((select enabled from storefront_settings where shop_id=pg_temp.id('shop')),false,'a shop is OFF unless enabled');
select is((select slug from storefront_settings where shop_id=pg_temp.id('shop')),'e77-shop','slug is lower-cased');
select is((select delivery_slots from storefront_settings where shop_id=pg_temp.id('shop')),'["9-11 am","5-7 pm"]'::jsonb,'slots are trimmed');
select lives_ok($$ select set_storefront_settings(pg_temp.id('shop'),'{"slug":"e77-shop","displayName":"E77","enabled":true}','e77-s2') $$,'a second save updates the same row');
select is((select count(*)::int from storefront_settings where shop_id=pg_temp.id('shop')),1,'still one row per shop');
select throws_like($$ select set_storefront_settings(pg_temp.id('shop'),'{"slug":"taken-one","displayName":"x"}','e77-s3') $$,'%DSB_SLUG_TAKEN%','another shop''s slug is refused');
select throws_like($$ select set_storefront_settings(pg_temp.id('shop'),'{"slug":"-bad","displayName":"x"}','e77-s4') $$,'%DSB_INVALID_SLUG%','a bad slug is refused');
select throws_like($$ select set_storefront_settings(pg_temp.id('shop'),'{"slug":"e77-shop","displayName":"x","pickupEnabled":false,"deliveryEnabled":false}','e77-s5') $$,'%storefront_settings%','pickup or delivery must be on');
select is(set_storefront_items(pg_temp.id('shop'),jsonb_build_array(jsonb_build_object('itemId',pg_temp.id('a'),'published',true,'description','Fresh')),'e77-i1'),1,'owner publishes an item');
select throws_like($$ select set_storefront_items(pg_temp.id('shop'),jsonb_build_array(jsonb_build_object('itemId',pg_temp.id('foreign'),'published',true)),'e77-i2') $$,'%DSB_ITEM_NOT_FOUND%','another tenant''s item is refused');
select throws_ok($$ select set_storefront_settings(pg_temp.id('othershop'),'{"slug":"zzz-1","displayName":"x"}','e77-s6') $$,null,'another tenant''s shop is refused');
select is((select count(*)::int from storefront_settings),1,'owner sees only own shop settings');
select pg_temp.act('e7700000-0000-0000-0000-000000000003');
select is((select count(*)::int from storefront_items where published),1,'a cashier can read published items');
select throws_like($$ select set_storefront_settings(pg_temp.id('shop'),'{"slug":"e77-shop","displayName":"x"}','e77-s7') $$,'%not permitted%','a cashier cannot change settings');
reset role;
select throws_like($$ delete from storefront_items $$,'%never deleted%','rows are never deleted');
select * from finish();
rollback;
