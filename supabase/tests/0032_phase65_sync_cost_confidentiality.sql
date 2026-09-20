begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

insert into auth.users(id) values
 ('a4100000-0000-0000-0000-000000000001'),
 ('a4100000-0000-0000-0000-000000000002')
on conflict do nothing;

select ok(
 not has_function_privilege('authenticated','public.phase4_current_price(uuid,uuid,uuid,text,integer)','EXECUTE'),
 'internal current-price resolver is not executable by authenticated callers'
);
select ok(
 not has_function_privilege('authenticated','public.phase6_export_tenant_v3_base(uuid)','EXECUTE'),
 'export base containing raw item prices remains internal-only'
);
select ok(
 not has_function_privilege('authenticated','public.phase6_export_tenant_v4_base(uuid)','EXECUTE'),
 'return-aware export base remains internal-only'
);

set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a4100000-0000-0000-0000-000000000001','role','authenticated')::text,true);
select lives_ok($$select create_tenant('A1 Tenant','a1-tenant','A1 Shop','a1-tenant-create')$$,'owner creates A1 tenant');
select set_config('a1.tenant',current_tenant_id()::text,false);
select set_config('a1.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
select lives_ok($$select register_device('a1-owner-phone','a1-owner-device')$$,'owner registers sync device');
select lives_ok($$insert into items(tenant_id,name,unit1,tax_rate_bp,client_id) values(current_tenant_id(),'A1 Item','Pcs',0,'a1-item')$$,'owner creates A1 item');
select set_config('a1.item',(select id::text from items where client_id='a1-item'),false);
select lives_ok(format($q$select set_item_price(%L::uuid,%L::uuid,'retail',1::smallint,125::bigint,'a1-retail')$q$,current_setting('a1.item'),current_setting('a1.shop')),'owner writes retail price');
select lives_ok(format($q$select set_item_price(%L::uuid,%L::uuid,'cost_last',1::smallint,77::bigint,'a1-cost')$q$,current_setting('a1.item'),current_setting('a1.shop')),'owner writes confidential cost price');
select pg_sleep(1.1);

select is((select count(*) from item_prices where kind='cost_last'),1::bigint,'owner direct query can read cost price');
select is((phase5_sync_pull('a1-owner-phone',current_setting('a1.shop')::uuid,1,'{}'::jsonb)#>>'{policy,canViewCostPrices}')::boolean,true,'owner sync capability allows cost prices');
select ok(exists(
 select 1 from jsonb_array_elements(phase5_sync_pull('a1-owner-phone',current_setting('a1.shop')::uuid,1,'{}'::jsonb)->'prices') p
 where p->>'kind'='cost_last' and (p->>'price_paise')::bigint=77
),'authorized owner sync receives cost price');

reset role;
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id)
values(current_setting('a1.tenant')::uuid,'a4100000-0000-0000-0000-000000000002','cashier',array[current_setting('a1.shop')::uuid],'active','a1-cashier');

set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a4100000-0000-0000-0000-000000000002','role','authenticated')::text,true);
select lives_ok($$select register_device('a1-cashier-phone','a1-cashier-device')$$,'cashier registers sync device');
select is((select count(*) from item_prices where kind='cost_last'),0::bigint,'cashier direct query cannot read cost price');
select is((phase5_sync_pull('a1-cashier-phone',current_setting('a1.shop')::uuid,1,'{}'::jsonb)#>>'{policy,canViewCostPrices}')::boolean,false,'cashier sync capability denies cost prices');
select ok(not exists(
 select 1 from jsonb_array_elements(phase5_sync_pull('a1-cashier-phone',current_setting('a1.shop')::uuid,1,'{}'::jsonb)->'prices') p
 where p->>'kind'='cost_last'
),'cashier sync never receives cost price');
select ok(exists(
 select 1 from jsonb_array_elements(phase5_sync_pull('a1-cashier-phone',current_setting('a1.shop')::uuid,1,'{}'::jsonb)->'prices') p
 where p->>'kind'='retail' and (p->>'price_paise')::bigint=125
),'cashier sync still receives sale price');
select throws_ok(
 format($q$select set_item_price(%L::uuid,%L::uuid,'cost_last',1::smallint,88::bigint,'a1-cashier-cost')$q$,current_setting('a1.item'),current_setting('a1.shop')),
 null,'not permitted','cashier cannot write cost prices'
);
select throws_ok(
 format($q$select import_legacy_dsb_master(%L::uuid,'{}'::jsonb,'a1-cashier-import')$q$,current_setting('a1.shop')),
 null,'legacy import requires owner','cashier cannot use owner-only price importer'
);
select throws_ok(
 format($q$select * from get_stock_valuation(%L::uuid)$q$,current_setting('a1.shop')),
 null,'not permitted','cashier cannot use cost-bearing stock valuation'
);
select throws_ok(
 format($q$select phase6_export_tenant(%L::uuid)$q$,current_setting('a1.shop')),
 null,'not permitted','cashier cannot use complete tenant export'
);

select * from finish();
rollback;
