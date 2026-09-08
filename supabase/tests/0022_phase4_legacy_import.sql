begin;
create extension if not exists pgtap with schema extensions;
select plan(18);

insert into auth.users(id) values
 ('a7000000-0000-0000-0000-000000000001'),
 ('a7000000-0000-0000-0000-000000000002')
on conflict do nothing;

set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a7000000-0000-0000-0000-000000000001','role','authenticated')::text,true);
select lives_ok($$select create_tenant('Legacy Import','legacy-import','Import Shop','legacy-import-tenant')$$,'create owner shop');
select set_config('p4i.tenant',current_tenant_id()::text,false);
select set_config('p4i.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);

select lives_ok(format($q$
  select import_legacy_dsb_master(
    %L::uuid,
    jsonb_build_object(
      'sourceVersion',3,
      'exportedAt','2026-09-08T17:07:18.601Z',
      'parties',jsonb_build_array(jsonb_build_object('legacyId','P1','name','Supplier','phone','111','gstin','','address','Market')),
      'customers',jsonb_build_array(jsonb_build_object('legacyId','C1','name','Santosh','phone','222','address','','gstin','','creditLimitPaise',5000,'notes','Online')),
      'items',jsonb_build_array(jsonb_build_object(
        'legacyId','I1','name','Legacy Biscuit','unit1','Ctn','unit2','Pkt','unit3','Pcs','conv1',12,'conv2',12,
        'taxRateBp',500,'isActive',true,'openingStockSmallest',288,
        'prices',jsonb_build_array(
          jsonb_build_object('kind','retail','unitLevel',3,'pricePaise',500),
          jsonb_build_object('kind','wholesale','unitLevel',3,'pricePaise',450),
          jsonb_build_object('kind','retail','unitLevel',2,'pricePaise',6000)
        )
      ))
    ),
    'legacy-import-run-1'
  )
$q$,current_setting('p4i.shop')),'owner imports transformed legacy opening state');

select is((select count(*) from items where tenant_id=current_setting('p4i.tenant')::uuid),1::bigint,'imports one item');
select is((select count(*) from parties where tenant_id=current_setting('p4i.tenant')::uuid),1::bigint,'imports one supplier');
select is((select count(*) from customers where tenant_id=current_setting('p4i.tenant')::uuid),1::bigint,'imports one customer');
select is((select count(*) from item_prices where tenant_id=current_setting('p4i.tenant')::uuid),3::bigint,'imports all transformed prices');
select is((select qty_base from stock_current where shop_id=current_setting('p4i.shop')::uuid),288::numeric,'opening stock is stored in smallest units');
select is((select tax_rate_bp from items where client_id='legacy:item:I1'),500,'GST remains informational item metadata');
select is((select count(*) from purchase_bills where tenant_id=current_setting('p4i.tenant')::uuid),0::bigint,'does not fabricate purchase history');
select is((select count(*) from sale_invoices where tenant_id=current_setting('p4i.tenant')::uuid),0::bigint,'does not fabricate sale history');
select is((select count(*) from stock_movements where client_id='legacy:opening-stock:I1'),1::bigint,'opening stock has one immutable movement');
select is((select summary->>'items' from legacy_import_runs where client_id='legacy-import-run-1'),'1','records import summary');

select lives_ok(format($q$
 select import_legacy_dsb_master(%L::uuid,
   jsonb_build_object('sourceVersion',3,'exportedAt','2026-09-08T17:07:18.601Z','parties','[]'::jsonb,'customers','[]'::jsonb,'items',jsonb_build_array(jsonb_build_object('legacyId','ignored','name','Ignored','unit1','Pcs','unit2',null,'unit3',null,'conv1',null,'conv2',null,'taxRateBp',0,'isActive',true,'openingStockSmallest',0,'prices','[]'::jsonb))),
   'legacy-import-run-1')
$q$,current_setting('p4i.shop')),'same client_id is idempotent after success');
select is((select count(*) from items where tenant_id=current_setting('p4i.tenant')::uuid),1::bigint,'idempotent retry creates no item duplicate');

reset role;
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id,created_by)
values(current_setting('p4i.tenant')::uuid,'a7000000-0000-0000-0000-000000000002','manager',array[current_setting('p4i.shop')::uuid],'active','legacy-import-manager','a7000000-0000-0000-0000-000000000001');

set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a7000000-0000-0000-0000-000000000002','role','authenticated')::text,true);
select throws_ok(
  format($q$select import_legacy_dsb_master(%L::uuid,jsonb_build_object('sourceVersion',3,'exportedAt','2026-09-09T00:00:00Z','items','[]'::jsonb,'parties','[]'::jsonb,'customers','[]'::jsonb),'manager-attempt')$q$,current_setting('p4i.shop')),
  null,'legacy import requires owner','manager cannot run opening-state import');
select is((select count(*) from legacy_import_runs),0::bigint,'manager cannot read owner import-run metadata');

select set_config('request.jwt.claims',json_build_object('sub','a7000000-0000-0000-0000-000000000001','role','authenticated')::text,true);
select is((select count(*) from legacy_import_runs),1::bigint,'owner can read import-run metadata');
select throws_ok(
  format($q$select import_legacy_dsb_master(%L::uuid,jsonb_build_object('sourceVersion',3,'exportedAt','2026-09-09T00:00:00Z','items',jsonb_build_array(jsonb_build_object('legacyId','I2','name','Second','unit1','Pcs','unit2',null,'unit3',null,'conv1',null,'conv2',null,'taxRateBp',0,'isActive',true,'openingStockSmallest',1,'prices','[]'::jsonb)),'parties','[]'::jsonb,'customers','[]'::jsonb),'second-import')$q$,current_setting('p4i.shop')),
  null,'shop must be empty before legacy import','new opening-state import is rejected after shop begins operating');

select * from finish();
rollback;
