begin;
create extension if not exists pgtap with schema extensions;
select plan(25);

insert into auth.users(id) values
 ('a8000000-0000-0000-0000-000000000001'),
 ('a8000000-0000-0000-0000-000000000002')
on conflict do nothing;

set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a8000000-0000-0000-0000-000000000001','role','authenticated')::text,true);
select lives_ok($$select create_tenant('Reconcile A','reconcile-a','A Shop','reconcile-a-tenant')$$,'create reconciliation tenant');
select set_config('rec.tenant',current_tenant_id()::text,false);
select set_config('rec.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);

select lives_ok($$insert into customers(tenant_id,name,client_id) values(current_tenant_id(),'Recon Customer','rec-customer')$$,'create customer');
select set_config('rec.customer',(select id::text from customers where client_id='rec-customer'),false);
select lives_ok($$insert into items(tenant_id,name,unit1,tax_rate_bp,client_id) values(current_tenant_id(),'Recon Item','Pcs',0,'rec-item')$$,'create sale item');
select set_config('rec.item',(select id::text from items where client_id='rec-item'),false);
select lives_ok(format($q$select set_item_price(%L::uuid,%L::uuid,'retail',1::smallint,100::bigint,'rec-price')$q$,current_setting('rec.item'),current_setting('rec.shop')),'set retail price');
select lives_ok(format($q$select post_purchase(%L::uuid,null,'REC-SEED','2026-09-08',0,0,'rec-seed',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',1,'qty',10,'unit_price_paise',50)),null)$q$,current_setting('rec.shop'),current_setting('rec.item')),'seed ten pieces');

select lives_ok(format($q$select post_sale(%L::uuid,null,'2026-09-08',0,0,'rec-sale-walkin',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',1,'qty',2,'price_kind','retail','discount_paise',0)),jsonb_build_array(jsonb_build_object('amount_paise',100,'mode','cash'),jsonb_build_object('amount_paise',100,'mode','upi')),null)$q$,current_setting('rec.shop'),current_setting('rec.item')),'post split-tender walk-in sale');

select lives_ok(format($q$select post_sale(%L::uuid,%L::uuid,'2026-09-08',0,0,'rec-sale-credit',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',1,'qty',1,'price_kind','retail','discount_paise',0)),jsonb_build_array(jsonb_build_object('amount_paise',50,'mode','cash')),null)$q$,current_setting('rec.shop'),current_setting('rec.customer'),current_setting('rec.item')),'post partly-paid customer sale');
select set_config('rec.credit_sale',(select id::text from sale_invoices where client_id='rec-sale-credit'),false);

select lives_ok(format($q$select record_customer_payment(%L::uuid,%L::uuid,'2026-09-08',30,'upi',null,jsonb_build_array(jsonb_build_object('sale_invoice_id',%L,'amount_paise',20)),'rec-standalone-pay')$q$,current_setting('rec.shop'),current_setting('rec.customer'),current_setting('rec.credit_sale')),'post standalone customer receipt with partial allocation');

select lives_ok(format($q$select post_sale(%L::uuid,null,'2026-09-08',0,0,'rec-sale-void',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',1,'qty',1,'price_kind','retail','discount_paise',0)),jsonb_build_array(jsonb_build_object('amount_paise',100,'mode','cash')),null)$q$,current_setting('rec.shop'),current_setting('rec.item')),'post sale that will be voided');
select set_config('rec.void_sale',(select id::text from sale_invoices where client_id='rec-sale-void'),false);
select lives_ok(format($q$select void_sale(%L::uuid,'rec-void')$q$,current_setting('rec.void_sale')),'void sale with reversing stock/payment effects');

select is((get_shop_day_reconciliation(current_setting('rec.shop')::uuid,'2026-09-08')->>'invoiceCount')::bigint,2::bigint,'report counts only finalized invoices');
select is((get_shop_day_reconciliation(current_setting('rec.shop')::uuid,'2026-09-08')->>'salesTotalPaise')::bigint,300::bigint,'report reconciles finalized sales total');
select is((get_shop_day_reconciliation(current_setting('rec.shop')::uuid,'2026-09-08')->>'voidCount')::bigint,1::bigint,'report counts voided invoices separately');
select is((get_shop_day_reconciliation(current_setting('rec.shop')::uuid,'2026-09-08')->>'voidedTotalPaise')::bigint,100::bigint,'report exposes voided total without netting it into sales');
select is((get_shop_day_reconciliation(current_setting('rec.shop')::uuid,'2026-09-08')->>'directSaleReceiptsPaise')::bigint,250::bigint,'report reconciles direct sale tenders');
select is((get_shop_day_reconciliation(current_setting('rec.shop')::uuid,'2026-09-08')->>'creditCreatedPaise')::bigint,50::bigint,'report exposes credit created at sale time');
select is((get_shop_day_reconciliation(current_setting('rec.shop')::uuid,'2026-09-08')->>'standaloneCustomerReceiptsPaise')::bigint,30::bigint,'report separates standalone customer receipts');
select is((get_shop_day_reconciliation(current_setting('rec.shop')::uuid,'2026-09-08')->>'standaloneAdvancePaise')::bigint,10::bigint,'report exposes unallocated advance portion');
select is((get_shop_day_reconciliation(current_setting('rec.shop')::uuid,'2026-09-08')->>'allCustomerReceiptsPaise')::bigint,280::bigint,'report totals all customer cash receipts');
select is((get_shop_day_reconciliation(current_setting('rec.shop')::uuid,'2026-09-08')->'paymentModes'->>'cash')::bigint,150::bigint,'cash mode excludes voided cash payment');
select is((get_shop_day_reconciliation(current_setting('rec.shop')::uuid,'2026-09-08')->'paymentModes'->>'upi')::bigint,130::bigint,'UPI mode includes sale and standalone receipt');
select is((get_shop_day_reconciliation(current_setting('rec.shop')::uuid,'2026-09-08')->>'currentCustomerOutstandingPaise')::bigint,20::bigint,'current customer outstanding reflects later collection');
select is((get_shop_day_reconciliation(current_setting('rec.shop')::uuid,'2026-09-08')->'soldItems'->0->>'soldQtySmallest')::numeric,3::numeric,'sold-item detail uses net finalized sale quantity');
select is((get_shop_day_reconciliation(current_setting('rec.shop')::uuid,'2026-09-08')->'soldItems'->0->>'currentStockSmallest')::numeric,7::numeric,'sold-item detail shows current stock after void reversal');

reset role;
insert into tenants(id,name,slug,created_by) values('a8000000-0000-0000-0000-000000000099','Other','reconcile-other','a8000000-0000-0000-0000-000000000002');
insert into shops(id,tenant_id,name,is_default,created_by) values('a8000000-0000-0000-0000-000000000098','a8000000-0000-0000-0000-000000000099','Other Shop',true,'a8000000-0000-0000-0000-000000000002');
set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a8000000-0000-0000-0000-000000000001','role','authenticated')::text,true);
select throws_ok($$select get_shop_day_reconciliation('a8000000-0000-0000-0000-000000000098','2026-09-08')$$,null,'shop not in tenant','cannot reconcile another tenant shop');

select * from finish();
rollback;
