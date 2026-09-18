begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

insert into auth.users(id) values
 ('b6540000-0000-0000-0000-000000000001'),
 ('b6540000-0000-0000-0000-000000000002');

select ok(not has_function_privilege('anon','get_low_stock_report(uuid)','execute'),'anon cannot read low stock report');
select ok(not has_function_privilege('anon','get_item_sales_report(uuid,date,date)','execute'),'anon cannot read item sales report');
select ok(not has_function_privilege('anon','get_purchase_register(uuid,date,date)','execute'),'anon cannot read purchase register');
select ok(not has_function_privilege('anon','get_customer_aging_report(uuid,date)','execute'),'anon cannot read customer aging report');

set role authenticated;
select set_config('request.jwt.claims','{"sub":"b6540000-0000-0000-0000-000000000001","role":"authenticated"}',true);
select create_tenant('Reports Co','reports-co','Reports Shop','rp-tenant');
select set_config('rp.tenant',current_tenant_id()::text,false);
select set_config('rp.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);

-- Low stock: one item below its threshold, one comfortably above it.
insert into items(tenant_id,name,unit1,min_stock,client_id) values
 (current_tenant_id(),'Low Stock Item','piece',3,'rp-low-item'),
 (current_tenant_id(),'Ample Stock Item','piece',3,'rp-ample-item');
select set_config('rp.low_item',(select id::text from items where client_id='rp-low-item'),false);
select set_config('rp.ample_item',(select id::text from items where client_id='rp-ample-item'),false);
select set_item_price(current_setting('rp.low_item')::uuid,current_setting('rp.shop')::uuid,'retail',1::smallint,100::bigint,'rp-low-price');
select set_item_price(current_setting('rp.ample_item')::uuid,current_setting('rp.shop')::uuid,'retail',1::smallint,100::bigint,'rp-ample-price');
select post_purchase(current_setting('rp.shop')::uuid,null,'RP-SEED','2026-09-19',0,0,'rp-seed',jsonb_build_array(
 jsonb_build_object('item_id',current_setting('rp.low_item'),'unit_level',1,'qty',10,'unit_price_paise',50),
 jsonb_build_object('item_id',current_setting('rp.ample_item'),'unit_level',1,'qty',10,'unit_price_paise',50)),null);
-- Sell the low-stock item down to 2 (below its min_stock of 3); leave the other at 10.
select post_sale(current_setting('rp.shop')::uuid,null,'2026-09-19',0,0,'rp-drawdown',jsonb_build_array(
 jsonb_build_object('item_id',current_setting('rp.low_item'),'unit_level',1,'qty',8,'price_kind','retail')),
 jsonb_build_array(jsonb_build_object('amount_paise',800,'mode','cash')),null);

select is((select count(*) from get_low_stock_report(current_setting('rp.shop')::uuid)),1::bigint,'only the item below its threshold is reported');
select is((select shortfall from get_low_stock_report(current_setting('rp.shop')::uuid) where item_id=current_setting('rp.low_item')::uuid),1::numeric,'shortfall is min_stock minus on_hand');
select is((select on_hand from get_low_stock_report(current_setting('rp.shop')::uuid) where item_id=current_setting('rp.low_item')::uuid),2::numeric,'on_hand reflects the real projection');

-- Item sales: sell 4 of a fresh item, return 1, and check both directions of
-- the FULL OUTER JOIN (an item returned with no further sale in range).
insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'Sales Report Item','piece','rp-sales-item');
select set_config('rp.sales_item',(select id::text from items where client_id='rp-sales-item'),false);
select set_item_price(current_setting('rp.sales_item')::uuid,current_setting('rp.shop')::uuid,'retail',1::smallint,100::bigint,'rp-sales-price');
select post_purchase(current_setting('rp.shop')::uuid,null,'RP-SALES-SEED','2026-09-19',0,0,'rp-sales-seed',jsonb_build_array(jsonb_build_object('item_id',current_setting('rp.sales_item'),'unit_level',1,'qty',20,'unit_price_paise',50)),null);
select post_sale(current_setting('rp.shop')::uuid,null,'2026-09-19',0,0,'rp-sales-sale',jsonb_build_array(jsonb_build_object('item_id',current_setting('rp.sales_item'),'unit_level',1,'qty',4,'price_kind','retail')),jsonb_build_array(jsonb_build_object('amount_paise',400,'mode','cash')),null);
select post_return('SALE',(select id from sale_invoices where client_id='rp-sales-sale'),'2026-09-19','rp-sales-return',jsonb_build_array(jsonb_build_object('sale_invoice_item_id',(select id from sale_invoice_items where sale_invoice_id=(select id from sale_invoices where client_id='rp-sales-sale')),'qty',1,'disposition','RETURN_TO_SELLABLE')),null);

select is((select qty_sold from get_item_sales_report(current_setting('rp.shop')::uuid,'2026-09-19','2026-09-19') where item_id=current_setting('rp.sales_item')::uuid),4::numeric,'qty_sold is the gross sold quantity');
select is((select qty_returned from get_item_sales_report(current_setting('rp.shop')::uuid,'2026-09-19','2026-09-19') where item_id=current_setting('rp.sales_item')::uuid),1::numeric,'qty_returned reflects the posted return');
select is((select net_qty from get_item_sales_report(current_setting('rp.shop')::uuid,'2026-09-19','2026-09-19') where item_id=current_setting('rp.sales_item')::uuid),3::numeric,'net_qty is sold minus returned');
select is((select net_sales_paise from get_item_sales_report(current_setting('rp.shop')::uuid,'2026-09-19','2026-09-19') where item_id=current_setting('rp.sales_item')::uuid),300::bigint,'net_sales_paise is gross minus the returned line amount');

-- Purchase register: a bill stays visible, with its real status, after voiding.
select is((select count(*) from get_purchase_register(current_setting('rp.shop')::uuid,'2026-09-19','2026-09-19') where doc_no='RP-SEED'),1::bigint,'a posted bill appears in its business date');
select void_purchase((select id from purchase_bills where client_id='rp-seed'),'rp-seed-void');
select is((select status from get_purchase_register(current_setting('rp.shop')::uuid,'2026-09-19','2026-09-19') where doc_no='RP-SEED'),'VOID','a voided bill stays in the register instead of disappearing');

-- Customer aging: one invoice settled in full (must not appear at all,
-- since customer_invoice_outstanding excludes it), one left unpaid and
-- dated far enough in the past to land in the 31-60 day bucket.
insert into customers(tenant_id,name,client_id) values(current_tenant_id(),'Aging Customer','rp-customer');
select set_config('rp.customer',(select id::text from customers where client_id='rp-customer'),false);
select post_sale(current_setting('rp.shop')::uuid,current_setting('rp.customer')::uuid,'2026-08-10',0,0,'rp-aging-unpaid',jsonb_build_array(jsonb_build_object('item_id',current_setting('rp.sales_item'),'unit_level',1,'qty',2,'price_kind','retail')),'[]'::jsonb,null);
select post_sale(current_setting('rp.shop')::uuid,current_setting('rp.customer')::uuid,'2026-09-01',0,0,'rp-aging-paid',jsonb_build_array(jsonb_build_object('item_id',current_setting('rp.sales_item'),'unit_level',1,'qty',1,'price_kind','retail')),jsonb_build_array(jsonb_build_object('amount_paise',100,'mode','cash')),null);

select is((select days_31_60_paise from get_customer_aging_report(current_setting('rp.shop')::uuid,'2026-09-19') where customer_id=current_setting('rp.customer')::uuid),200::bigint,'a 40-day-old unpaid invoice lands in the 31-60 day bucket');
select is((select total_outstanding_paise from get_customer_aging_report(current_setting('rp.shop')::uuid,'2026-09-19') where customer_id=current_setting('rp.customer')::uuid),200::bigint,'the fully-paid invoice contributes nothing to the total');

-- Cashier is denied all four reports, same as every existing report RPC.
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id) values(current_setting('rp.tenant')::uuid,'b6540000-0000-0000-0000-000000000002','cashier',array[current_setting('rp.shop')::uuid],'active','rp-cashier');
select set_config('request.jwt.claims','{"sub":"b6540000-0000-0000-0000-000000000002","role":"authenticated"}',true);
select throws_ok($$select * from get_low_stock_report(current_setting('rp.shop')::uuid)$$,null,'not permitted','cashier cannot read low stock report');
select throws_ok($$select * from get_item_sales_report(current_setting('rp.shop')::uuid,'2026-09-19','2026-09-19')$$,null,'not permitted','cashier cannot read item sales report');
select throws_ok($$select * from get_purchase_register(current_setting('rp.shop')::uuid,'2026-09-19','2026-09-19')$$,null,'not permitted','cashier cannot read purchase register');
select throws_ok($$select * from get_customer_aging_report(current_setting('rp.shop')::uuid,'2026-09-19')$$,null,'not permitted','cashier cannot read customer aging report');

-- Cross-tenant shop is refused exactly like every other shop-scoped report.
reset role;
insert into tenants(id,name,slug,created_by) values('b6540000-0000-0000-0000-000000000099','Reports Other','reports-other','b6540000-0000-0000-0000-000000000001');
insert into shops(id,tenant_id,name,is_default,created_by) values('b6540000-0000-0000-0000-000000000098','b6540000-0000-0000-0000-000000000099','Other Tenant Shop',true,'b6540000-0000-0000-0000-000000000001');
set role authenticated;
select set_config('request.jwt.claims','{"sub":"b6540000-0000-0000-0000-000000000001","role":"authenticated"}',true);
select throws_ok($$select * from get_low_stock_report('b6540000-0000-0000-0000-000000000098'::uuid)$$,null,'shop not in tenant','owner of one tenant cannot read another tenant''s low stock report');

select * from finish();
rollback;
