begin;
create extension if not exists pgtap with schema extensions;
select plan(21);

insert into auth.users(id) values
 ('a3000000-0000-0000-0000-000000000001'),
 ('a3000000-0000-0000-0000-000000000002'),
 ('a3000000-0000-0000-0000-000000000003')
on conflict do nothing;

-- Tenant A owner.
set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a3000000-0000-0000-0000-000000000001','role','authenticated')::text,true);
select lives_ok($$select create_tenant('Phase3 A','phase3-a','A Shop','p3-a-tenant')$$,'create tenant A');
select set_config('p3.tenant_a',current_tenant_id()::text,false);
select set_config('p3.shop_a',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
select lives_ok($$insert into categories(tenant_id,name,client_id) values(current_tenant_id(),'Food','p3-cat-a')$$,'owner creates category');
select lives_ok($$insert into parties(tenant_id,name,client_id) values(current_tenant_id(),'Supplier A','p3-party-a')$$,'owner creates party');
select lives_ok($$insert into items(tenant_id,name,sku,unit1,unit2,conv1,tax_rate_bp,client_id) values(current_tenant_id(),'Rice','RICE-A','kg','bag',25,500,'p3-item-a')$$,'owner creates item');
select set_config('p3.item_a',(select id::text from items where client_id='p3-item-a'),false);
select set_config('p3.party_a',(select id::text from parties where client_id='p3-party-a'),false);
select lives_ok($$insert into item_prices(tenant_id,item_id,kind,unit_level,price_paise,effective_from,effective_to,client_id) values(current_tenant_id(),current_setting('p3.item_a')::uuid,'retail',1,6500,'2026-01-01','2026-02-01','p3-price-a1')$$,'first price interval accepted');
select throws_ok($$insert into item_prices(tenant_id,item_id,kind,unit_level,price_paise,effective_from,effective_to,client_id) values(current_tenant_id(),current_setting('p3.item_a')::uuid,'retail',1,6600,'2026-01-15','2026-03-01','p3-price-a2')$$,'23P01',null,'overlapping price interval rejected');

select lives_ok(format($q$select post_purchase(%L::uuid,%L::uuid,'PB-1','2026-09-08',100,50,'p3-purchase-a',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',2,'qty',2,'unit_price_paise',50000)),null)$q$,current_setting('p3.shop_a'),current_setting('p3.party_a'),current_setting('p3.item_a')),'post_purchase succeeds');
select is((select total_paise from purchase_bills where client_id='p3-purchase-a'),99950::bigint,'purchase total uses integer paise');
select is((select qty_base from stock_current where item_id=current_setting('p3.item_a')::uuid and shop_id=current_setting('p3.shop_a')::uuid),50::numeric,'purchase creates exact base stock');
select is((select count(*) from purchase_bills where client_id='p3-purchase-a'),1::bigint,'purchase exists once');
select lives_ok(format($q$select post_purchase(%L::uuid,%L::uuid,'PB-1','2026-09-08',100,50,'p3-purchase-a',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',2,'qty',2,'unit_price_paise',50000)),null)$q$,current_setting('p3.shop_a'),current_setting('p3.party_a'),current_setting('p3.item_a')),'duplicate client_id returns existing purchase');
select is((select count(*) from stock_movements where client_id like 'p3-purchase-a:stock:%'),1::bigint,'duplicate client_id creates no duplicate stock');
select throws_ok(format($q$insert into stock_movements(tenant_id,shop_id,item_id,source_type,source_id,qty_base,client_id) values(%L::uuid,%L::uuid,%L::uuid,'ADJUSTMENT',gen_random_uuid(),1,'direct-stock')$q$,current_setting('p3.tenant_a'),current_setting('p3.shop_a'),current_setting('p3.item_a')),'42501',null,'authenticated client cannot write stock directly');
select lives_ok($$select void_purchase((select id from purchase_bills where client_id='p3-purchase-a'),'p3-void-a')$$,'void purchase succeeds');
select is((select coalesce(qty_base,0) from stock_current where item_id=current_setting('p3.item_a')::uuid and shop_id=current_setting('p3.shop_a')::uuid),0::numeric,'void reverses stock exactly');
reset role;

-- Tenant B proves RLS isolation.
set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a3000000-0000-0000-0000-000000000002','role','authenticated')::text,true);
select lives_ok($$select create_tenant('Phase3 B','phase3-b','B Shop','p3-b-tenant')$$,'create tenant B');
select is((select count(*) from items where id=current_setting('p3.item_a')::uuid),0::bigint,'tenant B cannot read tenant A item');
select is((select count(*) from purchase_bills where client_id='p3-purchase-a'),0::bigint,'tenant B cannot read tenant A purchase');
reset role;

-- Cashier in tenant A can read master but cannot mutate it or post purchases.
reset role;
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id)
values(current_setting('p3.tenant_a')::uuid,'a3000000-0000-0000-0000-000000000003','cashier',array[current_setting('p3.shop_a')::uuid],'active','p3-cashier');
set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a3000000-0000-0000-0000-000000000003','role','authenticated')::text,true);
select is((select count(*) from items where id=current_setting('p3.item_a')::uuid),1::bigint,'cashier can read item master');
select throws_ok($$insert into categories(tenant_id,name,client_id) values(current_tenant_id(),'Blocked','p3-blocked')$$,'42501',null,'cashier cannot mutate master data');
select throws_ok(format($q$select post_purchase(%L::uuid,null,'NO','2026-09-08',0,0,'p3-cashier-post',jsonb_build_array(jsonb_build_object('item_id',%L,'qty',1,'unit_price_paise',1)),null)$q$,current_setting('p3.shop_a'),current_setting('p3.item_a')),null,'not permitted','cashier cannot post purchase');
reset role;

select * from finish();
rollback;
