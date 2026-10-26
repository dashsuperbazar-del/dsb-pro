-- Packet offlinesupplierpay (mig 0074): a supplier payment saved offline is applied only if what the device read is
-- still true. Replay returns the stored answer; a changed bill/supplier, an already-paid bill, an over-payment, a zero or
-- negative amount, a cashier and another tenant are all refused with a specific code and record nothing; a merged
-- supplier is refused (never redirected); two queued payments apply in order and the second sees the first.
begin;
create extension if not exists pgtap with schema extensions;
select plan(45);
insert into auth.users(id) values
 ('e7400000-0000-0000-0000-000000000001'),  -- owner
 ('e7400000-0000-0000-0000-000000000002'),  -- manager
 ('e7400000-0000-0000-0000-000000000003'),  -- cashier
 ('e7400000-0000-0000-0000-000000000004');  -- owner of another tenant
create function pg_temp.act(p_user text) returns void language sql as
 $$ select set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true) $$;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select current_setting('e74.'||p_key)::uuid $$;
create function pg_temp.bill(p_party text,p_qty int,p_price bigint) returns jsonb language sql as $$
 select jsonb_build_object('party_id',pg_temp.id(p_party),'payment_type','credit','total_paise',p_qty*p_price,'round_off_paise',0,
   'lines',jsonb_build_array(jsonb_build_object('item_id',pg_temp.id('a'),'qty',p_qty::text,'unit_price_paise',p_price,
     'discount_bp',0,'gst_bp',null,'line_total_paise',p_qty*p_price))) $$;
create function pg_temp.post(p_client text,p_party text,p_qty int,p_price bigint) returns uuid language sql as $$
 select (post_purchase_v2(pg_temp.id('shop'),p_client,pg_temp.bill(p_party,p_qty,p_price))->>'billId')::uuid $$;
-- What the device would keep: the supplier's token and the tokens of the named bills, read now.
create function pg_temp.vers(p_party text,p_bills text[]) returns jsonb language sql as $$
 select jsonb_build_object('supplier',(select s->>'version' from jsonb_array_elements(get_supplier_pay_context(pg_temp.id('shop'))->'suppliers') s
     where s->>'partyId'=pg_temp.id(p_party)::text),
   'bills',coalesce((select jsonb_object_agg(b->>'billId',b->>'version') from jsonb_array_elements(get_supplier_pay_context(pg_temp.id('shop'))->'suppliers') s,
     jsonb_array_elements(s->'bills') b where s->>'partyId'=pg_temp.id(p_party)::text
     and (b->>'billId')::text=any(select pg_temp.id(x)::text from unnest(p_bills) x)),'{}'::jsonb)) $$;
create function pg_temp.alloc(p_bill text,p_amount bigint) returns jsonb language sql as $$
 select jsonb_build_array(jsonb_build_object('purchase_bill_id',pg_temp.id(p_bill),'amount_paise',p_amount)) $$;
create function pg_temp.pay(p_client text,p_party text,p_amount bigint,p_allocs jsonb,p_vers jsonb) returns jsonb language sql as $$
 select pay_supplier_if_unchanged(pg_temp.id('shop'),pg_temp.id(p_party),null,p_amount,'cash',null,p_allocs,p_client,p_vers) $$;
create function pg_temp.payments(p_party text) returns int language sql as $$
 select count(*)::int from payments where tenant_id=pg_temp.id('tenant') and party_id=pg_temp.id(p_party) and kind='party' $$;
create function pg_temp.owed(p_party text) returns bigint language sql as $$
 select (s->>'owedPaise')::bigint from jsonb_array_elements(get_supplier_pay_context(pg_temp.id('shop'))->'suppliers') s
 where s->>'partyId'=pg_temp.id(p_party)::text $$;

set role authenticated;
select pg_temp.act('e7400000-0000-0000-0000-000000000004');
select create_tenant('E74 Other','e74-other','E74 Other Shop','e74-other-tenant');
select set_config('e74.oshop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
select pg_temp.act('e7400000-0000-0000-0000-000000000001');
select create_tenant('E74 Co','e74-co','E74 Shop','e74-tenant');
select set_config('e74.tenant',current_tenant_id()::text,false);
select set_config('e74.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'E74 Rice','kg','e74-a');
select set_config('e74.a',(select id::text from items where client_id='e74-a'),false);
insert into parties(tenant_id,name,client_id) values
 (current_tenant_id(),'E74 Traders','e74-s'),(current_tenant_id(),'E74 Dal Co','e74-t'),(current_tenant_id(),'E74 Dup','e74-d'),
 (current_tenant_id(),'E74 Keep','e74-k'),(current_tenant_id(),'E74 Unused','e74-u'),(current_tenant_id(),'E74 Void Co','e74-v');
select set_config('e74.s',(select id::text from parties where client_id='e74-s'),false);
select set_config('e74.t',(select id::text from parties where client_id='e74-t'),false);
select set_config('e74.d',(select id::text from parties where client_id='e74-d'),false);
select set_config('e74.k',(select id::text from parties where client_id='e74-k'),false);
select set_config('e74.u',(select id::text from parties where client_id='e74-u'),false);
select set_config('e74.v',(select id::text from parties where client_id='e74-v'),false);
reset role;
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id) values
 (pg_temp.id('tenant'),'e7400000-0000-0000-0000-000000000003','cashier',array[pg_temp.id('shop')],'active','e74-cash'),
 (pg_temp.id('tenant'),'e7400000-0000-0000-0000-000000000002','manager',array[pg_temp.id('shop')],'active','e74-mgr');

select ok(not has_function_privilege('anon','pay_supplier_if_unchanged(uuid,uuid,date,bigint,text,text,jsonb,text,jsonb)','execute')
  and not has_function_privilege('anon','get_supplier_pay_context(uuid)','execute')
  and has_function_privilege('authenticated','pay_supplier_if_unchanged(uuid,uuid,date,bigint,text,text,jsonb,text,jsonb)','execute')
  and not has_function_privilege('authenticated','obp_bill_version(uuid,uuid)','execute')
  and not has_function_privilege('authenticated','obp_supplier_version(uuid,uuid)','execute')
  and not has_function_privilege('authenticated','obp_owed(uuid,uuid)','execute'),'anon has no access; the version and owed bodies are internal');

set role authenticated;
select pg_temp.act('e7400000-0000-0000-0000-000000000001');
select set_config('e74.b1',pg_temp.post('e7400000-0000-4000-8000-0000000000a1','s',10,1000)::text,false);  -- 10000
select set_config('e74.b2',pg_temp.post('e7400000-0000-4000-8000-0000000000a2','s',5,1000)::text,false);   -- 5000
select set_config('e74.c1',pg_temp.post('e7400000-0000-4000-8000-0000000000a3','t',4,1000)::text,false);   -- 4000
select set_config('e74.d1',pg_temp.post('e7400000-0000-4000-8000-0000000000a4','d',3,1000)::text,false);   -- 3000
select set_config('e74.k1',pg_temp.post('e7400000-0000-4000-8000-0000000000a5','k',2,1000)::text,false);   -- 2000
select set_config('e74.v1',pg_temp.post('e7400000-0000-4000-8000-0000000000a6','v',6,1000)::text,false);   -- 6000

-- 1. Context: owner reads suppliers with owed, tokens and open bills; unused supplier has none.
select is(pg_temp.owed('s'),15000::bigint,'context: owed is the net ledger balance');
select is((select jsonb_array_length(s->'bills') from jsonb_array_elements(get_supplier_pay_context(pg_temp.id('shop'))->'suppliers') s
  where s->>'partyId'=pg_temp.id('s')::text),2,'context: two open bills');
select ok(get_supplier_pay_context(pg_temp.id('shop'))->>'businessDate' ~ '^\d{4}-\d{2}-\d{2}$','context carries the shop business date');
select set_config('e74.v_s',pg_temp.vers('s',array['b1','b2'])::text,false);
select set_config('e74.v_t',pg_temp.vers('t',array['c1'])::text,false);
select set_config('e74.v_d',pg_temp.vers('d',array['d1'])::text,false);
select set_config('e74.v_k',pg_temp.vers('k',array['k1'])::text,false);
select set_config('e74.v_u',pg_temp.vers('u',array[]::text[])::text,false);
select set_config('e74.v_v',pg_temp.vers('v',array['v1'])::text,false);
select ok(current_setting('e74.v_s')::jsonb->>'supplier' ~ '^[0-9a-f]{32}$','supplier token is an md5');

-- 2. Role and tenant checks.
select pg_temp.act('e7400000-0000-0000-0000-000000000003');
select throws_like($$select get_supplier_pay_context(pg_temp.id('shop'))$$,'%not permitted%','cashier cannot read the pay context');
select throws_like($$select pg_temp.pay('e7400000-0000-4000-8000-0000000000b0','s',1000,'[]'::jsonb,current_setting('e74.v_s')::jsonb)$$,
  '%not permitted%','cashier cannot pay a supplier');
select pg_temp.act('e7400000-0000-0000-0000-000000000004');
select throws_ok($$select pg_temp.pay('e7400000-0000-4000-8000-0000000000b1','s',1000,'[]'::jsonb,current_setting('e74.v_s')::jsonb)$$,
  null,null,'another tenant cannot pay this shop''s supplier');
select throws_ok($$select pay_supplier_if_unchanged(pg_temp.id('oshop'),pg_temp.id('s'),null,1000,'cash',null,'[]'::jsonb,
  'e7400000-0000-4000-8000-0000000000b2',current_setting('e74.v_s')::jsonb)$$,null,null,'another tenant''s own shop cannot pay a supplier it does not have');
select throws_ok($$select get_supplier_pay_context(pg_temp.id('shop'))$$,null,null,'another tenant cannot read the pay context');

-- 3. Input rules.
select pg_temp.act('e7400000-0000-0000-0000-000000000002');
select throws_like($$select pg_temp.pay('e7400000-0000-4000-8000-0000000000c1','s',0,'[]'::jsonb,current_setting('e74.v_s')::jsonb)$$,'DSB_INVALID_AMOUNT%','zero refused');
select throws_like($$select pg_temp.pay('e7400000-0000-4000-8000-0000000000c2','s',-5,'[]'::jsonb,current_setting('e74.v_s')::jsonb)$$,'DSB_INVALID_AMOUNT%','negative refused');
select throws_like($$select pay_supplier_if_unchanged(pg_temp.id('shop'),pg_temp.id('s'),null,100,'barter',null,'[]'::jsonb,
  'e7400000-0000-4000-8000-0000000000c3',current_setting('e74.v_s')::jsonb)$$,'DSB_INVALID_MODE%','bad mode refused');
select throws_like($$select pg_temp.pay('E7400000-0000-4000-8000-0000000000C4','s',100,'[]'::jsonb,current_setting('e74.v_s')::jsonb)$$,'DSB_INVALID_REQUEST_ID%','upper-case request id refused');
select throws_like($$select pg_temp.pay('e7400000-0000-4000-8000-0000000000c5','s',100,'[]'::jsonb,'{}'::jsonb)$$,'DSB_INVALID_REQUEST%','missing versions refused');
select throws_like($$select pg_temp.pay('e7400000-0000-4000-8000-0000000000c6','s',100,pg_temp.alloc('b1',100),
  jsonb_build_object('supplier',current_setting('e74.v_s')::jsonb->>'supplier'))$$,'DSB_INVALID_REQUEST%','an assigned bill without its version is refused');
select throws_like($$select pay_supplier_if_unchanged(pg_temp.id('shop'),pg_temp.id('s'),current_date+30,100,'cash',null,'[]'::jsonb,
  'e7400000-0000-4000-8000-0000000000c7',current_setting('e74.v_s')::jsonb)$$,'DSB_FUTURE_DATE%','a future date is refused');
select throws_like($$select pg_temp.pay('e7400000-0000-4000-8000-0000000000c8','s',16000,'[]'::jsonb,current_setting('e74.v_s')::jsonb)$$,
  'DSB_PAYMENT_EXCEEDS_OWED%','more than is owed refused');
select throws_like($$select pg_temp.pay('e7400000-0000-4000-8000-0000000000c9','s',20000,pg_temp.alloc('b2',6000),current_setting('e74.v_s')::jsonb)$$,
  'DSB_ALLOCATION_EXCEEDS_BILL%','more than the bill still owes refused');
select is(pg_temp.payments('s'),0,'refusals recorded nothing');

-- 4. Apply with an allocation; replay returns the stored answer; a different payload under the same id is refused.
select set_config('e74.r1',pg_temp.pay('e7400000-0000-4000-8000-0000000000d1','s',6000,pg_temp.alloc('b1',6000),current_setting('e74.v_s')::jsonb)::text,false);
select is(pg_temp.payments('s'),1,'payment recorded');
select is((select outstanding_paise from purchase_bill_outstanding where purchase_bill_id=pg_temp.id('b1')),4000::bigint,'bill outstanding reduced');
select is(pg_temp.pay('e7400000-0000-4000-8000-0000000000d1','s',6000,pg_temp.alloc('b1',6000),current_setting('e74.v_s')::jsonb)::text,
  current_setting('e74.r1'),'exact replay returns the stored answer');
select is(pg_temp.payments('s'),1,'replay recorded nothing new');
select throws_like($$select pg_temp.pay('e7400000-0000-4000-8000-0000000000d1','s',6100,pg_temp.alloc('b1',6100),current_setting('e74.v_s')::jsonb)$$,
  '%already used for a different request%','same id with another amount refused');
select is(get_financial_request(pg_temp.id('shop'),'supplier.pay.offline.v1','e7400000-0000-4000-8000-0000000000d1')->>'state','COMMITTED','request status is readable');
select is(get_financial_request(pg_temp.id('shop'),'supplier.pay.offline.v1','e7400000-0000-4000-8000-0000000000d1')->'result'->>'paymentId',
  current_setting('e74.r1')::jsonb->>'paymentId','request status carries the payment id');

-- 5. Two queued payments for the same bill: the second sees the first (same read-time tokens, no "changed").
select lives_ok($$select pg_temp.pay('e7400000-0000-4000-8000-0000000000d2','s',4000,pg_temp.alloc('b1',4000),current_setting('e74.v_s')::jsonb)$$,
  'second payment to the same bill applies (it fits what is left)');
select throws_like($$select pg_temp.pay('e7400000-0000-4000-8000-0000000000d3','s',100,pg_temp.alloc('b1',100),current_setting('e74.v_s')::jsonb)$$,
  'DSB_BILL_ALREADY_PAID%','a bill already paid by earlier payments is refused');
select is(pg_temp.owed('s'),5000::bigint,'owed after two payments');
-- Unassigned payments: the second one cannot exceed what is left owed.
select lives_ok($$select pg_temp.pay('e7400000-0000-4000-8000-0000000000d4','s',3000,'[]'::jsonb,current_setting('e74.v_s')::jsonb)$$,'unassigned payment within what is owed applies');
select throws_like($$select pg_temp.pay('e7400000-0000-4000-8000-0000000000d5','s',2500,'[]'::jsonb,current_setting('e74.v_s')::jsonb)$$,
  'DSB_PAYMENT_EXCEEDS_OWED%','the next one sees the earlier one and is refused when it would exceed what is owed');

-- 6. A bill voided after the device read it: refused, never moved to another bill.
select void_purchase(pg_temp.id('c1'),'e74-void-c1');
select throws_like($$select pg_temp.pay('e7400000-0000-4000-8000-0000000000e1','t',1000,pg_temp.alloc('c1',1000),current_setting('e74.v_t')::jsonb)$$,
  'DSB_BILL_CHANGED%','voided bill refused');
-- 7. A bill edited (replaced) after the device read it.
select set_config('e74.r_edit',edit_purchase_bill(pg_temp.id('v1'),'e7400000-0000-4000-8000-0000000000f1',pg_temp.bill('v',7,1000))::text,false);
select throws_like($$select pg_temp.pay('e7400000-0000-4000-8000-0000000000e2','v',1000,pg_temp.alloc('v1',1000),current_setting('e74.v_v')::jsonb)$$,
  'DSB_BILL_CHANGED%','edited (replaced) bill refused');
-- 8. A bill of another supplier named by the device.
select throws_like($$select pg_temp.pay('e7400000-0000-4000-8000-0000000000e3','k',500,pg_temp.alloc('b2',500),
  jsonb_build_object('supplier',current_setting('e74.v_k')::jsonb->>'supplier','bills',jsonb_build_object(pg_temp.id('b2')::text,
   (current_setting('e74.v_s')::jsonb->'bills')->>(pg_temp.id('b2')::text))))$$,'DSB_BILL_CHANGED%','a bill of another supplier is refused');
-- 9. A stale supplier token.
select throws_like($$select pg_temp.pay('e7400000-0000-4000-8000-0000000000e4','k',500,'[]'::jsonb,
  jsonb_build_object('supplier',repeat('0',32)))$$,'DSB_SUPPLIER_CHANGED%','a stale supplier token is refused');
-- 10. A supplier merged after the device read it: refused for the merged-away name, nothing moved.
select pg_temp.act('e7400000-0000-0000-0000-000000000001');
select merge_parties(pg_temp.id('d'),pg_temp.id('k'),'e74-merge-d-k');
select throws_like($$select pg_temp.pay('e7400000-0000-4000-8000-0000000000e5','d',1000,pg_temp.alloc('d1',1000),current_setting('e74.v_d')::jsonb)$$,
  'DSB_SUPPLIER_MERGED%','a merged supplier is refused, not redirected');
select is(pg_temp.payments('d')+pg_temp.payments('k'),0,'nothing was recorded for either supplier');
select lives_ok($$select pg_temp.pay('e7400000-0000-4000-8000-0000000000e6','k',1000,pg_temp.alloc('k1',1000),current_setting('e74.v_k')::jsonb)$$,
  'a payment to the kept supplier on its own unchanged bill still applies');
-- 11. A supplier archived after the device read it (only a supplier without history can be archived).
select archive_party(pg_temp.id('u'));
select throws_like($$select pg_temp.pay('e7400000-0000-4000-8000-0000000000e7','u',100,'[]'::jsonb,current_setting('e74.v_u')::jsonb)$$,
  'DSB_SUPPLIER_ARCHIVED%','an archived supplier is refused');
select ok(not exists(select 1 from jsonb_array_elements(get_supplier_pay_context(pg_temp.id('shop'))->'suppliers') s
  where s->>'partyId' in (pg_temp.id('u')::text,pg_temp.id('d')::text)),'archived and merged-away suppliers are not offered');
-- 12. Supplier id of a supplier that does not exist in this tenant.
select throws_like($$select pay_supplier_if_unchanged(pg_temp.id('shop'),'e7400000-0000-4000-8000-0000000000ee',null,100,'cash',null,'[]'::jsonb,
  'e7400000-0000-4000-8000-0000000000e8',current_setting('e74.v_s')::jsonb)$$,'DSB_SUPPLIER_UNAVAILABLE%','an unknown supplier is refused');

-- 13. A payment applied before a later change is still answered by replay (never refused as stale).
select is(pg_temp.pay('e7400000-0000-4000-8000-0000000000d1','s',6000,pg_temp.alloc('b1',6000),current_setting('e74.v_s')::jsonb)::text,
  current_setting('e74.r1'),'replay still returns the stored answer after the bill was fully paid');
select is((select count(*)::int from payments where tenant_id=pg_temp.id('tenant') and kind='party'),4,'exactly four supplier payments exist');
select is((select coalesce(sum(amount_paise),0)::bigint from payments where tenant_id=pg_temp.id('tenant') and kind='party' and status='POSTED'),14000::bigint,
  'recorded total is exactly the accepted payments');

select * from finish();
rollback;
