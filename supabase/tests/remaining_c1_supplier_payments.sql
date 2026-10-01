-- Packet C1 (mig 0047): supplier payments. Vectors per COMPLETE_REMAINING_BUILD_PLAN v1.1 §7.5
-- (C27-C30 concurrency vectors live in scripts/test-supplier-payment-concurrency.mjs).
begin;
create extension if not exists pgtap with schema extensions;
select plan(56);

insert into auth.users(id) values
 ('c1c00000-0000-0000-0000-000000000001'),  -- owner
 ('c1c00000-0000-0000-0000-000000000002'),  -- manager
 ('c1c00000-0000-0000-0000-000000000003'),  -- accountant
 ('c1c00000-0000-0000-0000-000000000004'),  -- cashier
 ('c1c00000-0000-0000-0000-000000000009');  -- other tenant owner

create function pg_temp.act(p_user text) returns void language sql as
 $$ select set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true) $$;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select current_setting('c1.'||p_key)::uuid $$;

-- Other tenant with one bill (C11).
set role authenticated;
select pg_temp.act('c1c00000-0000-0000-0000-000000000009');
select create_tenant('C1 Other','c1-other','Other Shop','c1-other-tenant');
select set_config('c1.oshop',(select id::text from shops where tenant_id=current_tenant_id() limit 1),false);
insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'Other Item','piece','c1-oitem');
insert into parties(tenant_id,name,client_id) values(current_tenant_id(),'Other Supplier','c1-oparty');
select set_config('c1.obill',post_purchase(pg_temp.id('oshop'),(select id from parties where client_id='c1-oparty'),'O-1','2026-09-10',0,0,'c1-obill',
 jsonb_build_array(jsonb_build_object('item_id',(select id from items where client_id='c1-oitem'),'unit_level',1,'qty',10,'unit_price_paise',100)),null)::text,false);

-- Main tenant: two shops, two suppliers, roles.
select pg_temp.act('c1c00000-0000-0000-0000-000000000001');
select create_tenant('C1 Co','c1-co','C1 Shop','c1-tenant');
select set_config('c1.tenant',current_tenant_id()::text,false);
select set_config('c1.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
reset role;
insert into shops(id,tenant_id,name,created_by) values('c1c00000-0000-0000-0000-000000000050',pg_temp.id('tenant'),'C1 Shop Two','c1c00000-0000-0000-0000-000000000001');
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id) values
 (pg_temp.id('tenant'),'c1c00000-0000-0000-0000-000000000002','manager',array[pg_temp.id('shop')],'active','c1-mgr'),
 (pg_temp.id('tenant'),'c1c00000-0000-0000-0000-000000000003','accountant',array[pg_temp.id('shop')],'active','c1-acct'),
 (pg_temp.id('tenant'),'c1c00000-0000-0000-0000-000000000004','cashier',array[pg_temp.id('shop')],'active','c1-cash');
set role authenticated;
select pg_temp.act('c1c00000-0000-0000-0000-000000000001');
insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'C1 Item','piece','c1-item');
select set_config('c1.item',(select id::text from items where client_id='c1-item'),false);
insert into parties(tenant_id,name,client_id) values(current_tenant_id(),'Supplier A','c1-pa'),(current_tenant_id(),'Supplier B','c1-pb');
select set_config('c1.pa',(select id::text from parties where client_id='c1-pa'),false);
select set_config('c1.pb',(select id::text from parties where client_id='c1-pb'),false);
create function pg_temp.bill(p_key text,p_shop uuid,p_party uuid,p_date date,p_qty int) returns void language sql as $$
 select set_config('c1.'||p_key,post_purchase(p_shop,p_party,upper(p_key),p_date,0,0,'c1-'||p_key,
  jsonb_build_array(jsonb_build_object('item_id',current_setting('c1.item'),'unit_level',1,'qty',p_qty,'unit_price_paise',100)),null)::text,false) $$;
select pg_temp.bill('b1',pg_temp.id('shop'),pg_temp.id('pa'),'2026-09-10',1000);   -- 100000
select pg_temp.bill('b2',pg_temp.id('shop'),pg_temp.id('pa'),'2026-09-11',500);    -- 50000
select pg_temp.bill('b3',pg_temp.id('shop'),pg_temp.id('pa'),'2026-09-11',300);    -- 30000
select pg_temp.bill('b4',pg_temp.id('shop'),pg_temp.id('pa'),'2026-09-12',1000);   -- 100000
select pg_temp.bill('bpb',pg_temp.id('shop'),pg_temp.id('pb'),'2026-09-10',100);   -- other party
select pg_temp.bill('bs2',pg_temp.id('shop'),pg_temp.id('pa'),'2026-09-10',100);   -- placeholder, replaced below
select pg_temp.bill('bvoid',pg_temp.id('shop'),pg_temp.id('pa'),'2026-09-10',100);
select void_purchase(pg_temp.id('bvoid'),'c1-bvoid-void');
select pg_temp.bill('bfut',pg_temp.id('shop'),pg_temp.id('pa'),shop_business_date(pg_temp.id('shop')),100);
reset role;
-- a bill in shop two of the same tenant (seed stock there first)
set role authenticated;
select pg_temp.act('c1c00000-0000-0000-0000-000000000001');
select pg_temp.bill('bshop2','c1c00000-0000-0000-0000-000000000050'::uuid,pg_temp.id('pa'),'2026-09-10',100);

create function pg_temp.out(p_bill text) returns bigint language sql as
 $$ select outstanding_paise from purchase_bill_outstanding where purchase_bill_id=pg_temp.id(p_bill) $$;
create function pg_temp.rec(p_req text,p_amount bigint,p_allocs jsonb,p_date date default '2026-09-20',p_party text default 'pa') returns uuid language sql as
 $$ select record_supplier_payment(pg_temp.id('shop'),pg_temp.id(p_party),p_date,p_amount,'cash',null,p_allocs,p_req) $$;
create function pg_temp.a(p_bill text,p_amount bigint) returns jsonb language sql as
 $$ select jsonb_build_object('purchase_bill_id',pg_temp.id(p_bill),'amount_paise',p_amount) $$;

-- C01 partial, C02 exact.
select pg_temp.rec('11111111-0000-0000-0000-000000000001',40000,jsonb_build_array(pg_temp.a('b1',40000)));
select is(pg_temp.out('b1'),60000::bigint,'C01 partial 100000/40000 leaves 60000');
select pg_temp.rec('11111111-0000-0000-0000-000000000002',60000,jsonb_build_array(pg_temp.a('b1',60000)));
select is(pg_temp.out('b1'),0::bigint,'C02 exact payment clears the bill');
-- C03 multiple bills, unsorted input stored sorted.
select pg_temp.rec('11111111-0000-0000-0000-000000000003',30000,jsonb_build_array(pg_temp.a('b3',10000),pg_temp.a('b2',20000)));
select is(pg_temp.out('b2')+pg_temp.out('b3'),(30000+20000)::bigint,'C03 both bills allocated');
reset role;
select is((select request->'allocations'->0->>'purchase_bill_id' from financial_requests where client_id='11111111-0000-0000-0000-000000000003'),
 least(current_setting('c1.b2'),current_setting('c1.b3')),'C03 stored allocations are sorted by bill UUID');
set role authenticated; select pg_temp.act('c1c00000-0000-0000-0000-000000000001');
-- C04/C05/C06.
select throws_like($$select pg_temp.rec('11111111-0000-0000-0000-000000000004',99999,jsonb_build_array(pg_temp.a('b2',30001)))$$,'DSB_ALLOCATION_EXCEEDS_BILL%','C04 allocation over bill balance rejected');
select throws_like($$select pg_temp.rec('11111111-0000-0000-0000-000000000005',100,jsonb_build_array(pg_temp.a('b2',200)))$$,'DSB_ALLOCATION_EXCEEDS_PAYMENT%','C05 allocations over payment rejected');
select throws_ok(format($$select pg_temp.rec('11111111-0000-0000-0000-000000000006',500,'[{"purchase_bill_id":"%s","amount_paise":1},{"purchase_bill_id":"%s","amount_paise":2}]')$$,
 current_setting('c1.b2'),upper(current_setting('c1.b2'))),'duplicate allocation target','C06 duplicate bill UUID (case-insensitive) rejected');
-- C07 advance, C08 later allocation.
select set_config('c1.adv',pg_temp.rec('11111111-0000-0000-0000-000000000007',25000,'[]')::text,false);
select is((select count(*) from payment_allocations where payment_id=pg_temp.id('adv')),0::bigint,'C07 empty allocations record an advance');
select is((select unallocatedCash from (select (e->>'unallocatedCashAdvances')::bigint unallocatedCash from jsonb_array_elements(get_supplier_outstanding(pg_temp.id('shop'))->'parties') e
 where e->>'partyId'=current_setting('c1.pa')) x),25000::bigint,'C07 advance reported as unallocated cash');
select is(allocate_supplier_payment(pg_temp.id('adv'),jsonb_build_array(pg_temp.a('b2',15000)),'11111111-0000-0000-0000-000000000008')->>'effectiveDate',
 shop_business_date(pg_temp.id('shop'))::text,'C08 later allocation is effective today');
select is(pg_temp.out('b2'),15000::bigint,'C08 later allocation reduces the bill balance');
select throws_like($$select allocate_supplier_payment(pg_temp.id('adv'),jsonb_build_array(pg_temp.a('b4',10001)),'11111111-0000-0000-0000-000000000009')$$,
 'DSB_ALLOCATION_EXCEEDS_PAYMENT%','C08 later allocation cannot exceed the remaining payment budget');
-- C09/C10/C11/C12.
select throws_like($$select pg_temp.rec('11111111-0000-0000-0000-000000000010',100,jsonb_build_array(pg_temp.a('bpb',100)))$$,'DSB_BILL_MISMATCH%','C09 another supplier''s bill rejected');
select throws_like($$select pg_temp.rec('11111111-0000-0000-0000-000000000011',100,jsonb_build_array(pg_temp.a('bshop2',100)))$$,'DSB_BILL_MISMATCH%','C10 bill in another shop of the same tenant rejected');
select throws_like($$select pg_temp.rec('11111111-0000-0000-0000-000000000012',100,jsonb_build_array(pg_temp.a('obill',100)))$$,'DSB_BILL_UNAVAILABLE%','C11 another tenant''s bill rejected');
select throws_like($$select pg_temp.rec('11111111-0000-0000-0000-000000000013',100,jsonb_build_array(pg_temp.a('bvoid',100)))$$,'DSB_BILL_UNAVAILABLE%','C12 void bill rejected');
-- C13 return before payment: only the post-return balance is allocatable.
select post_return('PURCHASE',pg_temp.id('b4'),'2026-09-15','c1-ret-b4',jsonb_build_array(jsonb_build_object(
 'purchase_bill_item_id',(select id from purchase_bill_items where purchase_bill_id=pg_temp.id('b4')),'qty',200,'disposition','SUPPLIER_RETURN')));
select is(pg_temp.out('b4'),80000::bigint,'C13 return before payment reduces the allocatable balance');
select throws_like($$select pg_temp.rec('11111111-0000-0000-0000-000000000014',100000,jsonb_build_array(pg_temp.a('b4',80001)))$$,'DSB_ALLOCATION_EXCEEDS_BILL%','C13 cannot allocate past the post-return balance');
-- C14 return after full payment: negative net, reported as return credit, no fabricated cash.
select post_return('PURCHASE',pg_temp.id('b1'),'2026-09-21','c1-ret-b1',jsonb_build_array(jsonb_build_object(
 'purchase_bill_item_id',(select id from purchase_bill_items where purchase_bill_id=pg_temp.id('b1')),'qty',100,'disposition','SUPPLIER_RETURN')));
select is((select net_outstanding_paise from purchase_bill_outstanding where purchase_bill_id=pg_temp.id('b1')),(-10000)::bigint,'C14 return after full payment leaves a negative net');
select is((select (e->>'returnCredits')::bigint from jsonb_array_elements(get_supplier_outstanding(pg_temp.id('shop'))->'parties') e
 where e->>'partyId'=current_setting('c1.pa')),10000::bigint,'C14 negative net reported as return credit');
select is((select count(*) from payments where party_id=pg_temp.id('pa') and direction='in'),0::bigint,'C14 no supplier cash receipt is fabricated');
-- C17 replay / changed payload; C18 same request UUID across operations.
select is(pg_temp.rec('11111111-0000-0000-0000-000000000001',40000,jsonb_build_array(pg_temp.a('b1',40000))),
 (select id from payments where client_id='supplier.record.v1:11111111-0000-0000-0000-000000000001'),'C17 exact replay returns the original payment');
select throws_like($$select pg_temp.rec('11111111-0000-0000-0000-000000000001',40001,jsonb_build_array(pg_temp.a('b1',40000)))$$,'DSB_PAYLOAD_MISMATCH%','C17 changed payload under the same request id rejected');
select lives_ok($$select allocate_supplier_payment(pg_temp.id('adv'),jsonb_build_array(pg_temp.a('b3',100)),'11111111-0000-0000-0000-000000000007')$$,
 'C18 the same request UUID used for record and allocate does not collide');
-- C24 amounts, C25 malformed input, C26 rollback leaves no request row, C31 future bill, future payment date.
select throws_like($$select pg_temp.rec('11111111-0000-0000-0000-000000000024',0,'[]')$$,'DSB_INVALID_AMOUNT%','C24 zero amount rejected');
select throws_like($$select pg_temp.rec('11111111-0000-0000-0000-000000000025',-5,'[]')$$,'DSB_INVALID_AMOUNT%','C24 negative amount rejected');
select throws_ok($$select pg_temp.rec('11111111-0000-0000-0000-000000000026',9007199254740992,'[]')$$,'amount out of safe range','C24 unsafe amount rejected');
select throws_like($$select pg_temp.rec('11111111-0000-0000-0000-000000000027',100,null)$$,'DSB_INVALID_ALLOCATIONS%','C25 null allocations rejected (use [] for an advance)');
select throws_ok($$select pg_temp.rec('11111111-0000-0000-0000-000000000028',100,'{}')$$,'allocations must be an array','C25 allocation object rejected');
select throws_ok($$select pg_temp.rec('11111111-0000-0000-0000-000000000029',100,'[{"purchase_bill_id":"nope","amount_paise":1}]')$$,'allocation target must be a uuid','C25 bad bill UUID rejected');
select throws_like($$select pg_temp.rec('not-a-uuid',100,'[]')$$,'DSB_INVALID_REQUEST_ID%','C25 request id must be a UUID');
reset role; select is((select count(*) from financial_requests where client_id='11111111-0000-0000-0000-000000000004'),0::bigint,'C26 a failed request leaves no request row'); set role authenticated;
select throws_like($$select pg_temp.rec('11111111-0000-0000-0000-000000000031',100,jsonb_build_array(pg_temp.a('bfut',100)),'2026-09-20')$$,'DSB_FUTURE_BILL%','C31 bill dated after the payment rejected');
select throws_like($$select pg_temp.rec('11111111-0000-0000-0000-000000000032',100,'[]',(shop_business_date(pg_temp.id('shop'))+1))$$,'DSB_FUTURE_DATE%','future payment date rejected');
-- C15 void, C16 release; generic void_payment refuses supplier rows.
select set_config('c1.p3',(select id::text from payments where client_id='supplier.record.v1:11111111-0000-0000-0000-000000000003'),false);
select throws_like($$select void_payment(pg_temp.id('p3'))$$,'DSB_USE_SUPPLIER_VOID%','generic void_payment refuses supplier payments');
select release_supplier_allocation((select id from payment_allocations where payment_id=pg_temp.id('p3') and purchase_bill_id=pg_temp.id('b3')),'wrong bill matched','11111111-0000-0000-0000-000000000016');
select is(pg_temp.out('b3'),29900::bigint,'C16 release restores the bill balance');
select is((select status from payments where id=pg_temp.id('p3')),'POSTED','C16 release does not reverse the cash payment');
select is(get_financial_request(pg_temp.id('shop'),'supplier.release.v1','11111111-0000-0000-0000-000000000016')->>'currentStatus','VOID','C16 release reconciliation reports the allocation status');
select void_supplier_payment(pg_temp.id('p3'),'entered twice','11111111-0000-0000-0000-000000000015');
select is((select status from payments where id=pg_temp.id('p3')),'VOID','C15 void marks the payment VOID');
select is(pg_temp.out('b2'),35000::bigint,'C15 void releases the payment''s remaining allocations');
select is(void_supplier_payment(pg_temp.id('p3'),'entered twice','11111111-0000-0000-0000-000000000015'),pg_temp.id('p3'),'C15 void replay returns the same id');
-- C23 conservation: ledger closing balance equals the outstanding report's signed balance.
select is((get_party_ledger_v2(pg_temp.id('shop'),pg_temp.id('pa'),null,null)->>'closingBalancePaise'),
 (select e->>'netLedgerBalance' from jsonb_array_elements(get_supplier_outstanding(pg_temp.id('shop'))->'parties') e where e->>'partyId'=current_setting('c1.pa')),
 'C23 ledger closing balance equals the outstanding report''s net balance');
select is((check_invariants()->>'paymentDirectionViolations')::int,0,'C23 supplier allocations are not payment-direction violations');
select is((check_invariants()->>'ok')::boolean,true,'C23 invariants ok with supplier allocations present');
-- C32 deleted supplier: no new payments, history still readable.
reset role;
update parties set deleted_at=1 where id=pg_temp.id('pb');
set role authenticated; select pg_temp.act('c1c00000-0000-0000-0000-000000000001');
select throws_like($$select pg_temp.rec('11111111-0000-0000-0000-000000000033',100,'[]','2026-09-20','pb')$$,'DSB_PARTY_UNAVAILABLE%','C32 deleted supplier cannot receive a new payment');
select ok(get_party_ledger_v2(pg_temp.id('shop'),pg_temp.id('pb'),null,null) ? 'entries','C32 deleted supplier ledger still readable');

-- C20 manager: can post, cannot void/release.
select pg_temp.act('c1c00000-0000-0000-0000-000000000002');
select lives_ok($$select pg_temp.rec('11111111-0000-0000-0000-000000000040',100,'[]')$$,'C20 manager can record a supplier payment');
select throws_ok($$select void_supplier_payment(pg_temp.id('adv'),'x','11111111-0000-0000-0000-000000000041')$$,'not permitted','C20 manager cannot void');
select throws_ok($$select release_supplier_allocation((select id from payment_allocations limit 1),'x','11111111-0000-0000-0000-000000000042')$$,'not permitted','C20 manager cannot release');
-- C21 accountant: can read, cannot post.
select pg_temp.act('c1c00000-0000-0000-0000-000000000003');
select ok(get_supplier_outstanding(pg_temp.id('shop')) ? 'parties','C21 accountant can read supplier outstanding');
select throws_ok($$select pg_temp.rec('11111111-0000-0000-0000-000000000043',100,'[]')$$,'not permitted','C21 accountant cannot record');
-- C19 cashier: no supplier rows through direct reads or joins, no RPC access.
select pg_temp.act('c1c00000-0000-0000-0000-000000000004');
select is((select count(*) from payments where kind='party'),0::bigint,'C19 cashier sees no supplier payments');
select is((select count(*) from payment_allocations where doc_type='PURCHASE'),0::bigint,'C19 cashier sees no supplier allocations');
select throws_ok($$select pg_temp.rec('11111111-0000-0000-0000-000000000044',100,'[]')$$,'not permitted','C19 cashier cannot record');
select throws_ok($$select get_supplier_outstanding(pg_temp.id('shop'))$$,'not permitted','C19 cashier cannot read supplier outstanding');
-- C22 customer refund allocations still rejected by the direction-aware validator.
reset role;
insert into customers(tenant_id,name,client_id,created_by) values(pg_temp.id('tenant'),'C1 Cust','c1-cust','c1c00000-0000-0000-0000-000000000001');
insert into payments(tenant_id,shop_id,kind,customer_id,business_date,amount_paise,mode,client_id,created_by,direction)
 values(pg_temp.id('tenant'),pg_temp.id('shop'),'customer',(select id from customers where client_id='c1-cust'),'2026-09-20',10,'cash','c1-out-cust','c1c00000-0000-0000-0000-000000000001','out');
select throws_ok(format($$insert into payment_allocations(tenant_id,payment_id,doc_type,purchase_bill_id,amount_paise,client_id,created_by)
 values(%L,(select id from payments where client_id='c1-out-cust'),'PURCHASE',%L,1,'c1-bad','c1c00000-0000-0000-0000-000000000001')$$,
 current_setting('c1.tenant'),current_setting('c1.b4')),'DSB_PAYMENT_NOT_SUPPLIER_OUT: payment unavailable','C22 customer payment cannot be allocated to a purchase bill');

select * from finish();
rollback;
