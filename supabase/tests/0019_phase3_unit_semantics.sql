begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

insert into auth.users(id) values ('a3100000-0000-0000-0000-000000000001') on conflict do nothing;
set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a3100000-0000-0000-0000-000000000001','role','authenticated')::text,true);
select lives_ok($$select create_tenant('Unit Semantics','unit-semantics','Main Shop','p3-unit-tenant')$$,'create unit-semantics tenant');
select set_config('p3u.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
select lives_ok($$insert into items(tenant_id,name,sku,unit1,unit2,unit3,conv1,conv2,client_id) values(current_tenant_id(),'Three Tier Item','THREE-TIER','case','pack','piece',10,5,'p3u-item')$$,'create 3-tier item');
select set_config('p3u.item',(select id::text from items where client_id='p3u-item'),false);

select lives_ok(format($q$select post_purchase(%L::uuid,null,'BIG','2026-09-08',0,0,'p3u-big',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',1,'qty',2,'unit_price_paise',100)),null)$q$,current_setting('p3u.shop'),current_setting('p3u.item')),'2 big units post');
select is((select base_qty from purchase_bill_items where client_id='p3u-big:line:1'),100::numeric,'tier1 big converts through conv1*conv2');
select lives_ok(format($q$select post_purchase(%L::uuid,null,'SMALL','2026-09-08',0,0,'p3u-small',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',2,'qty',3,'unit_price_paise',100)),null)$q$,current_setting('p3u.shop'),current_setting('p3u.item')),'3 small units post');
select is((select base_qty from purchase_bill_items where client_id='p3u-small:line:1'),15::numeric,'tier2 small converts through conv2');
select lives_ok(format($q$select post_purchase(%L::uuid,null,'PIECE','2026-09-08',0,0,'p3u-piece',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',3,'qty',4,'unit_price_paise',100)),null)$q$,current_setting('p3u.shop'),current_setting('p3u.item')),'4 pieces post');
select is((select base_qty from purchase_bill_items where client_id='p3u-piece:line:1'),4::numeric,'tier3 piece is already smallest unit');
select is((select qty_base from stock_current where shop_id=current_setting('p3u.shop')::uuid and item_id=current_setting('p3u.item')::uuid),119::numeric,'all tiers aggregate to 119 smallest units');
select lives_ok($$select void_purchase((select id from purchase_bills where client_id='p3u-big'),'p3u-void-big'); select void_purchase((select id from purchase_bills where client_id='p3u-small'),'p3u-void-small'); select void_purchase((select id from purchase_bills where client_id='p3u-piece'),'p3u-void-piece')$$,'void all three purchases');
select is((select coalesce(qty_base,0) from stock_current where shop_id=current_setting('p3u.shop')::uuid and item_id=current_setting('p3u.item')::uuid),0::numeric,'voids reverse every tier exactly');
reset role;
select * from finish();
rollback;
