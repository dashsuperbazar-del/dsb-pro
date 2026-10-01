-- Packet C3 (mig 0049): customer payments on the request ledger; old endpoint compatibility.
begin;
create extension if not exists pgtap with schema extensions;
select plan(34);

insert into auth.users(id) values ('c3c00000-0000-0000-0000-000000000001');
set role authenticated;
select set_config('request.jwt.claims','{"sub":"c3c00000-0000-0000-0000-000000000001","role":"authenticated"}',true);
select create_tenant('C3 Co','c3-co','C3 Shop','c3-tenant');
select set_config('c3.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'C3 Item','piece','c3-item');
select set_config('c3.item',(select id::text from items where client_id='c3-item'),false);
insert into customers(tenant_id,name,client_id) values(current_tenant_id(),'C3 A','c3-a'),(current_tenant_id(),'C3 B','c3-b');
select set_item_price(current_setting('c3.item')::uuid,current_setting('c3.shop')::uuid,'retail',1::smallint,100::bigint,'c3-price');
select post_purchase(current_setting('c3.shop')::uuid,null,'C3-SEED','2026-09-01',0,0,'c3-seed',
 jsonb_build_array(jsonb_build_object('item_id',current_setting('c3.item'),'unit_level',1,'qty',100,'unit_price_paise',50)),null);
create function pg_temp.sale(p_key text,p_cust text,p_date date,p_qty int) returns void language sql as $$
 select set_config('c3.'||p_key,post_sale(current_setting('c3.shop')::uuid,(select id from customers where client_id=p_cust),p_date,0,0,'c3-'||p_key,
  jsonb_build_array(jsonb_build_object('item_id',current_setting('c3.item'),'unit_level',1,'qty',p_qty,'price_kind','retail')),'[]'::jsonb,null)::text,false) $$;
select pg_temp.sale('s1','c3-a','2026-09-10',10);  -- 1000
select pg_temp.sale('s2','c3-a','2026-09-11',5);   -- 500
select pg_temp.sale('sb','c3-b','2026-09-11',5);   -- other customer
select pg_temp.sale('sf','c3-a','2026-09-25',2);   -- after the payment date
create function pg_temp.id(k text) returns uuid language sql as $$ select current_setting('c3.'||k)::uuid $$;
create function pg_temp.a(k text,amt bigint) returns jsonb language sql as $$ select jsonb_build_object('sale_invoice_id',pg_temp.id(k),'amount_paise',amt) $$;
create function pg_temp.v2(req text,amt bigint,allocs jsonb,cust text default 'c3-a') returns uuid language sql as $$
 select record_customer_payment_v2(pg_temp.id('shop'),(select id from customers where client_id=cust),'2026-09-20',amt,'cash',null,allocs,req) $$;
create function pg_temp.out(k text) returns bigint language sql as $$
 select coalesce((select outstanding_paise from customer_invoice_outstanding where sale_invoice_id=pg_temp.id(k)),0) $$;

-- v2 record: partial + advance, replay, payload mismatch, request id format.
select lives_ok($$select pg_temp.v2('33333333-0000-0000-0000-000000000001',600,jsonb_build_array(pg_temp.a('s1',400)))$$,'v2 records a receipt with an allocation and an advance');
select is(pg_temp.out('s1'),600::bigint,'v2 allocation reduces the invoice outstanding');
select is(pg_temp.v2('33333333-0000-0000-0000-000000000001',600,jsonb_build_array(pg_temp.a('s1',400))),
 (select id from payments where client_id='record_customer_payment_v2:33333333-0000-0000-0000-000000000001'),'v2 exact replay returns the same receipt');
select throws_like($$select pg_temp.v2('33333333-0000-0000-0000-000000000001',601,jsonb_build_array(pg_temp.a('s1',400)))$$,'DSB_PAYLOAD_MISMATCH%','v2 changed payload under the same id is rejected');
select throws_like($$select pg_temp.v2('not-a-uuid',100,'[]')$$,'DSB_INVALID_REQUEST_ID%','v2 requires a request UUID');
select is((select count(*) from payments where client_id like 'record_customer_payment_v2:%'),1::bigint,'replays never create a second receipt');
-- v2 validation.
select throws_like($$select pg_temp.v2('33333333-0000-0000-0000-000000000002',5000,jsonb_build_array(pg_temp.a('s1',700)))$$,'allocation exceeds invoice balance%','v2 rejects allocation above the invoice outstanding');
select throws_like($$select pg_temp.v2('33333333-0000-0000-0000-000000000003',100,jsonb_build_array(pg_temp.a('s2',200)))$$,'DSB_ALLOCATION_EXCEEDS_PAYMENT%','v2 rejects allocations above the payment');
select throws_like($$select pg_temp.v2('33333333-0000-0000-0000-000000000004',100,jsonb_build_array(pg_temp.a('sb',100)))$$,'DSB_INVOICE_MISMATCH%','v2 rejects another customer''s invoice');
select throws_like($$select pg_temp.v2('33333333-0000-0000-0000-000000000005',100,jsonb_build_array(pg_temp.a('sf',100)))$$,'DSB_FUTURE_INVOICE%','v2 rejects a sale dated after the payment');
select throws_like($$select pg_temp.v2('33333333-0000-0000-0000-000000000006',100,null)$$,'DSB_INVALID_ALLOCATIONS%','v2 requires [] for an advance');
select throws_like($$select pg_temp.v2('33333333-0000-0000-0000-000000000007',0,'[]')$$,'DSB_INVALID_AMOUNT%','v2 rejects a zero amount');
-- v2 allocate the advance later.
select set_config('c3.p1',(select id::text from payments where client_id='record_customer_payment_v2:33333333-0000-0000-0000-000000000001'),false);
select lives_ok($$select allocate_customer_payment_v2(pg_temp.id('p1'),jsonb_build_array(pg_temp.a('s2',200)),'33333333-0000-0000-0000-000000000010')$$,'v2 allocates part of the advance later');
select is((select effective_date from payment_allocations where client_id like 'allocate_customer_payment_v2:33333333-0000-0000-0000-000000000010:%'),
 shop_business_date(pg_temp.id('shop')),'later allocation is effective today');
select throws_like($$select allocate_customer_payment_v2(pg_temp.id('p1'),jsonb_build_array(pg_temp.a('s2',1)),'33333333-0000-0000-0000-000000000011')$$,'DSB_ALLOCATION_EXCEEDS_PAYMENT%','v2 allocate cannot exceed the receipt');
select is(allocate_customer_payment_v2(pg_temp.id('p1'),jsonb_build_array(pg_temp.a('s2',200)),'33333333-0000-0000-0000-000000000010')->>'paymentId',
 pg_temp.id('p1')::text,'v2 allocate exact replay returns the stored result');
select is((get_financial_request(pg_temp.id('shop'),'record_customer_payment_v2','33333333-0000-0000-0000-000000000001')->>'state'),'COMMITTED','v2 request is reconcilable by id');

-- Old endpoint: new calls are recorded and replay-safe; golden allocation ids kept.
select lives_ok($$select record_customer_payment(pg_temp.id('shop'),(select id from customers where client_id='c3-a'),'2026-09-20',100,'upi','legacy',
 jsonb_build_array(pg_temp.a('s1',100)),'legacy-new-1')$$,'old endpoint still records a receipt');
select is((select client_id from payment_allocations where payment_id=(select id from payments where client_id='legacy-new-1')),'legacy-new-1:alloc:1','old endpoint keeps <client_id>:alloc:<n> allocation ids');
select is((get_financial_request(pg_temp.id('shop'),'customer.record.legacy-v1','legacy-new-1')->>'state'),'COMMITTED','old endpoint call is on the request ledger');
select is(record_customer_payment(pg_temp.id('shop'),(select id from customers where client_id='c3-a'),'2026-09-20',100,'upi','legacy',
 jsonb_build_array(pg_temp.a('s1',100)),'legacy-new-1'),(select id from payments where client_id='legacy-new-1'),'old endpoint exact retry returns the same receipt');
select throws_like($$select record_customer_payment(pg_temp.id('shop'),(select id from customers where client_id='c3-a'),'2026-09-20',101,'upi','legacy',
 jsonb_build_array(pg_temp.a('s1',100)),'legacy-new-1')$$,'DSB_PAYLOAD_MISMATCH%','old endpoint retry with a changed amount is rejected');
select lives_ok($$select record_customer_payment(pg_temp.id('shop'),(select id from customers where client_id='c3-a'),null,10,'cash',null,
 jsonb_build_array(pg_temp.a('sf',10)),'legacy-new-2')$$,'old endpoint keeps accepting a sale dated after the payment (C0 date floor applies)');

-- Pre-migration receipt (no request row): verified field by field, never duplicated.
reset role;
insert into payments(tenant_id,shop_id,kind,customer_id,business_date,amount_paise,mode,reference,status,client_id)
select tenant_id,pg_temp.id('shop'),'customer',(select id from customers where client_id='c3-a'),'2026-09-15',50,'cash','old',
 'POSTED','legacy-old-1' from shops where id=pg_temp.id('shop');
insert into payment_allocations(tenant_id,payment_id,doc_type,sale_invoice_id,amount_paise,client_id)
select tenant_id,id,'SALE',pg_temp.id('s1'),50,'legacy-old-1:alloc:1' from payments where client_id='legacy-old-1';
set role authenticated;
select set_config('request.jwt.claims','{"sub":"c3c00000-0000-0000-0000-000000000001","role":"authenticated"}',true);
select is(record_customer_payment(pg_temp.id('shop'),(select id from customers where client_id='c3-a'),'2026-09-15',50,'cash','old',
 jsonb_build_array(pg_temp.a('s1',50)),'legacy-old-1'),(select id from payments where client_id='legacy-old-1'),'matching retry of a pre-migration receipt returns it');
select is(record_customer_payment(pg_temp.id('shop'),(select id from customers where client_id='c3-a'),null,50,'cash','old',
 jsonb_build_array(pg_temp.a('s1',50)),'legacy-old-1'),(select id from payments where client_id='legacy-old-1'),'a retry without a date still matches');
select throws_like($$select record_customer_payment(pg_temp.id('shop'),(select id from customers where client_id='c3-a'),'2026-09-15',51,'cash','old',
 jsonb_build_array(pg_temp.a('s1',50)),'legacy-old-1')$$,'DSB_LEGACY_REQUEST_UNVERIFIABLE%','a different amount is unverifiable, not a new receipt');
select throws_like($$select record_customer_payment(pg_temp.id('shop'),(select id from customers where client_id='c3-a'),'2026-09-15',50,'cash','old',
 jsonb_build_array(pg_temp.a('s2',50)),'legacy-old-1')$$,'DSB_LEGACY_REQUEST_UNVERIFIABLE%','a different allocation is unverifiable');
select throws_like($$select record_customer_payment(pg_temp.id('shop'),(select id from customers where client_id='c3-b'),'2026-09-15',50,'cash','old',
 '[]','legacy-old-1')$$,'DSB_LEGACY_REQUEST_UNVERIFIABLE%','a different customer is unverifiable');
select is((select count(*) from payments where client_id='legacy-old-1'),1::bigint,'the pre-migration receipt is never duplicated');
select is((get_financial_request(pg_temp.id('shop'),'customer.record.legacy-v1','legacy-old-1')->>'state'),'NOT_FOUND','a verified historical receipt does not invent a request record');
-- Review MAJOR 1/2: retries of recorded receipts never fail on today's stricter input rules,
-- and allocations added to the receipt later do not make the original call unverifiable.
reset role;
insert into payments(tenant_id,shop_id,kind,customer_id,business_date,amount_paise,mode,status,client_id)
select tenant_id,pg_temp.id('shop'),'customer',(select id from customers where client_id='c3-a'),'2026-09-15',30,'cash','POSTED',repeat('x',129)
 from shops where id=pg_temp.id('shop');
insert into payment_allocations(tenant_id,payment_id,doc_type,sale_invoice_id,amount_paise,client_id)
select tenant_id,id,'SALE',pg_temp.id('s2'),10,repeat('x',129)||':alloc:'||n from payments, generate_series(1,2) n where client_id=repeat('x',129);
set role authenticated;
select set_config('request.jwt.claims','{"sub":"c3c00000-0000-0000-0000-000000000001","role":"authenticated"}',true);
select is(record_customer_payment(pg_temp.id('shop'),(select id from customers where client_id='c3-a'),'2026-09-15',30,'cash',null,
 jsonb_build_array(pg_temp.a('s2',10),pg_temp.a('s2',10)),repeat('x',129)),(select id from payments where client_id=repeat('x',129)),
 'retry of a recorded receipt with a long client_id and duplicate targets returns it');
reset role;
insert into payment_allocations(tenant_id,payment_id,doc_type,sale_invoice_id,amount_paise,client_id)
select tenant_id,id,'SALE',pg_temp.id('s2'),5,'later-added' from payments where client_id=repeat('x',129);
set role authenticated;
select set_config('request.jwt.claims','{"sub":"c3c00000-0000-0000-0000-000000000001","role":"authenticated"}',true);
select is(record_customer_payment(pg_temp.id('shop'),(select id from customers where client_id='c3-a'),'2026-09-15',30,'cash',null,
 jsonb_build_array(pg_temp.a('s2',10),pg_temp.a('s2',10)),repeat('x',129)),(select id from payments where client_id=repeat('x',129)),
 'a later allocation on the receipt does not make the original retry unverifiable');
select is((select count(*) from payments where client_id in (repeat('x',129),'legacy-old-1')),2::bigint,'still exactly one receipt each');
select is((check_invariants()->>'ok')::boolean,true,'invariants hold after C3 receipts');

select * from finish();
rollback;
