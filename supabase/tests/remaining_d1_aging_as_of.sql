-- Packet D1-lite (mig 0052): as-of outstanding and aging, customers and suppliers (v1.1 §9.2, §9.4).
begin;
create extension if not exists pgtap with schema extensions;
select plan(31);
insert into auth.users(id) values ('d1d00000-0000-0000-0000-000000000001'),('d1d00000-0000-0000-0000-000000000004');
create function pg_temp.act(p_user text) returns void language sql as
 $$ select set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true) $$;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select current_setting('d1.'||p_key)::uuid $$;
set role authenticated;
select pg_temp.act('d1d00000-0000-0000-0000-000000000001');
select create_tenant('D1 Co','d1-co','D1 Shop','d1-tenant');
select register_device('d1-phone','d1-test');
select set_config('d1.tenant',current_tenant_id()::text,false);
select set_config('d1.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'D1 Item','piece','d1-item');
select set_config('d1.item',(select id::text from items where client_id='d1-item'),false);
insert into customers(tenant_id,name,client_id) values(current_tenant_id(),'D1 Customer','d1-cust');
select set_config('d1.cust',(select id::text from customers where client_id='d1-cust'),false);
insert into parties(tenant_id,name,client_id) values(current_tenant_id(),'D1 Supplier','d1-party');
select set_config('d1.party',(select id::text from parties where client_id='d1-party'),false);
select set_item_price(pg_temp.id('item'),pg_temp.id('shop'),'retail',1::smallint,5000::bigint,'d1-price');
-- Supplier bill B1 2026-09-01: 100 x 100 = 10000.
select set_config('d1.bill',post_purchase(pg_temp.id('shop'),pg_temp.id('party'),'D1-B1','2026-09-01',0,0,'d1-bill',
 jsonb_build_array(jsonb_build_object('item_id',current_setting('d1.item'),'unit_level',1,'qty',100,'unit_price_paise',100)),null)::text,false);

create function pg_temp.sale(p_client text,p_date date,p_qty int) returns uuid language plpgsql as $$
begin
 perform r0_sync_post_sale('d1-phone',1,pg_temp.id('shop'),pg_temp.id('cust'),p_date,0,0,p_client,
  jsonb_build_array(jsonb_build_object('item_id',current_setting('d1.item'),'unit_level',1,'qty',p_qty,'price_kind','retail','discount_paise',0,'expected_unit_price_paise',5000)),
  '[]'::jsonb,null);
 return (select id from sale_invoices where client_id=p_client);
end $$;
-- Customer sale S1 2026-09-01: 2 x 5000 = 10000 on credit. S2 2026-09-05: 5000, voided later.
select set_config('d1.s1',pg_temp.sale('d1-s1','2026-09-01',2)::text,false);
select set_config('d1.s2',pg_temp.sale('d1-s2','2026-09-05',1)::text,false);
select void_sale(pg_temp.id('s2'),'d1-s2-void');
-- Receipt P1 2026-09-01: 4000 advance, unallocated. Receipt P2 2026-09-05: 500, voided.
select set_config('d1.p1',record_customer_payment_v2(pg_temp.id('shop'),pg_temp.id('cust'),'2026-09-01',4000,'cash',null,'[]'::jsonb,'d1d00000-0000-0000-0000-0000000000a1')::text,false);
select set_config('d1.p2',record_customer_payment_v2(pg_temp.id('shop'),pg_temp.id('cust'),'2026-09-05',500,'cash',null,'[]'::jsonb,'d1d00000-0000-0000-0000-0000000000a2')::text,false);
select void_payment(pg_temp.id('p2'));
-- Supplier payment Q1 2026-09-01: 4000 advance.
select set_config('d1.q1',record_supplier_payment(pg_temp.id('shop'),pg_temp.id('party'),'2026-09-01',4000,'cash',null,'[]'::jsonb,'d1d00000-0000-0000-0000-0000000000b1')::text,false);

-- Later-dated allocations (the RPCs date them today; fixtures need fixed dates).
reset role;
insert into payment_allocations(tenant_id,payment_id,doc_type,sale_invoice_id,amount_paise,client_id,effective_date)
 values(pg_temp.id('tenant'),pg_temp.id('p1'),'SALE',pg_temp.id('s1'),3000,'d1-alloc-s1','2026-09-15');
insert into payment_allocations(tenant_id,payment_id,doc_type,purchase_bill_id,amount_paise,client_id,effective_date)
 values(pg_temp.id('tenant'),pg_temp.id('q1'),'PURCHASE',pg_temp.id('bill'),3000,'d1-alloc-b1','2026-09-15');
set role authenticated;
select pg_temp.act('d1d00000-0000-0000-0000-000000000001');
-- Return 1 of S1's 2 units on 2026-09-20 (5000); the 3000 already paid is refunded, linked to S1.
select post_return('SALE',pg_temp.id('s1'),'2026-09-20','d1-ret',jsonb_build_array(jsonb_build_object('sale_invoice_item_id',
 (select id from sale_invoice_items where sale_invoice_id=pg_temp.id('s1') limit 1),'qty',1,'disposition','RETURN_TO_SELLABLE')),'d1 return');

create function pg_temp.c(p_date date) returns jsonb language sql as
 $$ select get_customer_aging_report_v2(pg_temp.id('shop'),p_date)->'accounts'->0 $$;
create function pg_temp.s(p_date date) returns jsonb language sql as
 $$ select get_supplier_aging_report_v2(pg_temp.id('shop'),p_date)->'accounts'->0 $$;
create function pg_temp.bridge(a jsonb,p_customer boolean) returns boolean language sql as $$
 select (a->>'netLedgerBalancePaise')::numeric=coalesce((select sum((d->>'signedDuePaise')::numeric) from jsonb_array_elements(a->'details') d),0)
  + case when p_customer then -(a->>'unassignedInPaise')::numeric+(a->>'unassignedOutPaise')::numeric
         else -(a->>'unassignedOutPaise')::numeric+(a->>'unassignedInPaise')::numeric end $$;

-- Customer as of 2026-09-10: allocation not yet effective; bill due and advance kept separate.
select is(pg_temp.c('2026-09-10')->>'grossOpenPaise','10000','09-10: full invoice still due');
select is(pg_temp.c('2026-09-10')->>'unassignedInPaise','4000','09-10: advance shown separately');
select is(pg_temp.c('2026-09-10')->>'netLedgerBalancePaise','6000','09-10: net ledger balance');
select is(pg_temp.c('2026-09-10')->>'days1to30Paise','10000','09-10: 9-day-old invoice in 1-30 bucket');
select is(jsonb_array_length(pg_temp.c('2026-09-10')->'details'),1,'voided sale excluded (restated)');
select ok(pg_temp.bridge(pg_temp.c('2026-09-10'),true),'09-10 customer bridge holds');
-- As of 2026-09-15: allocation effective; net unchanged.
select is(pg_temp.c('2026-09-15')->>'grossOpenPaise','7000','09-15: allocation reduces invoice due');
select is(pg_temp.c('2026-09-15')->>'unassignedInPaise','1000','09-15: remaining advance');
select is(pg_temp.c('2026-09-15')->>'netLedgerBalancePaise','6000','09-15: net ledger balance unchanged');
-- Return dated 09-20 excluded before, included from 09-20.
select is(pg_temp.c('2026-09-19')->>'grossOpenPaise','7000','return after the report date excluded');
select is(pg_temp.c('2026-09-20')->>'grossOpenPaise','5000','return on the report date included (paid part refunded and linked)');
select is(pg_temp.c('2026-09-20')->>'netLedgerBalancePaise','4000','09-20 net ledger balance (linked refund counted once)');
select ok(pg_temp.bridge(pg_temp.c('2026-09-20'),true),'09-20 customer bridge holds');
select is(pg_temp.c('2026-08-31'),null,'before any document: no account rows');
select is(get_customer_aging_report_v2(pg_temp.id('shop'),'2026-09-20')->'totals'->>'grossOpenPaise','5000','totals sum accounts');
select is(get_customer_aging_report_v2(pg_temp.id('shop'),'2026-09-20')->>'historyCompleteness','VOIDS_RESTATED','history label present');
select is(pg_temp.c('2026-09-20')->>'legacyInferredAllocation','false','explicit allocations are not flagged legacy');

-- Supplier side mirrors.
select is(pg_temp.s('2026-09-10')->>'grossOpenPaise','10000','supplier 09-10: bill due');
select is(pg_temp.s('2026-09-10')->>'unassignedOutPaise','4000','supplier 09-10: advance separate');
select is(pg_temp.s('2026-09-10')->>'netLedgerBalancePaise','6000','supplier 09-10: net');
select is(pg_temp.s('2026-09-15')->>'grossOpenPaise','7000','supplier 09-15: allocation effective');
select is(pg_temp.s('2026-09-15')->>'netLedgerBalancePaise','6000','supplier 09-15: net unchanged');
select ok(pg_temp.bridge(pg_temp.s('2026-09-15'),false),'supplier bridge holds');

-- Same supplier, second shop: isolated.
reset role;
insert into shops(id,tenant_id,name,created_by) values('d1d00000-0000-0000-0000-000000000050',pg_temp.id('tenant'),'D1 Shop Two','d1d00000-0000-0000-0000-000000000001');
set role authenticated;
select pg_temp.act('d1d00000-0000-0000-0000-000000000001');
select post_purchase('d1d00000-0000-0000-0000-000000000050'::uuid,pg_temp.id('party'),'D1-B2','2026-09-02',0,0,'d1-bill2',
 jsonb_build_array(jsonb_build_object('item_id',current_setting('d1.item'),'unit_level',1,'qty',7,'unit_price_paise',100)),null);
select is(pg_temp.s('2026-09-15')->>'grossOpenPaise','7000','shop one unaffected by the second shop bill');
select is(get_supplier_aging_report_v2('d1d00000-0000-0000-0000-000000000050'::uuid,'2026-09-15')->'accounts'->0->>'grossOpenPaise','700','shop two sees only its bill');

-- Guards.
select throws_like($$select get_customer_aging_report_v2(pg_temp.id('shop'),null)$$,'DSB_INVALID_DATE%','null date rejected');
select throws_like($$select get_supplier_aging_report_v2(pg_temp.id('shop'),shop_business_date(pg_temp.id('shop'))+1)$$,'DSB_FUTURE_DATE%','future date rejected');
select throws_like($$select get_customer_aging_report_v2('d1d00000-0000-0000-0000-00000000ffff'::uuid,'2026-09-10')$$,'%','unknown shop rejected');

-- Legacy-inferred allocation carries the flag (fixture bypasses the date trigger).
reset role;
set local session_replication_role=replica;
update payment_allocations set effective_date_source='LEGACY_INFERRED' where client_id='d1-alloc-b1';
set local session_replication_role=origin;
set role authenticated;
select pg_temp.act('d1d00000-0000-0000-0000-000000000001');
select is(pg_temp.s('2026-09-15')->>'legacyInferredAllocation','true','legacy-inferred allocation flagged');

-- Private helpers are not callable by browser roles.
select ok(not has_function_privilege('authenticated','d1_aging_json(uuid,date,jsonb,jsonb)','execute'),'d1_aging_json revoked');
select ok(not has_function_privilege('authenticated','d1_assert_as_of(uuid,date)','execute'),'d1_assert_as_of revoked');

select * from finish();
rollback;
