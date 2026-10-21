-- Packet billedit (mig 0066): atomic purchase-bill edit. Posts the corrected bill (post_purchase_v2 path) and
-- voids the original (void_purchase path) in one transaction; carries live payments; idempotent by request id;
-- refuses unsafe edits (returns, consumed stock, supplier/payment-type change with a payment) with distinct codes.
begin;
create extension if not exists pgtap with schema extensions;
select plan(75);
insert into auth.users(id) values
 ('e6000000-0000-0000-0000-000000000001'),  -- owner
 ('e6000000-0000-0000-0000-000000000002'),  -- manager
 ('e6000000-0000-0000-0000-000000000003'),  -- cashier
 ('e6000000-0000-0000-0000-000000000004');  -- owner of another tenant
create function pg_temp.act(p_user text) returns void language sql as
 $$ select set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true) $$;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select current_setting('e6.'||p_key)::uuid $$;
create function pg_temp.bal(p_party text) returns numeric language sql as $$
 select coalesce((select (e->>'netLedgerBalance')::numeric from jsonb_array_elements(get_supplier_outstanding(pg_temp.id('shop'))->'parties') e
   where e->>'partyId'=pg_temp.id(p_party)::text),0) $$;
create function pg_temp.stock(p_item text) returns numeric language sql as $$
 select coalesce((select on_hand from stock_current where shop_id=pg_temp.id('shop') and item_id=pg_temp.id(p_item)),0) $$;
-- A whole-rupee bill of one item: qty x price, no discount/GST, round-off 0.
create function pg_temp.bill(p_party text,p_type text,p_item text,p_qty int,p_price bigint,p_notes text default null) returns jsonb language sql as $$
 select jsonb_build_object('party_id',case when p_party is null then null else pg_temp.id(p_party) end,'payment_type',p_type,
   'notes',p_notes,'total_paise',p_qty*p_price,'round_off_paise',0,
   'lines',jsonb_build_array(jsonb_build_object('item_id',pg_temp.id(p_item),'qty',p_qty::text,'unit_price_paise',p_price,
     'discount_bp',0,'gst_bp',null,'line_total_paise',p_qty*p_price))) $$;
create function pg_temp.post(p_client text,p_bill jsonb) returns uuid language sql as $$
 select (post_purchase_v2(pg_temp.id('shop'),p_client,p_bill)->>'billId')::uuid $$;
create function pg_temp.edit(p_orig text,p_client text,p_bill jsonb) returns jsonb language sql as $$
 select edit_purchase_bill(pg_temp.id(p_orig),p_client,p_bill) $$;

set role authenticated;
select pg_temp.act('e6000000-0000-0000-0000-000000000004');
select create_tenant('E6 Other','e6-other','E6 Other Shop','e6-other-tenant');
select pg_temp.act('e6000000-0000-0000-0000-000000000001');
select create_tenant('E6 Co','e6-co','E6 Shop','e6-tenant');
select set_config('e6.tenant',current_tenant_id()::text,false);
select set_config('e6.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into items(tenant_id,name,unit1,tax_rate_bp,client_id) values
 (current_tenant_id(),'E6 Rice','kg',0,'e6-a'),(current_tenant_id(),'E6 Dal','kg',0,'e6-b');
select set_config('e6.a',(select id::text from items where client_id='e6-a'),false);
select set_config('e6.b',(select id::text from items where client_id='e6-b'),false);
insert into item_prices(tenant_id,item_id,kind,unit_level,price_paise,effective_from,client_id)
 values(current_tenant_id(),pg_temp.id('b'),'retail',1,500,'2020-01-01','e6-b-price');
insert into parties(tenant_id,name,client_id) values(current_tenant_id(),'Shankar Traders','e6-s'),(current_tenant_id(),'Other Traders','e6-t');
select set_config('e6.s',(select id::text from parties where client_id='e6-s'),false);
select set_config('e6.t',(select id::text from parties where client_id='e6-t'),false);
reset role;
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id) values
 (pg_temp.id('tenant'),'e6000000-0000-0000-0000-000000000003','cashier',array[pg_temp.id('shop')],'active','e6-cash'),
 (pg_temp.id('tenant'),'e6000000-0000-0000-0000-000000000002','manager',array[pg_temp.id('shop')],'active','e6-mgr');

-- Hygiene
select ok(not has_function_privilege('anon','edit_purchase_bill(uuid,text,jsonb)','execute')
  and has_function_privilege('authenticated','edit_purchase_bill(uuid,text,jsonb)','execute')
  and not has_function_privilege('authenticated','be_purchase_link_guard()','execute'),'anon cannot edit; the link guard is internal');
select ok(not has_table_privilege('authenticated','purchase_bills','update')
  and not has_table_privilege('authenticated','purchase_bills','delete'),'clients cannot update or delete bills directly');

set role authenticated;
select pg_temp.act('e6000000-0000-0000-0000-000000000001');
select set_config('e6.bal0',pg_temp.bal('s')::text,false);

-- 1. Credit bill, edited by a manager: 10 x ₹10 -> 12 x ₹10 with a note.
select set_config('e6.x1',pg_temp.post('e6000000-0000-0000-0000-0000000000a1',pg_temp.bill('s','credit','a',10,1000))::text,false);
select is(pg_temp.stock('a'),10::numeric,'original bill received 10');
select pg_temp.act('e6000000-0000-0000-0000-000000000002');
select set_config('e6.r1json',pg_temp.bill('s','credit','a',12,1000,'rate checked')::text,false);
select set_config('e6.r1',pg_temp.edit('x1','e6000000-0000-0000-0000-0000000000e1',current_setting('e6.r1json')::jsonb)::text,false);
select set_config('e6.n1',current_setting('e6.r1')::jsonb->>'billId',false);
select is(current_setting('e6.r1')::jsonb->>'originalBillId',current_setting('e6.x1'),'answer names the original');
select is(current_setting('e6.r1')::jsonb->>'totalPaise','12000','answer carries the new total');
select is(current_setting('e6.r1')::jsonb->>'carriedPaise','0','nothing to carry on an unpaid credit bill');
select is((select row(status,replaced_by_id::text)::text from purchase_bills where id=pg_temp.id('x1')),
  format('(VOID,%s)',current_setting('e6.n1')),'original is void and points to the corrected bill');
select is((select row(status,edited_from_id::text,payment_type,notes,total_paise,client_id)::text from purchase_bills where id=pg_temp.id('n1')),
  format('(POSTED,%s,credit,"rate checked",12000,e6000000-0000-0000-0000-0000000000e1)',current_setting('e6.x1')),'corrected bill is posted and linked');
select is(pg_temp.stock('a'),12::numeric,'stock is the corrected quantity (10 in, 10 reversed, 12 in)');
select is((select sum(qty_base) from stock_movements where source_id=pg_temp.id('x1') and source_type='PURCHASE_VOID'),-10::numeric,
  'original reversed from its own lines');
select is((select count(*) from stock_movements where source_id=pg_temp.id('x1') and client_id like 'purchase.edit.v1:e6000000-0000-0000-0000-0000000000e1:stock:%'),
  1::bigint,'reversal is tagged with the edit request');
select is(pg_temp.bal('s')-current_setting('e6.bal0')::numeric,12000::numeric,'supplier balance counts only the corrected bill');
reset role;
select is((select count(*) from financial_requests where operation='purchase.edit.v1' and client_id='e6000000-0000-0000-0000-0000000000e1'),1::bigint,
  'edit stored for replay');
set role authenticated;

-- 2. Idempotent retry and payload mismatch.
select is(pg_temp.edit('x1','e6000000-0000-0000-0000-0000000000e1',current_setting('e6.r1json')::jsonb)->>'billId',current_setting('e6.n1'),
  'a retry returns the same new bill');
select is((select count(*) from purchase_bills where tenant_id=pg_temp.id('tenant')),2::bigint,'no extra bill from the retry');
select throws_like($$select pg_temp.edit('x1','e6000000-0000-0000-0000-0000000000e1',pg_temp.bill('s','credit','a',13,1000))$$,
  '%DSB_PAYLOAD_MISMATCH%','same id with a different bill is refused');
select throws_like($$select pg_temp.edit('n1','e6000000-0000-0000-0000-0000000000a1',pg_temp.bill('s','credit','a',13,1000))$$,
  '%DSB_PAYLOAD_MISMATCH%','an id already used for a posted bill is refused');
select throws_like($$select pg_temp.edit('x1','e6000000-0000-0000-0000-0000000000e2',pg_temp.bill('s','credit','a',13,1000))$$,
  '%DSB_EDIT_BILL_VOID%','an edited (void) bill cannot be edited again');
select throws_like($$select pg_temp.edit('x1','not-a-uuid',pg_temp.bill('s','credit','a',13,1000))$$,'%DSB_INVALID_REQUEST_ID%',
  'request id must be a UUID');

-- 3. Roles and tenancy.
select pg_temp.act('e6000000-0000-0000-0000-000000000003');
select throws_like($$select pg_temp.edit('n1','e6000000-0000-0000-0000-0000000000e3',pg_temp.bill('s','credit','a',1,1000))$$,
  '%not permitted%','a cashier cannot edit a bill');
select pg_temp.act('e6000000-0000-0000-0000-000000000004');
select throws_like($$select pg_temp.edit('n1','e6000000-0000-0000-0000-0000000000e3',pg_temp.bill('s','credit','a',1,1000))$$,
  '%purchase not found%','another tenant cannot see or edit the bill');
select pg_temp.act('e6000000-0000-0000-0000-000000000001');
select is((select row(status,replaced_by_id)::text from purchase_bills where id=pg_temp.id('n1')),'(POSTED,)','refusals changed nothing');

-- 4. A wrong total fails inside the new-bill step: the whole edit rolls back.
select throws_like($$select pg_temp.edit('n1','e6000000-0000-0000-0000-0000000000e4',
  jsonb_set(pg_temp.bill('s','credit','a',3,1000),'{total_paise}','2999'))$$,'%DSB_TOTAL_MISMATCH%','server recomputes the corrected bill');
select is((select count(*) from purchase_bills where client_id='e6000000-0000-0000-0000-0000000000e4'),0::bigint,'no new bill after a refusal');

-- 5. Chained edit of an edited bill, to a different supplier (no payment assigned): allowed.
select set_config('e6.n2',pg_temp.edit('n1','e6000000-0000-0000-0000-0000000000e5',pg_temp.bill('t','credit','a',11,1000))->>'billId',false);
select is((select edited_from_id from purchase_bills where id=pg_temp.id('n2')),pg_temp.id('n1'),'an edited bill can be corrected again');
select is(pg_temp.bal('s')-current_setting('e6.bal0')::numeric,0::numeric,'old supplier no longer owed');
select is(pg_temp.stock('a'),11::numeric,'stock follows the latest correction');

-- 6. Cash bill: its payment is carried, never voided or duplicated.
select set_config('e6.balc',pg_temp.bal('s')::text,false);
select set_config('e6.p1',pg_temp.post('e6000000-0000-0000-0000-0000000000a2',pg_temp.bill('s','cash','a',5,1000))::text,false);
select set_config('e6.pay',(select payment_id::text from payment_allocations where purchase_bill_id=pg_temp.id('p1') and status='POSTED'),false);
select is(pg_temp.bal('s')-current_setting('e6.balc')::numeric,0::numeric,'cash bill is settled');
select throws_like($$select pg_temp.edit('p1','e6000000-0000-0000-0000-0000000000e6',pg_temp.bill('s','credit','a',4,1000))$$,
  '%DSB_EDIT_PAYMENT_TYPE_CHANGED%','a paid bill keeps its payment type');
select throws_like($$select pg_temp.edit('p1','e6000000-0000-0000-0000-0000000000e6',pg_temp.bill('t','cash','a',4,1000))$$,
  '%DSB_EDIT_SUPPLIER_HAS_PAYMENTS%','a paid bill keeps its supplier');
select throws_like($$select pg_temp.edit('p1','e6000000-0000-0000-0000-0000000000e6',
  pg_temp.bill('s','cash','a',4,1000)||jsonb_build_object('business_date',shop_business_date(pg_temp.id('shop'))+1))$$,
  '%DSB_FUTURE_DATE%','a paid bill cannot move after today');
select set_config('e6.r3',pg_temp.edit('p1','e6000000-0000-0000-0000-0000000000e6',pg_temp.bill('s','cash','a',4,1000))::text,false);
select set_config('e6.c1',current_setting('e6.r3')::jsonb->>'billId',false);
select is(current_setting('e6.r3')::jsonb->>'carriedPaise','4000','₹40 of the ₹50 payment carried to the ₹40 bill');
select is(current_setting('e6.r3')::jsonb->'paymentId','null'::jsonb,'no new payment');
select is((select payment_type from purchase_bills where id=pg_temp.id('c1')),'cash','corrected bill keeps Cash');
select is((select count(*) from payments where party_id=pg_temp.id('s')),1::bigint,'still exactly one payment');
select is((select status from payments where id=pg_temp.id('pay')),'POSTED','the cash payment is untouched');
select is((select string_agg(purchase_bill_id::text||':'||amount_paise||':'||status,',' order by status,amount_paise) from payment_allocations where payment_id=pg_temp.id('pay')),
  format('%s:4000:POSTED,%s:5000:VOID',current_setting('e6.c1'),current_setting('e6.p1')),'allocation moved: old released, new up to the new total');
select is(pg_temp.bal('s')-current_setting('e6.balc')::numeric,-1000::numeric,'₹10 paid over the corrected bill is supplier credit');
select is((select outstanding_paise from purchase_bill_outstanding where purchase_bill_id=pg_temp.id('c1')),0::bigint,'corrected bill fully paid');

-- 6b. Raising a carried bill: the payment covers what it can; the rest is owed (cash up to what was paid).
select set_config('e6.c2',pg_temp.edit('c1','e6000000-0000-0000-0000-0000000000e7',pg_temp.bill('s','cash','a',6,1000))->>'billId',false);
select is((select outstanding_paise from purchase_bill_outstanding where purchase_bill_id=pg_temp.id('c2')),2000::bigint,
  'only the assigned ₹40 is carried; ₹20 is due');
select is(pg_temp.bal('s')-current_setting('e6.balc')::numeric,1000::numeric,'supplier balance = ₹60 bill - ₹50 paid');
select is((select count(*) from payments where party_id=pg_temp.id('s')),1::bigint,'still one payment after two edits');
-- The corrected cash bill stays voidable with its payment (the payment is found through edited_from_id).
select is(void_paid_purchase(pg_temp.id('c2'),'entered twice','e6000000-0000-0000-0000-0000000000f1')->>'paymentVoided','true',
  'owner voids the corrected cash bill and its carried payment together');
select is((select row(p.status,b.status)::text from payments p,purchase_bills b where p.id=pg_temp.id('pay') and b.id=pg_temp.id('c2')),
  '(VOID,VOID)','payment and corrected bill both void');
select is(pg_temp.bal('s')-current_setting('e6.balc')::numeric,0::numeric,'supplier balance back where it started');

-- 6c. A cash bill whose payment was voided: corrected only as Credit; an edit never creates a payment.
select set_config('e6.g1',pg_temp.post('e6000000-0000-0000-0000-0000000000a5',pg_temp.bill('s','cash','a',2,1000))::text,false);
select set_config('e6.gpay',(select payment_id::text from payment_allocations where purchase_bill_id=pg_temp.id('g1') and status='POSTED'),false);
select lives_ok($$select void_supplier_payment(pg_temp.id('gpay'),'wrong','e6000000-0000-0000-0000-0000000000f2')$$,'its payment is voided');
select throws_like($$select pg_temp.edit('g1','e6000000-0000-0000-0000-0000000000eb',pg_temp.bill('s','cash','a',3,1000))$$,
  '%DSB_EDIT_PAYMENT_GONE%','a paid bill without its payment cannot be re-saved as paid');
select set_config('e6.g2',pg_temp.edit('g1','e6000000-0000-0000-0000-0000000000eb',pg_temp.bill('s','credit','a',3,1000))->>'billId',false);
select is((select payment_type from purchase_bills where id=pg_temp.id('g2')),'credit','corrected as Credit');
select is((select count(*) from payments where party_id=pg_temp.id('s') and status='POSTED'),0::bigint,'no payment created by the edit');
select throws_like($$select pg_temp.edit('g2','e6000000-0000-0000-0000-0000000000ec',pg_temp.bill('s','cash','a',3,1000))$$,
  '%DSB_EDIT_PAYMENT_TYPE_CHANGED%','a credit bill cannot become paid through an edit');

-- 6d. A carried allocation is never backdated (as-of reports keep the day it was assigned).
select set_config('e6.h1',pg_temp.post('e6000000-0000-0000-0000-0000000000a6',
  pg_temp.bill('s','credit','a',1,1000)||jsonb_build_object('business_date',shop_business_date(pg_temp.id('shop'))-5))::text,false);
select set_config('e6.hpay',record_supplier_payment(pg_temp.id('shop'),pg_temp.id('s'),shop_business_date(pg_temp.id('shop'))-5,1000,'cash',null,
  '[]'::jsonb,'e6000000-0000-0000-0000-0000000000f3')::text,false);
select lives_ok($$select allocate_supplier_payment(pg_temp.id('hpay'),jsonb_build_array(jsonb_build_object('purchase_bill_id',pg_temp.id('h1'),
  'amount_paise',1000)),'e6000000-0000-0000-0000-0000000000f4')$$,'payment assigned today to a bill from 5 days ago');
select set_config('e6.h2',pg_temp.edit('h1','e6000000-0000-0000-0000-0000000000ed',
  pg_temp.bill('s','credit','a',1,1000)||jsonb_build_object('business_date',shop_business_date(pg_temp.id('shop'))-5))->>'billId',false);
select is((select effective_date from payment_allocations where purchase_bill_id=pg_temp.id('h2') and status='POSTED'),
  shop_business_date(pg_temp.id('shop')),'carried allocation keeps today, not the payment''s older date');

-- 7. Returns block an edit.
select set_config('e6.k1',pg_temp.post('e6000000-0000-0000-0000-0000000000a3',pg_temp.bill('s','credit','a',3,1000))::text,false);
select lives_ok(format($q$select post_return('PURCHASE',%L::uuid,shop_business_date(%L::uuid),'e6-ret',jsonb_build_array(jsonb_build_object(
  'purchase_bill_item_id',(select id from purchase_bill_items where purchase_bill_id=%L::uuid),'qty',1,'disposition','SUPPLIER_RETURN')),null)$q$,
  current_setting('e6.k1'),current_setting('e6.shop'),current_setting('e6.k1')),'supplier return posted');
select throws_like($$select pg_temp.edit('k1','e6000000-0000-0000-0000-0000000000e8',pg_temp.bill('s','credit','a',2,1000))$$,
  '%DSB_EDIT_BILL_HAS_RETURNS%','a bill with supplier returns cannot be edited');

-- 8. Stock already sold: removing it is refused and nothing is left half done.
select set_config('e6.d1',pg_temp.post('e6000000-0000-0000-0000-0000000000a4',pg_temp.bill('s','credit','b',5,100))::text,false);
select lives_ok(format($q$select post_sale(%L::uuid,null,null,0,0,'e6-sale',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',1,'qty',4,'price_kind','retail')),
  jsonb_build_array(jsonb_build_object('amount_paise',2000,'mode','cash')),null)$q$,current_setting('e6.shop'),current_setting('e6.b')),'4 of the 5 sold');
select set_config('e6.balk',pg_temp.bal('s')::text,false);
select throws_like($$select pg_temp.edit('d1','e6000000-0000-0000-0000-0000000000e9',pg_temp.bill('s','credit','a',1,100))$$,
  '%DSB_EDIT_STOCK_CONSUMED%E6 Dal%','removing sold stock is refused, naming the item');
select is((select row(status,replaced_by_id)::text from purchase_bills where id=pg_temp.id('d1')),'(POSTED,)','original still live after the failure');
select is((select count(*) from purchase_bills where client_id='e6000000-0000-0000-0000-0000000000e9'),0::bigint,'the corrected bill was rolled back');
select is(pg_temp.stock('b'),1::numeric,'stock unchanged by the failed edit');
select is(pg_temp.bal('s'),current_setting('e6.balk')::numeric,'supplier balance unchanged by the failed edit');
reset role;
select is((select count(*) from financial_requests where client_id='e6000000-0000-0000-0000-0000000000e9'),0::bigint,'no request stored');
set role authenticated;
-- Same quantity at a corrected rate: stock nets to zero, so it is allowed.
select set_config('e6.d2',pg_temp.edit('d1','e6000000-0000-0000-0000-0000000000ea',pg_temp.bill('s','credit','b',5,120))->>'billId',false);
select is(pg_temp.stock('b'),1::numeric,'rate-only correction keeps stock');
-- Already oversold (shop allows negative sales): its own code, nothing changes.
reset role;
update shops set allow_negative_stock=true where id=pg_temp.id('shop');
set role authenticated;
select lives_ok(format($q$select post_sale(%L::uuid,null,null,0,0,'e6-sale-2',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',1,'qty',3,'price_kind','retail')),
  jsonb_build_array(jsonb_build_object('amount_paise',1500,'mode','cash')),null)$q$,current_setting('e6.shop'),current_setting('e6.b')),'oversold to -2');
select throws_like(format($$select edit_purchase_bill(%L,'e6000000-0000-0000-0000-0000000000ee',pg_temp.bill('s','credit','b',5,140))$$,
  current_setting('e6.d2')),'%DSB_EDIT_STOCK_NEGATIVE%E6 Dal%','an item already below zero needs a stock count first');
select is(pg_temp.stock('b'),-2::numeric,'stock unchanged');
select is(pg_temp.bal('s')-current_setting('e6.balk')::numeric,100::numeric,'supplier balance moves by the rate difference');

-- 9. Links are server-set only.
reset role;
select throws_like(format($q$update purchase_bills set replaced_by_id=%L where id=%L$q$,current_setting('e6.k1'),current_setting('e6.n2')),
  '%DSB_EDIT_LINK_IMMUTABLE%','a link cannot be written outside the edit');
select throws_like(format($q$update purchase_bills set payment_type='cash' where id=%L$q$,current_setting('e6.k1')),
  '%DSB_EDIT_LINK_IMMUTABLE%','payment type cannot be changed outside the edit');
select throws_like(format($q$update purchase_bills set edited_from_id=null where id=%L$q$,current_setting('e6.n2')),
  '%DSB_EDIT_LINK_IMMUTABLE%','a link cannot be cleared');
select throws_like(format($q$insert into purchase_bills(tenant_id,shop_id,business_date,subtotal_paise,total_paise,client_id,edited_from_id)
  values(%L,%L,current_date,0,0,'e6-forged',%L)$q$,current_setting('e6.tenant'),current_setting('e6.shop'),current_setting('e6.k1')),
  '%DSB_EDIT_LINK_IMMUTABLE%','a bill cannot be inserted with a link');
select throws_like(format($q$delete from purchase_bills where id=%L$q$,current_setting('e6.n2')),'%immutable%','bills are never deleted');

-- 10. Invariants and the outcome lookup.
set role authenticated;
select pg_temp.act('e6000000-0000-0000-0000-000000000001');
select ok((check_invariants()->>'ok')::boolean,'invariants clean after edits');
select is(get_financial_request(pg_temp.id('shop'),'purchase.edit.v1','e6000000-0000-0000-0000-0000000000e1')->'result'->>'billId',
  current_setting('e6.n1'),'a lost answer is recoverable by request id');
select is(get_financial_request(pg_temp.id('shop'),'purchase.edit.v1','e6000000-0000-0000-0000-0000000000ff')->>'state','NOT_FOUND',
  'an edit never sent is NOT_FOUND');
select pg_temp.act('e6000000-0000-0000-0000-000000000003');
select throws_like($$select get_financial_request(pg_temp.id('shop'),'purchase.edit.v1','e6000000-0000-0000-0000-0000000000e1')$$,
  '%not permitted%','a cashier cannot read edit answers');

select * from finish();
rollback;
