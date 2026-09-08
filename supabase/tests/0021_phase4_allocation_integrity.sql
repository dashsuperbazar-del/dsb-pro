begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

insert into auth.users(id) values ('a4100000-0000-0000-0000-000000000001') on conflict do nothing;
set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a4100000-0000-0000-0000-000000000001','role','authenticated')::text,true);

select lives_ok($$select create_tenant('Phase4 Allocation','phase4-allocation','Main Shop','p4a-tenant')$$,'create allocation tenant');
select set_config('p4a.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
select lives_ok($$insert into customers(tenant_id,name,client_id) values(current_tenant_id(),'Allocation Customer','p4a-customer')$$,'create customer');
select set_config('p4a.customer',(select id::text from customers where client_id='p4a-customer'),false);
select lives_ok($$insert into items(tenant_id,name,sku,unit1,client_id) values(current_tenant_id(),'Allocation Item','P4A-ITEM','piece','p4a-item')$$,'create item');
select set_config('p4a.item',(select id::text from items where client_id='p4a-item'),false);
select lives_ok(format($q$insert into item_prices(tenant_id,item_id,shop_id,kind,unit_level,price_paise,effective_from,client_id) values(current_tenant_id(),%L::uuid,%L::uuid,'retail',1,100,now()-interval '1 day','p4a-price')$q$,current_setting('p4a.item'),current_setting('p4a.shop')),'set retail price');
select lives_ok(format($q$select post_purchase(%L::uuid,null,'P4A-SEED','2026-09-08',0,0,'p4a-seed',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',1,'qty',2,'unit_price_paise',50)),null)$q$,current_setting('p4a.shop'),current_setting('p4a.item')),'seed stock');
select lives_ok(format($q$select post_sale(%L::uuid,%L::uuid,'2026-09-08',0,0,'p4a-sale',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',1,'qty',1,'price_kind','retail')),'[]'::jsonb,null)$q$,current_setting('p4a.shop'),current_setting('p4a.customer'),current_setting('p4a.item')),'post 100-paise credit sale');
select set_config('p4a.sale',(select id::text from sale_invoices where client_id='p4a-sale'),false);

select lives_ok(format($q$select record_customer_payment(%L::uuid,%L::uuid,'2026-09-08',60,'cash','first',jsonb_build_array(jsonb_build_object('sale_invoice_id',%L,'amount_paise',60)),'p4a-pay-1')$q$,current_setting('p4a.shop'),current_setting('p4a.customer'),current_setting('p4a.sale')),'allocate first 60 paise');
select is((select outstanding_paise from customer_invoice_outstanding where sale_invoice_id=current_setting('p4a.sale')::uuid),40::bigint,'outstanding projection shows 40 paise');
select lives_ok(format($q$select record_customer_payment(%L::uuid,%L::uuid,'2026-09-08',40,'upi','second',jsonb_build_array(jsonb_build_object('sale_invoice_id',%L,'amount_paise',40)),'p4a-pay-2')$q$,current_setting('p4a.shop'),current_setting('p4a.customer'),current_setting('p4a.sale')),'allocate remaining 40 paise');
select is((select count(*) from customer_invoice_outstanding where sale_invoice_id=current_setting('p4a.sale')::uuid),0::bigint,'fully settled invoice leaves outstanding view');
select throws_ok(format($q$select record_customer_payment(%L::uuid,%L::uuid,'2026-09-08',1,'cash','over',jsonb_build_array(jsonb_build_object('sale_invoice_id',%L,'amount_paise',1)),'p4a-pay-over')$q$,current_setting('p4a.shop'),current_setting('p4a.customer'),current_setting('p4a.sale')),null,'allocation exceeds invoice balance','payment RPC rejects cumulative over-allocation before insert');
select is((select count(*) from payments where client_id='p4a-pay-over'),0::bigint,'failed RPC over-allocation rolls back its payment');

-- Prove the database trigger itself, independently of the RPC's friendly precheck.
reset role;
select lives_ok(format($q$insert into payments(tenant_id,shop_id,kind,customer_id,business_date,amount_paise,mode,status,client_id) values(current_tenant_id(),%L::uuid,'customer',%L::uuid,'2026-09-08',1,'cash','POSTED','p4a-direct-over')$q$,current_setting('p4a.shop'),current_setting('p4a.customer')),'create direct posted payment for trigger proof');
select set_config('p4a.direct_payment',(select id::text from payments where client_id='p4a-direct-over'),false);
select throws_ok(format($q$insert into payment_allocations(tenant_id,payment_id,doc_type,sale_invoice_id,amount_paise,status,client_id) values(current_tenant_id(),%L::uuid,'SALE',%L::uuid,1,'POSTED','p4a-direct-over:alloc')$q$,current_setting('p4a.direct_payment'),current_setting('p4a.sale')),null,'allocation exceeds document outstanding amount','allocation trigger independently rejects cumulative over-allocation');
select is((select count(*) from payment_allocations where client_id='p4a-direct-over:alloc'),0::bigint,'rejected direct allocation leaves no row');
set role authenticated;

select lives_ok($select void_payment((select id from payments where client_id='p4a-pay-2'))$,'void second payment');
select is((select outstanding_paise from customer_invoice_outstanding where sale_invoice_id=current_setting('p4a.sale')::uuid),40::bigint,'voiding payment restores invoice outstanding amount');

reset role;
select * from finish();
rollback;
