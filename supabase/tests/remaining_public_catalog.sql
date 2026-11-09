-- Packet publiccatalog (mig 0078): anon reads only an enabled shop's published, active, retail-priced items through
-- three allowlist functions; never cost/wholesale/stock numbers, never another shop, never base tables.
begin;
create extension if not exists pgtap with schema extensions;
select plan(16);
insert into auth.users(id) values ('e7800000-0000-0000-0000-000000000001'),('e7800000-0000-0000-0000-000000000004');
create function pg_temp.act(p_user text) returns void language sql as
 $$ select set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true) $$;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select current_setting('e78.'||p_key)::uuid $$;

set role authenticated;
select pg_temp.act('e7800000-0000-0000-0000-000000000004');
select create_tenant('E78 Other','e78-other','E78 Other Shop','e78-other-tenant');
select set_config('e78.othershop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'E78 Secret Soap','pc','e78-o');
select set_storefront_items(pg_temp.id('othershop'),jsonb_build_array(jsonb_build_object('itemId',(select id from items where client_id='e78-o'),'published',true)),'e78-oi');
select set_storefront_settings(pg_temp.id('othershop'),'{"slug":"e78-closed","displayName":"Closed"}','e78-os');
select pg_temp.act('e7800000-0000-0000-0000-000000000001');
select create_tenant('E78 Co','e78-co','E78 Shop','e78-tenant');
select set_config('e78.tenant',current_tenant_id()::text,false);
select set_config('e78.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into categories(tenant_id,name,client_id) values(current_tenant_id(),'Grains','e78-c');
insert into items(tenant_id,name,unit1,unit2,conv1,category_id,client_id) values
 (current_tenant_id(),'Rice 100%','bag','kg',25,(select id from categories where client_id='e78-c'),'e78-a'),
 (current_tenant_id(),'Dal','kg',null,null,null,'e78-b'),
 (current_tenant_id(),'Unpriced Oil','l',null,null,null,'e78-u'),
 (current_tenant_id(),'Hidden Tea','pc',null,null,null,'e78-h');
select set_config('e78.a',(select id::text from items where client_id='e78-a'),false);
reset role;
insert into item_prices(tenant_id,item_id,shop_id,kind,unit_level,price_paise,client_id) select pg_temp.id('tenant'),id,null,k,l,p,'e78-p-'||client_id||k||l
 from items, (values('retail',1,120000),('retail',2,5000),('cost_last',1,99999),('wholesale',1,110000)) v(k,l,p)
 where client_id in ('e78-a','e78-b','e78-h') and not (client_id<>'e78-a' and l=2);
set role authenticated;
select pg_temp.act('e7800000-0000-0000-0000-000000000001');
select set_storefront_items(pg_temp.id('shop'),(select jsonb_agg(jsonb_build_object('itemId',id,'published',client_id<>'e78-h','description',case when client_id='e78-a' then 'Long grain' end)) from items where client_id like 'e78-%' and tenant_id=pg_temp.id('tenant')),'e78-i');
select set_storefront_settings(pg_temp.id('shop'),'{"slug":"e78-shop","displayName":"E78 Kirana","deliveryEnabled":true,"deliveryFeePaise":3000}','e78-s');
reset role;

set role anon;
select is(public_storefront('e78-shop'),null,'a shop that is not enabled is invisible');
reset role;
set role authenticated;
select pg_temp.act('e7800000-0000-0000-0000-000000000001');
select set_storefront_settings(pg_temp.id('shop'),'{"slug":"e78-shop","displayName":"E78 Kirana","enabled":true,"deliveryEnabled":true,"deliveryFeePaise":3000}','e78-s');
reset role;

set role anon;
select is(public_storefront('E78-SHOP')->>'name','E78 Kirana','an enabled shop is visible by slug (any case)');
select is(public_storefront('e78-shop')->>'deliveryFeePaise','3000','delivery fee is public');
select ok(not (public_storefront('e78-shop') ?| array['tenantId','shopId','gstin','shopPhone']),'no internal ids (the shop address is public since 0082)');
select is(jsonb_array_length(public_catalog('e78-shop')->'items'),2,'only published items that have a retail price');
select is(public_catalog('e78-shop')->'items'->1->>'name','Rice 100%','sorted by name');
select is(public_catalog('e78-shop')->'items'->1->'units','[{"unit":"bag","level":1,"pricePaise":"120000"},{"unit":"kg","level":2,"pricePaise":"5000"}]'::jsonb,'each unit carries its retail price only');
select is((select count(*)::int from jsonb_object_keys(public_catalog('e78-shop')->'items'->0) k where k not in ('id','name','category','description','units','inStock','hasImage')),0,'exact item key allowlist');
select ok(position('99999' in public_catalog('e78-shop')::text)=0 and position('110000' in public_catalog('e78-shop')::text)=0,'cost and wholesale prices never appear');
select is(public_catalog('e78-shop')->'items'->1->>'inStock','false','in-stock is a yes/no only');
select is(jsonb_array_length(public_catalog('e78-shop','100%')->'items'),1,'a % in search is literal');
select is(jsonb_array_length(public_catalog('e78-shop',null,null,'Dal',null)->'items'),1,'keyset paging');
select is(public_catalog_categories('e78-shop')->0->>'name','Grains','categories of published items');
select is(public_catalog('e78-closed'),null,'another tenant''s closed shop returns nothing');
select throws_ok($$ select count(*) from items $$,'42501',null,'anon cannot read items');
select throws_ok($$ select count(*) from storefront_items $$,'42501',null,'anon cannot read storefront_items');
reset role;
select * from finish();
rollback;
