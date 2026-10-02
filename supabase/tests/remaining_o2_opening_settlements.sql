-- Packet O2 (mig 0055): settle payments against opening balances.
begin;
create extension if not exists pgtap with schema extensions;
select plan(35);
insert into auth.users(id) values
 ('02000000-0000-0000-0000-000000000001'),  -- owner
 ('02000000-0000-0000-0000-000000000002');  -- manager
create function pg_temp.act(p_user text) returns void language sql as
 $$ select set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true) $$;
create function pg_temp.d(p_back int) returns date language sql as $$ select current_setting('o2.d')::date-p_back $$;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select current_setting('o2.'||p_key)::uuid $$;
set role authenticated;
select pg_temp.act('02000000-0000-0000-0000-000000000001');
select create_tenant('O2 Co','o2-co','O2 Shop','o2-tenant');
select set_config('o2.tenant',current_tenant_id()::text,false);
select set_config('o2.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into customers(tenant_id,name,client_id) values(current_tenant_id(),'Cust A','o2-cust'),(current_tenant_id(),'Cust B','o2-custb');
select set_config('o2.cust',(select id::text from customers where client_id='o2-cust'),false);
select set_config('o2.custb',(select id::text from customers where client_id='o2-custb'),false);
insert into parties(tenant_id,name,client_id) values(current_tenant_id(),'Supp A','o2-party');
select set_config('o2.party',(select id::text from parties where client_id='o2-party'),false);
insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'O2 Item','piece','o2-item');
select set_config('o2.item',(select id::text from items where client_id='o2-item'),false);
select set_config('o2.d',shop_business_date(current_setting('o2.shop')::uuid)::text,false);
reset role;
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id) values
 (pg_temp.id('tenant'),'02000000-0000-0000-0000-000000000002','manager',array[pg_temp.id('shop')],'active','o2-mgr');
set role authenticated;
select pg_temp.act('02000000-0000-0000-0000-000000000001');

-- Customer A owes 50.00 from d-3; pays 30.00 on d-1 and 40.00 today (d).
select set_config('o2.copen',record_account_opening(pg_temp.id('shop'),'CUSTOMER',pg_temp.id('cust'),pg_temp.d(3),5000,'cutover','o2-c1')::text,false);
select set_config('o2.r1',record_customer_payment_v2(pg_temp.id('shop'),pg_temp.id('cust'),pg_temp.d(1),3000,'cash',null,'[]'::jsonb,'02000000-0000-0000-0000-0000000000a1')::text,false);
select set_config('o2.r2',record_customer_payment_v2(pg_temp.id('shop'),pg_temp.id('cust'),pg_temp.d(0),4000,'cash',null,'[]'::jsonb,'02000000-0000-0000-0000-0000000000a2')::text,false);
select set_config('o2.rb',record_customer_payment_v2(pg_temp.id('shop'),pg_temp.id('custb'),pg_temp.d(1),1000,'cash',null,'[]'::jsonb,'02000000-0000-0000-0000-0000000000a3')::text,false);

select lives_ok($$select set_config('o2.s1',settle_opening(pg_temp.id('copen'),pg_temp.id('r1'),3000,'o2-s1')::text,false)$$,'owner settles a receipt against the opening');
select is(settle_opening(pg_temp.id('copen'),pg_temp.id('r1'),3000,'o2-s1'),pg_temp.id('s1'),'exact replay returns the same settlement');
select throws_like($$select settle_opening(pg_temp.id('copen'),pg_temp.id('r1'),2000,'o2-s1')$$,'DSB_PAYLOAD_MISMATCH%','same client id, different amount refused');
select throws_like($$select settle_opening(pg_temp.id('copen'),pg_temp.id('r1'),1,'o2-s2')$$,'DSB_ALLOCATION_EXCEEDS_PAYMENT%','a fully settled receipt cannot be settled again');
select throws_like($$select settle_opening(pg_temp.id('copen'),pg_temp.id('r2'),2001,'o2-s3')$$,'DSB_SETTLEMENT_EXCEEDS_OPENING%','cannot settle more than remains of the opening');
select throws_like($$select settle_opening(pg_temp.id('copen'),pg_temp.id('rb'),100,'o2-s4')$$,'DSB_PAYMENT_MISMATCH%','another customer''s receipt refused');
select throws_like($$select settle_opening(pg_temp.id('copen'),pg_temp.id('r2'),0,'o2-s5')$$,'DSB_INVALID_AMOUNT%','zero refused');
select lives_ok($$select set_config('o2.s2',settle_opening(pg_temp.id('copen'),pg_temp.id('r2'),2000,'o2-s6')::text,false)$$,'second receipt settles the rest');

-- Reports: opening fully settled; 20.00 of r2 stays unassigned; net unchanged (-20.00).
select is(get_customer_aging_report_v2(pg_temp.id('shop'),pg_temp.d(0))->'accounts'->0->>'netLedgerBalancePaise','-2000','net balance unchanged by settlements');
select is(get_customer_aging_report_v2(pg_temp.id('shop'),pg_temp.d(0))->'accounts'->0->>'unassignedInPaise','2000','only the unsettled part is unassigned');
select is(get_customer_aging_report_v2(pg_temp.id('shop'),pg_temp.d(0))->'accounts'->0->>'grossOpenPaise','0','opening no longer open');
select is(get_customer_aging_report_v2(pg_temp.id('shop'),pg_temp.d(1))->'accounts'->0->>'grossOpenPaise','5000','settlements are dated today: yesterday''s report is unchanged');
select is(get_customer_aging_report_v2(pg_temp.id('shop'),pg_temp.d(1))->'accounts'->0->>'unassignedInPaise','3000','yesterday the first receipt was still unassigned');
select is((select effective_date from opening_settlements where id=pg_temp.id('s1')),pg_temp.d(0),'settlement of an older receipt is dated the day it is recorded');
select is((select balance_paise from customer_balances where customer_id=pg_temp.id('cust')),-2000::bigint,'customer balance unchanged');

-- Voids: an opening with settlements cannot be voided; a settlement can; a voided receipt releases its settlement.
select throws_like($$select void_account_opening(pg_temp.id('copen'),'wrong')$$,'DSB_OPENING_SETTLED%','settled opening cannot be voided');
select lives_ok($$select void_opening_settlement(pg_temp.id('s2'),'wrong receipt')$$,'owner voids a settlement');
select is((select status||':'||void_reason from opening_settlements where id=pg_temp.id('s2')),'VOID:wrong receipt','settlement voided with reason');
select is(get_customer_aging_report_v2(pg_temp.id('shop'),pg_temp.d(0))->'accounts'->0->>'grossOpenPaise','2000','voided settlement reopens the opening');
select throws_like($$select settle_opening(pg_temp.id('copen'),pg_temp.id('r2'),2000,'o2-s6')$$,'DSB_SETTLEMENT_VOIDED%','replay of a voided settlement is not reported as settled');
select is(check_invariants()->>'ok','true','invariants hold with settlements');
select lives_ok($$select void_payment(pg_temp.id('r1'))$$,'owner voids the first receipt');
select is((select status||':'||void_reason from opening_settlements where id=pg_temp.id('s1')),'VOID:Payment voided','voided receipt voids its settlement');
select is(get_customer_aging_report_v2(pg_temp.id('shop'),pg_temp.d(0))->'accounts'->0->>'grossOpenPaise','5000','opening fully open again');
select lives_ok($$select void_account_opening(pg_temp.id('copen'),'no longer settled')$$,'opening without settlements can be voided');

-- Immutability and access.
reset role;
select throws_like($$update opening_settlements set amount_paise=1 where id=pg_temp.id('s2')$$,'%immutable%','settlement rows are immutable');
select throws_like($$delete from opening_settlements where id=pg_temp.id('s2')$$,'%immutable%','settlement rows cannot be deleted');
set role authenticated;
select pg_temp.act('02000000-0000-0000-0000-000000000002');
select throws_like($$select settle_opening(pg_temp.id('copen'),pg_temp.id('r2'),100,'o2-m1')$$,'not permitted','manager cannot settle');
select is((select count(*) from opening_settlements),2::bigint,'manager can read settlements');
select throws_like($$insert into opening_settlements(tenant_id,shop_id,account_kind,opening_id,payment_id,amount_paise,effective_date,client_id)
  values(pg_temp.id('tenant'),pg_temp.id('shop'),'CUSTOMER',pg_temp.id('copen'),pg_temp.id('r2'),1,pg_temp.d(0),'x')$$,'%permission denied%','no client insert');

-- Supplier: a payment settled to an opening cannot also be allocated to a bill beyond its amount.
select pg_temp.act('02000000-0000-0000-0000-000000000001');
select set_config('o2.sopen',record_account_opening(pg_temp.id('shop'),'SUPPLIER',pg_temp.id('party'),pg_temp.d(3),8000,'cutover','o2-p1')::text,false);
select set_config('o2.bill',post_purchase(pg_temp.id('shop'),pg_temp.id('party'),'B1',pg_temp.d(1),0,0,'o2-bill',
  jsonb_build_array(jsonb_build_object('item_id',pg_temp.id('item'),'unit_level',1,'qty',10,'unit_price_paise',100)),null)::text,false);
select set_config('o2.pay',record_supplier_payment(pg_temp.id('shop'),pg_temp.id('party'),pg_temp.d(0),5000,'cash',null,'[]'::jsonb,'02000000-0000-0000-0000-0000000000b1')::text,false);
select lives_ok($$select settle_opening(pg_temp.id('sopen'),pg_temp.id('pay'),4500,'o2-ps1')$$,'supplier payment settled to the supplier opening');
select throws_like($$select allocate_supplier_payment(pg_temp.id('pay'),jsonb_build_array(jsonb_build_object('purchase_bill_id',pg_temp.id('bill'),'amount_paise',1000)),'02000000-0000-0000-0000-0000000000b2')$$,
  'DSB_ALLOCATION_EXCEEDS_PAYMENT%','bill allocation cannot reuse the settled part');
select is(get_supplier_outstanding(pg_temp.id('shop'))->'parties'->0->>'remainingPositiveOpenings','3500','supplier opening remaining after settlement');

select is(check_invariants()->>'settlementViolations','0','no settlement violations');
-- A settlement that bypassed the checks (e.g. a restore with triggers off) is caught by the invariants.
reset role;
insert into opening_settlements(tenant_id,shop_id,account_kind,opening_id,payment_id,amount_paise,effective_date,client_id)
 values(pg_temp.id('tenant'),pg_temp.id('shop'),'SUPPLIER',pg_temp.id('sopen'),pg_temp.id('pay'),4000,pg_temp.d(0),'o2-bad');
set role authenticated;
select pg_temp.act('02000000-0000-0000-0000-000000000001');
select is((check_invariants()->>'allocationViolations')||':'||(check_invariants()->>'settlementViolations'),'1:2','over-assigned payment and both settlements on the overdrawn opening are reported');
select * from finish();
rollback;
