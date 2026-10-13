begin;
create extension if not exists pgtap with schema extensions;
select plan(17);
insert into auth.users(id) values
 ('bd000000-0000-0000-0000-000000000001'),('bd000000-0000-0000-0000-000000000002'),
 ('bd000000-0000-0000-0000-000000000003'),('bd000000-0000-0000-0000-000000000004');
set role authenticated;
select set_config('request.jwt.claims','{"sub":"bd000000-0000-0000-0000-000000000001","role":"authenticated"}',true);
select create_tenant('BillDocs Co','billdocs-co','BillDocs Shop','billdocs-tenant');
select set_config('bd.tenant',current_tenant_id()::text,false);
select set_config('bd.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
select set_config('bd.client','bd000000-0000-0000-0000-000000000099',false);
select set_config('bd.path',current_setting('bd.tenant')||'/'||current_setting('bd.shop')||'/'||current_setting('bd.client')||'/bd000000-0000-0000-0000-000000000098.pdf',false);
insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'BillDocs Item','piece','billdocs-item');
create function pg_temp.post_doc(p_doc text,p_client text default current_setting('bd.client')) returns uuid language sql as $$
 select post_purchase(current_setting('bd.shop')::uuid,null,'BD-1','2026-10-14',0,0,p_client,
  jsonb_build_array(jsonb_build_object('item_id',(select id from items where client_id='billdocs-item'),'qty','2','unit_price_paise',100)),p_doc)
$$;
select throws_like($$select pg_temp.post_doc(current_setting('bd.path'))$$,'DSB_BILL_DOCUMENT_INVALID%','a missing upload cannot post a bill');
select is((select count(*) from purchase_bills where client_id=current_setting('bd.client')),0::bigint,'failed image binding creates no liability');
select lives_ok($$insert into storage.objects(bucket_id,name,metadata) values('bill-documents',current_setting('bd.path'),'{"mimetype":"application/pdf","size":100}')$$,'owner can insert own-shop private document');
select lives_ok($$select pg_temp.post_doc(current_setting('bd.path'))$$,'purchase binds its existing uploaded original');
select set_config('bd.bill',(select id::text from purchase_bills where client_id=current_setting('bd.client')),false);
select is(pg_temp.post_doc(current_setting('bd.path')),current_setting('bd.bill')::uuid,'exact photo retry returns original bill');
select throws_like($$select pg_temp.post_doc(null)$$,'DSB_PAYLOAD_MISMATCH%','null cannot drop the image on a retry');
select throws_like($$select pg_temp.post_doc(current_setting('bd.path'),'bd000000-0000-0000-0000-000000000097')$$,'DSB_BILL_DOCUMENT_INVALID%','another purchase cannot bind this request image');
select is((select count(*) from purchase_bills where client_id=current_setting('bd.client')),1::bigint,'one purchase only after retries');
select is((select qty_base::numeric from stock_current where shop_id=current_setting('bd.shop')::uuid and item_id=(select id from items where client_id='billdocs-item')),2::numeric,'stock moved once');
select results_eq($$with changed as(update storage.objects set metadata='{}' where bucket_id='bill-documents' returning id) select count(*) from changed$$,$$values(0::bigint)$$,'owner cannot overwrite an uploaded original');
reset role;
select is((select public from storage.buckets where id='bill-documents'),false,'bill bucket is private');
select is((select count(*) from pg_policies where schemaname='storage' and tablename='objects' and policyname like 'bill_documents_%' and cmd in ('UPDATE','DELETE','ALL')),0::bigint,'there is no destructive client policy');
insert into tenant_users(tenant_id,user_id,role,shop_ids,created_by) values
 (current_setting('bd.tenant')::uuid,'bd000000-0000-0000-0000-000000000002','cashier',array[current_setting('bd.shop')::uuid],'bd000000-0000-0000-0000-000000000001'),
 (current_setting('bd.tenant')::uuid,'bd000000-0000-0000-0000-000000000003','accountant',array[current_setting('bd.shop')::uuid],'bd000000-0000-0000-0000-000000000001');
set role authenticated;
select set_config('request.jwt.claims','{"sub":"bd000000-0000-0000-0000-000000000002","role":"authenticated"}',true);
select is((select count(*) from storage.objects where bucket_id='bill-documents'),0::bigint,'cashier cannot read supplier cost photos');
select throws_like($$insert into storage.objects(bucket_id,name) values('bill-documents',current_setting('bd.path')||'x')$$,'%row-level security%','cashier cannot upload supplier documents');
select set_config('request.jwt.claims','{"sub":"bd000000-0000-0000-0000-000000000003","role":"authenticated"}',true);
select is((select count(*) from storage.objects where bucket_id='bill-documents'),1::bigint,'assigned accountant can read bill document');
reset role;
update tenant_users set shop_ids='{}' where user_id='bd000000-0000-0000-0000-000000000003';
set role authenticated;
select is((select count(*) from storage.objects where bucket_id='bill-documents'),0::bigint,'unassigned accountant cannot read another shop document');
select set_config('request.jwt.claims','{"sub":"bd000000-0000-0000-0000-000000000004","role":"authenticated"}',true);
select create_tenant('OtherBillDocs Co','otherbilldocs-co','OtherBillDocs Shop','otherbilldocs-tenant');
select is((select count(*) from storage.objects where bucket_id='bill-documents'),0::bigint,'other tenant owner cannot read the original');
select * from finish();
rollback;
