-- Packet C0 (mig 0046): request ledger, allocation dates, shop finance lock wrappers.
begin;
create extension if not exists pgtap with schema extensions;
select plan(61);

insert into auth.users(id) values
 ('c0c00000-0000-0000-0000-000000000001'),
 ('c0c00000-0000-0000-0000-000000000002');

-- 1. financial_requests / shop_financial_history are closed to clients.
select ok((select relrowsecurity from pg_class where oid='public.financial_requests'::regclass),'financial_requests has RLS');
select ok((select relrowsecurity from pg_class where oid='public.shop_financial_history'::regclass),'shop_financial_history has RLS');
select ok(not has_table_privilege('authenticated','public.financial_requests','SELECT'),'authenticated cannot read financial_requests');
select ok(not has_table_privilege('authenticated','public.financial_requests','INSERT'),'authenticated cannot write financial_requests');
select ok(not has_table_privilege('anon','public.financial_requests','SELECT'),'anon cannot read financial_requests');
select ok(not has_table_privilege('authenticated','public.shop_financial_history','SELECT'),'authenticated cannot read shop_financial_history');

-- 2. Private helpers and renamed bodies are not client-executable; wrappers are.
select ok(not has_function_privilege('authenticated',f,'EXECUTE'),'authenticated cannot execute '||f)
 from unnest(array[
  'dsb_lock_shop_finance(uuid,uuid)','dsb_lock_request(uuid,text,text)','dsb_assert_safe_paise(bigint,boolean)',
  'dsb_normalize_allocations(jsonb,text)','dsb_request_result(uuid,uuid,text,text,jsonb)',
  'c0_post_sale_body(uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text)',
  'c0_record_customer_payment_body(uuid,uuid,date,bigint,text,text,jsonb,text)',
  'c0_post_purchase_body(uuid,uuid,text,date,bigint,bigint,text,jsonb,text)',
  'c0_post_return_body(text,uuid,date,text,jsonb,text)','c0_void_sale_body(uuid,text)',
  'c0_void_payment_body(uuid)','c0_void_purchase_body(uuid,text)','c0_void_return_body(text,uuid,text)']) f;
select ok(has_function_privilege('authenticated',f,'EXECUTE') and not has_function_privilege('anon',f,'EXECUTE')
          and (select prosrc from pg_proc where oid=f::regprocedure) like '%dsb_lock_shop_finance%',
          f||' is a client-callable wrapper that takes the shop finance lock')
 from unnest(array[
  'post_sale(uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text)','record_customer_payment(uuid,uuid,date,bigint,text,text,jsonb,text)',
  'post_purchase(uuid,uuid,text,date,bigint,bigint,text,jsonb,text)','post_return(text,uuid,date,text,jsonb,text)',
  'void_sale(uuid,text)','void_payment(uuid)','void_purchase(uuid,text)','void_return(text,uuid,text)']) f;

-- 3. Pure helpers.
select is(dsb_normalize_allocations(
  '[{"sale_invoice_id":"BBBBBBBB-0000-0000-0000-000000000002","amount_paise":5},{"sale_invoice_id":"aaaaaaaa-0000-0000-0000-000000000001","amount_paise":"70"}]','sale_invoice_id'),
  '[{"sale_invoice_id":"aaaaaaaa-0000-0000-0000-000000000001","amount_paise":"70"},{"sale_invoice_id":"bbbbbbbb-0000-0000-0000-000000000002","amount_paise":"5"}]'::jsonb,
  'allocations are sorted by target uuid, lower-cased, amounts as text');
select is(dsb_normalize_allocations(null,'sale_invoice_id'),'[]'::jsonb,'null allocations normalize to empty');
select throws_ok($$select dsb_normalize_allocations('[{"sale_invoice_id":"aaaaaaaa-0000-0000-0000-000000000001","amount_paise":1},{"sale_invoice_id":"AAAAAAAA-0000-0000-0000-000000000001","amount_paise":2}]','sale_invoice_id')$$,'duplicate allocation target','duplicate target rejected case-insensitively');
select throws_ok($$select dsb_normalize_allocations('[{"sale_invoice_id":"aaaaaaaa-0000-0000-0000-000000000001","amount_paise":0}]','sale_invoice_id')$$,'allocation amount out of range','zero amount rejected');
select throws_ok($$select dsb_normalize_allocations('[{"sale_invoice_id":"aaaaaaaa-0000-0000-0000-000000000001","amount_paise":1.5}]','sale_invoice_id')$$,'allocation amount must be a positive integer','fractional amount rejected');
select throws_ok($$select dsb_normalize_allocations('[{"sale_invoice_id":"aaaaaaaa-0000-0000-0000-000000000001","amount_paise":1,"extra":1}]','sale_invoice_id')$$,'unknown allocation field','unknown key rejected');
select throws_ok($$select dsb_normalize_allocations('[{"purchase_bill_id":"aaaaaaaa-0000-0000-0000-000000000001","amount_paise":1}]','sale_invoice_id')$$,'unknown allocation field','wrong target field rejected');
select throws_ok($$select dsb_normalize_allocations((select jsonb_agg(jsonb_build_object('sale_invoice_id',gen_random_uuid(),'amount_paise',1)) from generate_series(1,201)),'sale_invoice_id')$$,'too many allocations','more than 200 allocations rejected');
select throws_ok($$select dsb_assert_safe_paise(-1)$$,'amount must not be negative','negative amount rejected by default');
select lives_ok($$select dsb_assert_safe_paise(-1,true)$$,'negative amount allowed when signed');
select throws_ok($$select dsb_assert_safe_paise(9007199254740992)$$,'amount out of safe range','amount above MAX_SAFE_INTEGER rejected');

-- Fixture: tenant, two shops, customer, stocked item, one credit sale.
set role authenticated;
select set_config('request.jwt.claims','{"sub":"c0c00000-0000-0000-0000-000000000001","role":"authenticated"}',true);
select create_tenant('C0 Co','c0-co','C0 Shop','c0-tenant');
select set_config('c0.tenant',current_tenant_id()::text,false);
select set_config('c0.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
reset role;
insert into shops(id,tenant_id,name,created_by) values('c0c00000-0000-0000-0000-000000000050',current_setting('c0.tenant')::uuid,'C0 Shop Two','c0c00000-0000-0000-0000-000000000001');
set role authenticated;
select set_config('request.jwt.claims','{"sub":"c0c00000-0000-0000-0000-000000000001","role":"authenticated"}',true);
insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'C0 Item','piece','c0-item');
select set_config('c0.item',(select id::text from items where client_id='c0-item'),false);
insert into customers(tenant_id,name,client_id) values(current_tenant_id(),'C0 Customer','c0-cust');
select set_config('c0.cust',(select id::text from customers where client_id='c0-cust'),false);
select set_item_price(current_setting('c0.item')::uuid,s,'retail',1::smallint,100::bigint,'c0-price-'||s)
 from unnest(array[current_setting('c0.shop')::uuid,'c0c00000-0000-0000-0000-000000000050'::uuid]) s;
select post_purchase(s,null,'C0-SEED-'||s,'2026-09-01',0,0,'c0-seed-'||s,
 jsonb_build_array(jsonb_build_object('item_id',current_setting('c0.item'),'unit_level',1,'qty',100,'unit_price_paise',50)),null)
 from unnest(array[current_setting('c0.shop')::uuid,'c0c00000-0000-0000-0000-000000000050'::uuid]) s;
select post_sale(current_setting('c0.shop')::uuid,current_setting('c0.cust')::uuid,'2026-09-10',0,0,'c0-sale',
 jsonb_build_array(jsonb_build_object('item_id',current_setting('c0.item'),'unit_level',1,'qty',10,'price_kind','retail')),'[]'::jsonb,null);
select set_config('c0.sale',(select id::text from sale_invoices where client_id='c0-sale'),false);

-- 4. Allocation dates through the existing (now locked) customer payment path.
select record_customer_payment(current_setting('c0.shop')::uuid,current_setting('c0.cust')::uuid,'2026-09-12',300,'cash',null,
 jsonb_build_array(jsonb_build_object('sale_invoice_id',current_setting('c0.sale'),'amount_paise',300)),'c0-pay-later');
select record_customer_payment(current_setting('c0.shop')::uuid,current_setting('c0.cust')::uuid,'2026-09-08',200,'cash',null,
 jsonb_build_array(jsonb_build_object('sale_invoice_id',current_setting('c0.sale'),'amount_paise',200)),'c0-pay-earlier');
reset role;
select is((select pa.effective_date from payment_allocations pa join payments p on p.id=pa.payment_id where p.client_id='c0-pay-later'),
 '2026-09-12'::date,'payment after the sale: effective date is the payment date');
select is((select pa.effective_date from payment_allocations pa join payments p on p.id=pa.payment_id where p.client_id='c0-pay-earlier'),
 '2026-09-10'::date,'payment dated before the sale: effective date is the sale date');
select is((select pa.effective_date_source from payment_allocations pa join payments p on p.id=pa.payment_id where p.client_id='c0-pay-later'),
 'EXPLICIT','new allocations are EXPLICIT');
select throws_ok($$update payment_allocations set effective_date='2026-09-30'
  where payment_id=(select id from payments where client_id='c0-pay-later')$$,'payment allocation is immutable','effective date cannot be edited');
select throws_ok($$update payment_allocations set status='VOID',effective_date='2026-09-30'
  where payment_id=(select id from payments where client_id='c0-pay-later')$$,'payment allocation is immutable','void may not change the effective date');
select throws_ok(format($$insert into payment_allocations(tenant_id,payment_id,doc_type,sale_invoice_id,amount_paise,client_id,effective_date,created_by)
  values(%L,(select id from payments where client_id='c0-pay-later'),'SALE',%L,1,'c0-early-alloc','2026-09-01',%L)$$,
  current_setting('c0.tenant'),current_setting('c0.sale'),'c0c00000-0000-0000-0000-000000000001'),
  'allocation effective date precedes payment or document date','an effective date before payment/document date is rejected');

-- Shop mismatch: a payment in shop two cannot be allocated to a sale in shop one.
insert into payments(tenant_id,shop_id,kind,customer_id,business_date,amount_paise,mode,client_id,created_by)
 values(current_setting('c0.tenant')::uuid,'c0c00000-0000-0000-0000-000000000050','customer',current_setting('c0.cust')::uuid,'2026-09-12',50,'cash','c0-pay-shop2','c0c00000-0000-0000-0000-000000000001');
select throws_ok(format($$insert into payment_allocations(tenant_id,payment_id,doc_type,sale_invoice_id,amount_paise,client_id,created_by)
  values(%L,(select id from payments where client_id='c0-pay-shop2'),'SALE',%L,10,'c0-cross-shop','c0c00000-0000-0000-0000-000000000001')$$,
  current_setting('c0.tenant'),current_setting('c0.sale')),'payment and document shop mismatch','cross-shop allocation rejected');

set role authenticated;
select set_config('request.jwt.claims','{"sub":"c0c00000-0000-0000-0000-000000000001","role":"authenticated"}',true);
select void_payment((select id from payments where client_id='c0-pay-later'));
reset role;
select ok((select pa.voided_at is not null and pa.status='VOID' from payment_allocations pa join payments p on p.id=pa.payment_id where p.client_id='c0-pay-later'),
 'voiding the payment stamps voided_at on its allocation');
select is((select pa.effective_date from payment_allocations pa join payments p on p.id=pa.payment_id where p.client_id='c0-pay-later'),
 '2026-09-12'::date,'void keeps the effective date');

-- 5. Purchase void refuses active allocations.
insert into parties(tenant_id,name,client_id,created_by) values(current_setting('c0.tenant')::uuid,'C0 Supplier','c0-party','c0c00000-0000-0000-0000-000000000001');
set role authenticated;
select set_config('request.jwt.claims','{"sub":"c0c00000-0000-0000-0000-000000000001","role":"authenticated"}',true);
select post_purchase(current_setting('c0.shop')::uuid,(select id from parties where client_id='c0-party'),'C0-BILL','2026-09-11',0,0,'c0-bill',
 jsonb_build_array(jsonb_build_object('item_id',current_setting('c0.item'),'unit_level',1,'qty',5,'unit_price_paise',50)),null);
reset role;
insert into payments(tenant_id,shop_id,kind,party_id,business_date,amount_paise,mode,client_id,created_by,direction)
 values(current_setting('c0.tenant')::uuid,current_setting('c0.shop')::uuid,'party',(select id from parties where client_id='c0-party'),'2026-09-11',100,'cash','c0-party-pay','c0c00000-0000-0000-0000-000000000001','out');
insert into payment_allocations(tenant_id,payment_id,doc_type,purchase_bill_id,amount_paise,client_id,created_by)
 values(current_setting('c0.tenant')::uuid,(select id from payments where client_id='c0-party-pay'),'PURCHASE',(select id from purchase_bills where client_id='c0-bill'),100,'c0-party-alloc','c0c00000-0000-0000-0000-000000000001');
set role authenticated;
select set_config('request.jwt.claims','{"sub":"c0c00000-0000-0000-0000-000000000001","role":"authenticated"}',true);
select throws_ok($$select void_purchase((select id from purchase_bills where client_id='c0-bill'),'c0-bill-void')$$,
 'purchase has active allocations; void or release allocations first','purchase with an active allocation cannot be voided');
reset role;
-- A bill voided before C0 may still carry POSTED allocations; a retry of that committed void must
-- reach the body's exact-retry path, not the new refusal.
alter table purchase_bills disable trigger user;
update purchase_bills set status='VOID' where client_id='c0-bill';
alter table purchase_bills enable trigger user;
set role authenticated;
select set_config('request.jwt.claims','{"sub":"c0c00000-0000-0000-0000-000000000001","role":"authenticated"}',true);
select lives_ok($$select void_purchase((select id from purchase_bills where client_id='c0-bill'),'c0-bill-void')$$,
 'retrying the void of an already-VOID bill is not refused by the allocation check');
-- Unknown targets still fail in the body (wrappers only lock rows they can see in this tenant).
select throws_ok($$select void_return('SALE','c0c00000-0000-0000-0000-0000000000ff','x')$$,'sale return not found','void_return of an unknown id fails in the body');
select throws_ok($$select post_return('SALE','c0c00000-0000-0000-0000-0000000000ff',current_date,'x','[{"sale_invoice_item_id":"c0c00000-0000-0000-0000-0000000000fe","qty":1,"disposition":"DAMAGED"}]')$$,'sale unavailable for return','post_return against an unknown source fails in the body');
reset role;

-- 6. Request ledger lookup and exact-retry contract.
insert into financial_requests(tenant_id,shop_id,operation,request,result,client_id,created_by)
 values(current_setting('c0.tenant')::uuid,current_setting('c0.shop')::uuid,'record_customer_payment_v2',
  '{"amount_paise":"200"}',jsonb_build_object('paymentId',(select id from payments where client_id='c0-pay-earlier')),'c0-req-1','c0c00000-0000-0000-0000-000000000001');
select is(dsb_request_result(current_setting('c0.tenant')::uuid,current_setting('c0.shop')::uuid,'record_customer_payment_v2','c0-req-1','{"amount_paise":"200"}'),
 jsonb_build_object('paymentId',(select id from payments where client_id='c0-pay-earlier')),'exact retry returns the stored result');
select is(dsb_request_result(current_setting('c0.tenant')::uuid,current_setting('c0.shop')::uuid,'record_customer_payment_v2','c0-req-missing','{}'),
 null,'unknown request returns null');
select throws_ok(format($$select dsb_request_result(%L,%L,'record_customer_payment_v2','c0-req-1','{"amount_paise":"201"}')$$,
 current_setting('c0.tenant'),current_setting('c0.shop')),'DSB_PAYLOAD_MISMATCH: client_id already used for a different request','changed payload under the same key is rejected');
select throws_ok($$update financial_requests set result='{}' where client_id='c0-req-1'$$,'financial request is immutable','financial requests cannot be updated');
select throws_ok($$insert into financial_requests(tenant_id,shop_id,operation,request,result,client_id,created_by)
  values(current_setting('c0.tenant')::uuid,current_setting('c0.shop')::uuid,'made_up_op','{}','{}','x','c0c00000-0000-0000-0000-000000000001')$$,
 '23514',null,'operation outside the allowlist rejected');

set role authenticated;
select set_config('request.jwt.claims','{"sub":"c0c00000-0000-0000-0000-000000000001","role":"authenticated"}',true);
select is(get_financial_request(current_setting('c0.shop')::uuid,'record_customer_payment_v2','c0-req-1'),
 jsonb_build_object('state','COMMITTED','result',jsonb_build_object('paymentId',(select id from payments where client_id='c0-pay-earlier')),'currentStatus','POSTED'),
 'owner sees the committed result and current payment status, not the request payload');
select is(get_financial_request(current_setting('c0.shop')::uuid,'record_customer_payment_v2','c0-req-other'),
 '{"state":"NOT_FOUND"}'::jsonb,'unknown key is NOT_FOUND');
select is(get_financial_request('c0c00000-0000-0000-0000-000000000050'::uuid,'record_customer_payment_v2','c0-req-1'),
 '{"state":"NOT_FOUND"}'::jsonb,'a key committed in another shop is NOT_FOUND from this shop');
select throws_ok($$select get_financial_request(current_setting('c0.shop')::uuid,'made_up_op','x')$$,'unknown financial operation','unknown operation rejected');

reset role;
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id)
 values(current_setting('c0.tenant')::uuid,'c0c00000-0000-0000-0000-000000000002','cashier',array[current_setting('c0.shop')::uuid],'active','c0-cashier');
set role authenticated;
select set_config('request.jwt.claims','{"sub":"c0c00000-0000-0000-0000-000000000002","role":"authenticated"}',true);
select throws_ok($$select get_financial_request(current_setting('c0.shop')::uuid,'supplier.record.v1','x')$$,'not permitted','cashier cannot look up supplier payment requests');

select * from finish();
rollback;
