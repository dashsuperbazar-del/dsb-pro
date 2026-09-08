begin;
create extension if not exists pgtap with schema extensions;
select plan(34);

insert into auth.users(id) values
 ('a4000000-0000-0000-0000-000000000001'),
 ('a4000000-0000-0000-0000-000000000002'),
 ('a4000000-0000-0000-0000-000000000003')
on conflict do nothing;

set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a4000000-0000-0000-0000-000000000001','role','authenticated')::text,true);
select lives_ok($$select create_tenant('Phase4 A','phase4-a','A Shop','p4-a-tenant')$$,'create Phase 4 tenant');
select set_config('p4.tenant',current_tenant_id()::text,false);
select set_config('p4.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
select lives_ok($$insert into customers(tenant_id,name,phone,client_id) values(current_tenant_id(),'Test Customer','9999999999','p4-customer')$$,'owner creates customer');
select set_config('p4.customer',(select id::text from customers where client_id='p4-customer'),false);
select lives_ok($$insert into items(tenant_id,name,sku,unit1,unit2,unit3,conv1,conv2,tax_rate_bp,client_id) values(current_tenant_id(),'Chocolate','CHOC-P4','case','pack','piece',10,5,500,'p4-item')$$,'create three-tier sale item');
select set_config('p4.item',(select id::text from items where client_id='p4-item'),false);
select lives_ok($$insert into item_prices(tenant_id,item_id,shop_id,kind,unit_level,price_paise,effective_from,client_id) values(current_tenant_id(),current_setting('p4.item')::uuid,current_setting('p4.shop')::uuid,'retail',3,100,now()-interval '1 day','p4-price-piece')$$,'set server sale price');
select lives_ok(format($q$select post_purchase(%L::uuid,null,'P4-SEED','2026-09-08',0,0,'p4-seed',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',1,'qty',1,'unit_price_paise',1000)),null)$q$,current_setting('p4.shop'),current_setting('p4.item')),'seed one big unit of stock');
select is((select qty_base from stock_current where shop_id=current_setting('p4.shop')::uuid and item_id=current_setting('p4.item')::uuid),50::numeric,'stock projection stores 50 pieces');

select lives_ok(format($q$select post_sale(%L::uuid,%L::uuid,'2026-09-08',5,15,'p4-sale-1',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',3,'qty',2,'price_kind','retail','discount_paise',10)),jsonb_build_array(jsonb_build_object('amount_paise',100,'mode','cash'),jsonb_build_object('amount_paise',100,'mode','upi')),'split tender')$q$,current_setting('p4.shop'),current_setting('p4.customer'),current_setting('p4.item')),'post split-tender customer sale');
select is((select total_paise from sale_invoices where client_id='p4-sale-1'),200::bigint,'sale total uses inclusive price and integer discounts/charges');
select is((select tax_rate_bp_snapshot from sale_invoice_items where client_id='p4-sale-1:line:1'),500,'GST rate is informational snapshot');
select is((select qty_base from stock_current where shop_id=current_setting('p4.shop')::uuid and item_id=current_setting('p4.item')::uuid),48::numeric,'sale decrements exact smallest-unit stock');
select is((select count(*) from payments where source_sale_invoice_id=(select id from sale_invoices where client_id='p4-sale-1') and status='POSTED'),2::bigint,'split tender creates two immutable payments');
select is((select balance_paise from customer_balances where customer_id=current_setting('p4.customer')::uuid),0::bigint,'fully paid customer sale balances to zero');
select lives_ok(format($q$select post_sale(%L::uuid,%L::uuid,'2026-09-08',5,15,'p4-sale-1',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',3,'qty',2,'price_kind','retail','discount_paise',10)),jsonb_build_array(jsonb_build_object('amount_paise',100,'mode','cash'),jsonb_build_object('amount_paise',100,'mode','upi')),'retry')$q$,current_setting('p4.shop'),current_setting('p4.customer'),current_setting('p4.item')),'duplicate sale client_id returns existing sale');
select is((select count(*) from sale_invoices where client_id='p4-sale-1'),1::bigint,'duplicate sale exists once');
select is((select count(*) from stock_movements where client_id like 'p4-sale-1:stock:%'),1::bigint,'duplicate sale creates no duplicate stock movement');
select lives_ok($$select void_sale((select id from sale_invoices where client_id='p4-sale-1'),'p4-void-sale-1')$$,'owner voids finalized sale');
select is((select qty_base from stock_current where shop_id=current_setting('p4.shop')::uuid and item_id=current_setting('p4.item')::uuid),50::numeric,'sale void restores stock exactly');
select is((select status from sale_invoices where client_id='p4-sale-1'),'VOID','sale is marked VOID');
select is((select count(*) from payments where source_sale_invoice_id=(select id from sale_invoices where client_id='p4-sale-1') and status='VOID'),2::bigint,'sale-sourced tenders void with sale');
reset role;

insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id)
values(current_setting('p4.tenant')::uuid,'a4000000-0000-0000-0000-000000000002','cashier',array[current_setting('p4.shop')::uuid],'active','p4-cashier');
set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a4000000-0000-0000-0000-000000000002','role','authenticated')::text,true);
select throws_ok($$select void_sale((select id from sale_invoices where client_id='p4-sale-1'),'p4-cashier-void')$$,null,'not permitted','cashier cannot void sales');
select lives_ok(format($q$select post_sale(%L::uuid,null,'2026-09-08',0,0,'p4-walkin',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',3,'qty',1,'price_kind','retail')),jsonb_build_array(jsonb_build_object('amount_paise',100,'mode','cash')),null)$q$,current_setting('p4.shop'),current_setting('p4.item')),'cashier posts fully-paid walk-in sale');
select is((select count(*) from sale_invoices where client_id='p4-walkin'),1::bigint,'walk-in invoice persisted once');
select is((select qty_base from stock_current where shop_id=current_setting('p4.shop')::uuid and item_id=current_setting('p4.item')::uuid),49::numeric,'walk-in sale decrements stock');
select is((select kind from payments where client_id='p4-walkin:pay:1'),'walkin','anonymous tender has explicit walk-in identity');
reset role;

set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a4000000-0000-0000-0000-000000000001','role','authenticated')::text,true);
select lives_ok(format($q$select post_sale(%L::uuid,%L::uuid,'2026-09-08',0,0,'p4-credit-sale',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',3,'qty',1,'price_kind','retail')),'[]'::jsonb,null)$q$,current_setting('p4.shop'),current_setting('p4.customer'),current_setting('p4.item')),'customer credit sale may remain unpaid');
select is((select balance_paise from customer_balances where customer_id=current_setting('p4.customer')::uuid),100::bigint,'credit sale creates receivable');
select lives_ok(format($q$select record_customer_payment(%L::uuid,%L::uuid,'2026-09-08',150,'upi','advance plus settlement',jsonb_build_array(jsonb_build_object('sale_invoice_id',%L,'amount_paise',100)),'p4-customer-pay')$q$,current_setting('p4.shop'),current_setting('p4.customer'),(select id::text from sale_invoices where client_id='p4-credit-sale')),'record payment with selected invoice allocation');
select is((select balance_paise from customer_balances where customer_id=current_setting('p4.customer')::uuid),(-50)::bigint,'unallocated remainder becomes customer advance');
select is((select amount_paise from payment_allocations where client_id='p4-customer-pay:alloc:1'),100::bigint,'selected invoice allocation is stored as a row');
select lives_ok($$select void_payment((select id from payments where client_id='p4-customer-pay'))$$,'owner voids incorrect customer payment');
select is((select balance_paise from customer_balances where customer_id=current_setting('p4.customer')::uuid),100::bigint,'void payment restores receivable without deleting history');
reset role;

set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a4000000-0000-0000-0000-000000000003','role','authenticated')::text,true);
select lives_ok($$select create_tenant('Phase4 B','phase4-b','B Shop','p4-b-tenant')$$,'create second tenant');
select is((select count(*) from sale_invoices where client_id in ('p4-walkin','p4-credit-sale')),0::bigint,'tenant B cannot read tenant A sales');
select is((select count(*) from customers where id=current_setting('p4.customer')::uuid),0::bigint,'tenant B cannot read tenant A customer');
reset role;

select * from finish();
rollback;
