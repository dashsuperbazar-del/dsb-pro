-- Packet O1 (mig 0054): opening balances for customers and suppliers.
begin;
create extension if not exists pgtap with schema extensions;
select plan(28);
insert into auth.users(id) values
 ('01000000-0000-0000-0000-000000000001'),  -- owner
 ('01000000-0000-0000-0000-000000000002'),  -- manager
 ('01000000-0000-0000-0000-000000000004');  -- cashier
create function pg_temp.act(p_user text) returns void language sql as
 $$ select set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true) $$;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select current_setting('o1.'||p_key)::uuid $$;
set role authenticated;
select pg_temp.act('01000000-0000-0000-0000-000000000001');
select create_tenant('O1 Co','o1-co','O1 Shop','o1-tenant');
select set_config('o1.tenant',current_tenant_id()::text,false);
select set_config('o1.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into customers(tenant_id,name,client_id) values(current_tenant_id(),'Old Customer','o1-cust');
select set_config('o1.cust',(select id::text from customers where client_id='o1-cust'),false);
insert into parties(tenant_id,name,client_id) values(current_tenant_id(),'Old Supplier','o1-party');
select set_config('o1.party',(select id::text from parties where client_id='o1-party'),false);
reset role;
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id) values
 (pg_temp.id('tenant'),'01000000-0000-0000-0000-000000000002','manager',array[pg_temp.id('shop')],'active','o1-mgr'),
 (pg_temp.id('tenant'),'01000000-0000-0000-0000-000000000004','cashier',array[pg_temp.id('shop')],'active','o1-cash');
set role authenticated;
select pg_temp.act('01000000-0000-0000-0000-000000000001');

create function pg_temp.open(p_kind text,p_acct text,p_amt bigint,p_client text,p_date date default '2026-09-30') returns uuid language sql as
 $$ select record_account_opening(pg_temp.id('shop'),p_kind,pg_temp.id(p_acct),p_date,p_amt,'cutover from old DSB',p_client) $$;

-- Customer owes the shop 50.00 at cutover.
select lives_ok($$select set_config('o1.copen',pg_temp.open('CUSTOMER','cust',5000,'o1-c1')::text,false)$$,'owner records a customer opening');
select is(pg_temp.open('CUSTOMER','cust',5000,'o1-c1'),pg_temp.id('copen'),'exact replay returns the same opening');
select throws_like($$select pg_temp.open('CUSTOMER','cust',6000,'o1-c1')$$,'DSB_PAYLOAD_MISMATCH%','same client id, different amount is refused');
select throws_like($$select pg_temp.open('CUSTOMER','cust',100,'o1-c2')$$,'DSB_OPENING_EXISTS%','second active opening for the account is refused');
select is((select balance_paise from customer_balances where customer_id=pg_temp.id('cust')),5000::bigint,'customer balance includes the opening');
select is((select entry_type||':'||debit_paise from customer_ledger where customer_id=pg_temp.id('cust')),'OPENING:5000','ledger shows one opening row');

-- Validation.
select throws_like($$select pg_temp.open('SUPPLIER','party',0,'o1-z')$$,'DSB_INVALID_AMOUNT%','zero opening refused');
select throws_like($$select pg_temp.open('SUPPLIER','party',100,'o1-f',shop_business_date(pg_temp.id('shop'))+1)$$,'DSB_FUTURE_DATE%','future as-of date refused');
select throws_like($$select record_account_opening(pg_temp.id('shop'),'SUPPLIER',pg_temp.id('party'),'2026-09-30',100,' ','o1-r')$$,'DSB_INVALID_REASON%','reason required');
select throws_like($$select pg_temp.open('SUPPLIER','cust',100,'o1-w')$$,'DSB_ACCOUNT_UNAVAILABLE%','account must match its kind');

-- Supplier owes the shop 20.00 (negative opening for a supplier).
select lives_ok($$select set_config('o1.sopen',pg_temp.open('SUPPLIER','party',-2000,'o1-s1')::text,false)$$,'owner records a negative supplier opening');
select is(get_supplier_outstanding(pg_temp.id('shop'))->'parties'->0->>'netLedgerBalance','-2000','supplier net balance includes the opening');
select is(get_supplier_outstanding(pg_temp.id('shop'))->'parties'->0->>'remainingOpeningCredits','2000','opening credit reported separately');
select is(get_party_ledger_v2(pg_temp.id('shop'),pg_temp.id('party'),null,null)->>'closingBalancePaise','-2000','supplier ledger closes at the opening');
select is(get_party_ledger_v2(pg_temp.id('shop'),pg_temp.id('party'),null,null)->'entries'->0->>'kind','OPENING_BALANCE','supplier ledger opening row');

-- Aging: the opening is an open item; a later receipt is unassigned cash; the bridge holds.
select record_customer_payment_v2(pg_temp.id('shop'),pg_temp.id('cust'),'2026-10-01',1000,'cash',null,'[]'::jsonb,'01000000-0000-0000-0000-0000000000a1');
select is(get_customer_aging_report_v2(pg_temp.id('shop'),'2026-10-01')->'accounts'->0->>'netLedgerBalancePaise','4000','aging net = opening - receipt');
select is(get_customer_aging_report_v2(pg_temp.id('shop'),'2026-10-01')->'accounts'->0->>'days1to30Paise','5000','opening aged from its as-of date');
select is(get_customer_aging_report_v2(pg_temp.id('shop'),'2026-10-01')->'accounts'->0->>'unassignedInPaise','1000','receipt shown as unassigned cash (settlement is O2)');
select is(get_customer_aging_report_v2(pg_temp.id('shop'),'2026-09-29')->'accounts','[]'::jsonb,'before the as-of date the opening is not counted');

-- Correction: void, then record the right amount.
select throws_like($$select pg_temp.open('CUSTOMER','cust',4500,'o1-c3')$$,'DSB_OPENING_EXISTS%','still exists before void');
select lives_ok($$select void_account_opening(pg_temp.id('copen'),'wrong amount')$$,'owner voids an opening');
select lives_ok($$select pg_temp.open('CUSTOMER','cust',4500,'o1-c3')$$,'corrected opening recorded after void');
select is((select balance_paise from customer_balances where customer_id=pg_temp.id('cust')),3500::bigint,'balance uses only the active opening (4500 - 1000)');

-- Roles and visibility.
select pg_temp.act('01000000-0000-0000-0000-000000000002');
select throws_like($$select pg_temp.open('SUPPLIER','party',100,'o1-m')$$,'not permitted%','manager cannot record openings');
select pg_temp.act('01000000-0000-0000-0000-000000000004');
select is((select count(*) from account_openings where account_kind='SUPPLIER'),0::bigint,'cashier cannot read supplier openings');
select pg_temp.act('01000000-0000-0000-0000-000000000001');

-- Immutability, export, invariants.
reset role;
select throws_like($$update account_openings set amount_paise=1 where client_id='o1-s1'$$,'%immutable%','opening amount cannot be edited');
set role authenticated;
select pg_temp.act('01000000-0000-0000-0000-000000000001');
select is(jsonb_array_length(phase6_export_tenant(pg_temp.id('shop'))->'accountOpenings'),3,'export includes openings (incl. voided)');
select is((check_invariants()->>'ok')::boolean,true,'invariants hold');

select * from finish();
rollback;
