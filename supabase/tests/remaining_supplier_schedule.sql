-- Packet supplierschedule (mig 0061): supplier payment schedule = a reminder checklist. It never records money.
-- Due is derived from the immutable payments ledger (no posted payment to that supplier this month).
begin;
create extension if not exists pgtap with schema extensions;
select plan(32);
insert into auth.users(id) values
 ('b1000000-0000-0000-0000-000000000001'),  -- owner
 ('b1000000-0000-0000-0000-000000000002'),  -- manager
 ('b1000000-0000-0000-0000-000000000003'),  -- cashier
 ('b1000000-0000-0000-0000-000000000004');  -- other tenant owner
create function pg_temp.act(p_user text) returns void language sql as
 $$ select set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true) $$;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select current_setting('b1.'||p_key)::uuid $$;
create function pg_temp.due_ids(p_on date) returns text language sql as $$
 select coalesce(string_agg(party_name,',' order by party_name),'-') from get_supplier_payments_due(pg_temp.id('shop'),p_on) $$;
set role authenticated;
select pg_temp.act('b1000000-0000-0000-0000-000000000001');
select create_tenant('B1 Co','b1-co','B1 Shop','b1-tenant');
select set_config('b1.tenant',current_tenant_id()::text,false);
select set_config('b1.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into parties(tenant_id,name,client_id) values
 (current_tenant_id(),'Alpha','b1-p-a'),(current_tenant_id(),'Beta','b1-p-b'),
 (current_tenant_id(),'Gamma','b1-p-c'),(current_tenant_id(),'Delta','b1-p-d');
select set_config('b1.pa',(select id::text from parties where client_id='b1-p-a'),false);
select set_config('b1.pb',(select id::text from parties where client_id='b1-p-b'),false);
select set_config('b1.pc',(select id::text from parties where client_id='b1-p-c'),false);
select set_config('b1.pd',(select id::text from parties where client_id='b1-p-d'),false);
reset role;
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id) values
 (pg_temp.id('tenant'),'b1000000-0000-0000-0000-000000000002','manager',array[pg_temp.id('shop')],'active','b1-mgr'),
 (pg_temp.id('tenant'),'b1000000-0000-0000-0000-000000000003','cashier',array[pg_temp.id('shop')],'active','b1-cash');
set role authenticated;
select pg_temp.act('b1000000-0000-0000-0000-000000000004');
select create_tenant('B1 Other','b1-other','B1 Other Shop','b1-other-tenant');
select set_config('b1.other_shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
select pg_temp.act('b1000000-0000-0000-0000-000000000001');

-- table hygiene
select ok((select relrowsecurity from pg_class where relname='supplier_payment_schedules'),'RLS is on');
select ok(not has_table_privilege('authenticated','supplier_payment_schedules','insert')
      and not has_table_privilege('authenticated','supplier_payment_schedules','update')
      and not has_table_privilege('authenticated','supplier_payment_schedules','delete'),'clients cannot write the table directly');

-- create + idempotent update
select set_config('b1.s_a',set_supplier_payment_schedule(pg_temp.id('shop'),pg_temp.id('pa'),10,50000,'Alpha monthly',true,'b1-s-a')::text,false);
select ok(pg_temp.id('s_a') is not null,'owner sets a schedule');
select is((select count(*)::int from supplier_payment_schedules where party_id=pg_temp.id('pa')),1,'one row');
select is(set_supplier_payment_schedule(pg_temp.id('shop'),pg_temp.id('pa'),12,60000,'Alpha moved',true,'b1-s-a2'),pg_temp.id('s_a'),'setting again updates the same schedule');
select is((select due_day||':'||expected_amount_paise from supplier_payment_schedules where id=pg_temp.id('s_a')),'12:60000','the update took effect');
select is((select count(*)::int from supplier_payment_schedules where party_id=pg_temp.id('pa')),1,'still one live schedule per supplier');
select is(set_supplier_payment_schedule(pg_temp.id('shop'),pg_temp.id('pa'),10,50000,'Alpha monthly',true,'b1-s-a3'),pg_temp.id('s_a'),'back to day 10 / 500.00');

-- validation
select throws_like($$select set_supplier_payment_schedule(pg_temp.id('shop'),pg_temp.id('pb'),0,1000,null,true,'b1-x1')$$,'%DSB_INVALID_SCHEDULE%','due day 0 refused');
select throws_like($$select set_supplier_payment_schedule(pg_temp.id('shop'),pg_temp.id('pb'),29,1000,null,true,'b1-x2')$$,'%DSB_INVALID_SCHEDULE%','due day 29 refused');
select throws_like($$select set_supplier_payment_schedule(pg_temp.id('shop'),pg_temp.id('pb'),5,0,null,true,'b1-x3')$$,'%DSB_INVALID_SCHEDULE%','zero amount refused');
select throws_like($$select set_supplier_payment_schedule(pg_temp.id('shop'),pg_temp.id('pb'),5,-5,null,true,'b1-x4')$$,'%DSB_INVALID_SCHEDULE%','negative amount refused');
select throws_like($$select set_supplier_payment_schedule(pg_temp.id('shop'),pg_temp.id('pb'),5,100000000000001,null,true,'b1-x5')$$,'%DSB_INVALID_SCHEDULE%','absurd amount refused');
select throws_like($$select set_supplier_payment_schedule(pg_temp.id('shop'),pg_temp.id('pb'),5,1000,repeat('n',301),true,'b1-x6')$$,'%DSB_INVALID_SCHEDULE%','overlong note refused');
select throws_like($$select set_supplier_payment_schedule(pg_temp.id('shop'),gen_random_uuid(),5,1000,null,true,'b1-x7')$$,'%DSB_PARTY_NOT_FOUND%','unknown supplier refused');
select throws_like($$select set_supplier_payment_schedule(pg_temp.id('other_shop'),pg_temp.id('pb'),5,1000,null,true,'b1-x8')$$,'%not permitted%','a shop of another tenant is refused');
select lives_ok($$select set_supplier_payment_schedule(pg_temp.id('shop'),pg_temp.id('pb'),5,null,'no amount',true,'b1-s-b')$$,'a schedule without an expected amount is allowed');
select lives_ok($$select set_supplier_payment_schedule(pg_temp.id('shop'),pg_temp.id('pc'),1,2000,null,false,'b1-s-c')$$,'a paused schedule can be created');

-- due derivation (Alpha day 10 / 500.00; Beta day 5 no amount; Gamma paused)
select is(pg_temp.due_ids('2026-10-04'),'-','nothing is due before the due days');
select is(pg_temp.due_ids('2026-10-05'),'Beta','Beta is due on its day');
select is(pg_temp.due_ids('2026-10-10'),'Alpha,Beta','Alpha is due from day 10');
select is((select remaining_paise from get_supplier_payments_due(pg_temp.id('shop'),'2026-10-10') where party_name='Alpha'),50000::bigint,'remaining is the full expected amount');
reset role;
insert into payments(tenant_id,shop_id,kind,party_id,business_date,amount_paise,mode,status,client_id,direction) values
 (pg_temp.id('tenant'),pg_temp.id('shop'),'party',pg_temp.id('pa'),'2026-10-02',20000,'cash','POSTED','b1-pay-1','out'),
 (pg_temp.id('tenant'),pg_temp.id('shop'),'party',pg_temp.id('pa'),'2026-10-03',99999,'cash','VOID','b1-pay-void','out'),
 (pg_temp.id('tenant'),pg_temp.id('shop'),'party',pg_temp.id('pa'),'2026-10-04',77777,'cash','POSTED','b1-pay-in','in'),
 (pg_temp.id('tenant'),pg_temp.id('shop'),'party',pg_temp.id('pa'),'2026-09-28',500000,'cash','POSTED','b1-pay-last','out');
set role authenticated;
select pg_temp.act('b1000000-0000-0000-0000-000000000001');
select is((select remaining_paise from get_supplier_payments_due(pg_temp.id('shop'),'2026-10-10') where party_name='Alpha'),30000::bigint,'only the posted payment made this month counts (void, refund-in and last month do not)');
reset role;
insert into payments(tenant_id,shop_id,kind,party_id,business_date,amount_paise,mode,status,client_id,direction) values
 (pg_temp.id('tenant'),pg_temp.id('shop'),'party',pg_temp.id('pa'),'2026-10-06',30000,'bank','POSTED','b1-pay-2','out'),
 (pg_temp.id('tenant'),pg_temp.id('shop'),'party',pg_temp.id('pb'),'2026-10-06',1,'cash','POSTED','b1-pay-b','out');
set role authenticated;
select pg_temp.act('b1000000-0000-0000-0000-000000000001');
select is(pg_temp.due_ids('2026-10-10'),'-','paid in full (Alpha) and any payment when no amount is set (Beta) clear the reminder');
select is(pg_temp.due_ids('2026-11-10'),'Alpha,Beta','next month they are due again');

-- remove, archive, re-create
select set_supplier_payment_schedule(pg_temp.id('shop'),pg_temp.id('pd'),3,1000,null,true,'b1-s-d');
select is(pg_temp.due_ids('2026-11-10'),'Alpha,Beta,Delta','a new schedule is listed');
select is(remove_supplier_payment_schedule((select id from supplier_payment_schedules where party_id=pg_temp.id('pd') and deleted_at is null)),(select id from supplier_payment_schedules where party_id=pg_temp.id('pd') order by created_at desc limit 1),'removing returns the schedule id');
select is(pg_temp.due_ids('2026-11-10'),'Alpha,Beta','a removed schedule is no longer listed');
select lives_ok($$select set_supplier_payment_schedule(pg_temp.id('shop'),pg_temp.id('pd'),4,2000,null,true,'b1-s-d2')$$,'a supplier can get a new schedule after removal');

-- roles
select pg_temp.act('b1000000-0000-0000-0000-000000000002');
select lives_ok($$select set_supplier_payment_schedule(pg_temp.id('shop'),pg_temp.id('pb'),6,null,'manager edit',true,'b1-s-b2')$$,'a manager can set a schedule');
select pg_temp.act('b1000000-0000-0000-0000-000000000003');
select throws_like($$select set_supplier_payment_schedule(pg_temp.id('shop'),pg_temp.id('pb'),7,null,null,true,'b1-s-b3')$$,'%not permitted%','a cashier cannot set a schedule');
select throws_like($$select * from get_supplier_payments_due(pg_temp.id('shop'),'2026-11-10')$$,'%not permitted%','a cashier cannot read what is due');

select * from finish();
rollback;
