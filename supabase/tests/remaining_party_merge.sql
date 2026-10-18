-- Packet partymerge (mig 0062): merge a duplicate supplier into the kept one. Both suppliers' data is kept:
-- rows are re-attributed (never deleted or summed), the duplicate is archived, the move is recorded.
begin;
create extension if not exists pgtap with schema extensions;
select plan(49);
insert into auth.users(id) values
 ('e2000000-0000-0000-0000-000000000001'),  -- owner
 ('e2000000-0000-0000-0000-000000000003'),  -- cashier
 ('e2000000-0000-0000-0000-000000000004');  -- other tenant owner
create function pg_temp.act(p_user text) returns void language sql as
 $$ select set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true) $$;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select current_setting('e2.'||p_key)::uuid $$;
create function pg_temp.bill(p_key text,p_party text,p_no text,p_date date,p_price bigint) returns void language sql as $$
 select set_config('e2.'||p_key,post_purchase(pg_temp.id('shop'),pg_temp.id(p_party),p_no,p_date,0,0,'e2-'||p_key,
   jsonb_build_array(jsonb_build_object('item_id',pg_temp.id('item'),'qty','1','unit_price_paise',p_price)))::text,false) $$;
create function pg_temp.bal(p_party text) returns text language sql as $$
 select coalesce((select e->>'netLedgerBalance' from jsonb_array_elements(get_supplier_outstanding(pg_temp.id('shop'))->'parties') e
   where e->>'partyId'=pg_temp.id(p_party)::text),'0') $$;
create function pg_temp.total() returns numeric language sql as $$
 select coalesce(sum((e->>'netLedgerBalance')::numeric),0) from jsonb_array_elements(get_supplier_outstanding(pg_temp.id('shop'))->'parties') e $$;
set role authenticated;
select pg_temp.act('e2000000-0000-0000-0000-000000000001');
select create_tenant('E2 Co','e2-co','E2 Shop','e2-tenant');
select set_config('e2.tenant',current_tenant_id()::text,false);
select set_config('e2.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'E2 Item','piece','e2-item');
select set_config('e2.item',(select id::text from items where client_id='e2-item'),false);
insert into parties(tenant_id,name,phone,gstin,address,client_id) values
 (current_tenant_id(),'Ramesh Traders','9876500000','29ABCDE1234F1Z5','Old address','e2-dup'),
 (current_tenant_id(),'Ramesh Trader',null,'',' ','e2-keep');
insert into parties(tenant_id,name,client_id) values
 (current_tenant_id(),'Opening A','e2-oa'),(current_tenant_id(),'Opening B','e2-ob');
select set_config('e2.dup',(select id::text from parties where client_id='e2-dup'),false);
select set_config('e2.keep',(select id::text from parties where client_id='e2-keep'),false);
select set_config('e2.oa',(select id::text from parties where client_id='e2-oa'),false);
select set_config('e2.ob',(select id::text from parties where client_id='e2-ob'),false);
reset role;
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id) values
 (pg_temp.id('tenant'),'e2000000-0000-0000-0000-000000000003','cashier',array[pg_temp.id('shop')],'active','e2-cash');
set role authenticated;
select pg_temp.act('e2000000-0000-0000-0000-000000000004');
select create_tenant('E2 Other','e2-other','E2 Other Shop','e2-other-tenant');
select set_config('e2.foreign',(select id::text from shops where tenant_id=current_tenant_id() limit 1),false);
insert into parties(tenant_id,name,client_id) values(current_tenant_id(),'Foreign','e2-foreign');
select set_config('e2.fp',(select id::text from parties where client_id='e2-foreign'),false);
select pg_temp.act('e2000000-0000-0000-0000-000000000001');

-- table hygiene
select ok((select relrowsecurity from pg_class where relname='party_merges'),'RLS is on');
select ok(not has_table_privilege('authenticated','party_merges','insert')
      and not has_table_privilege('authenticated','party_merges','update')
      and not has_table_privilege('authenticated','party_merges','delete'),'clients cannot write merge records');

-- History on both suppliers: bills, a payment allocated to the duplicate's bill, a return, an opening, schedules.
select pg_temp.bill('bd1','dup','RT-1','2026-09-10',10000);
select pg_temp.bill('bd2','dup','RT-2','2026-09-11',5000);
select pg_temp.bill('bk1','keep','RT-1','2026-09-10',10000);
select set_config('e2.pay',record_supplier_payment(pg_temp.id('shop'),pg_temp.id('dup'),'2026-09-12',4000,'cash',null,
  jsonb_build_array(jsonb_build_object('purchase_bill_id',pg_temp.id('bd1'),'amount_paise',4000)),'e2000000-0000-0000-0000-0000000000a1')::text,false);
select lives_ok(format($q$select post_return('PURCHASE',%L::uuid,'2026-09-13','e2-ret',jsonb_build_array(jsonb_build_object(
  'purchase_bill_item_id',(select id from purchase_bill_items where purchase_bill_id=%L::uuid),'qty',1,'disposition','SUPPLIER_RETURN')),null)$q$,
  pg_temp.id('bd2'),pg_temp.id('bd2')),'duplicate gets a purchase return');
select lives_ok(format($q$select record_account_opening(%L::uuid,'SUPPLIER',%L::uuid,'2026-08-31',2000,'cutover','e2-open-d')$q$,
  pg_temp.id('shop'),pg_temp.id('dup')),'duplicate gets an opening balance');
select set_supplier_payment_schedule(pg_temp.id('shop'),pg_temp.id('dup'),5,1000,null,true,'e2-s-d');
select set_supplier_payment_schedule(pg_temp.id('shop'),pg_temp.id('keep'),7,2000,null,true,'e2-s-k');
select set_config('e2.total_before',pg_temp.total()::text,false);
select set_config('e2.sum_before',((pg_temp.bal('dup'))::numeric+(pg_temp.bal('keep'))::numeric)::text,false);

-- refusals
select pg_temp.act('e2000000-0000-0000-0000-000000000003');
select throws_like(format($$select merge_parties(%L::uuid,%L::uuid,'e2-m-cash')$$,pg_temp.id('dup'),pg_temp.id('keep')),'%not permitted%','cashier cannot merge');
select pg_temp.act('e2000000-0000-0000-0000-000000000001');
select throws_like(format($$select merge_parties(%L::uuid,%L::uuid,'e2-m-x')$$,pg_temp.id('dup'),pg_temp.id('dup')),'%DSB_INVALID_MERGE%','a supplier cannot merge into itself');
select throws_like(format($$select merge_parties(%L::uuid,%L::uuid,'  ')$$,pg_temp.id('dup'),pg_temp.id('keep')),'%DSB_INVALID_MERGE%','a request id is required');
select throws_like(format($$select merge_parties(%L::uuid,%L::uuid,'e2-m-f')$$,pg_temp.id('fp'),pg_temp.id('keep')),'%DSB_PARTY_NOT_FOUND%','another tenant''s supplier is not found');
select throws_like(format($$select merge_parties(%L::uuid,%L::uuid,'e2-m-f2')$$,pg_temp.id('dup'),pg_temp.id('fp')),'%DSB_PARTY_NOT_FOUND%','cannot merge into another tenant''s supplier');
select throws_like(format($$select set_config('dsb.party_merge',%L,true); update payments set party_id=%L::uuid where id=%L::uuid$$,
  pg_temp.id('dup')||'>'||pg_temp.id('keep'),pg_temp.id('keep'),pg_temp.id('pay')),'%permission denied%','clients cannot move a payment directly');

-- preview (old DSB showed counts and the combined outstanding before confirming)
select is((get_party_merge_preview(pg_temp.id('shop'),pg_temp.id('dup'),pg_temp.id('keep'))-'combinedBalancePaise')::text,
  '{"bills": 2, "returns": 1, "openings": 1, "payments": 1, "openingConflict": false}','preview counts what will move');
select is((get_party_merge_preview(pg_temp.id('shop'),pg_temp.id('dup'),pg_temp.id('keep'))->>'combinedBalancePaise')::numeric,
  current_setting('e2.sum_before')::numeric,'preview balance = both suppliers'' balances (bills, returns, payments, openings)');
select pg_temp.act('e2000000-0000-0000-0000-000000000003');
select throws_like(format($$select get_party_merge_preview(%L::uuid,%L::uuid,%L::uuid)$$,pg_temp.id('shop'),pg_temp.id('dup'),pg_temp.id('keep')),'%not permitted%','cashier cannot preview a merge');
select pg_temp.act('e2000000-0000-0000-0000-000000000001');

-- merge
select set_config('e2.m',merge_parties(pg_temp.id('dup'),pg_temp.id('keep'),'e2-m-1')::text,false);
select ok(pg_temp.id('m') is not null,'owner merges the duplicate into the kept supplier');
select is((select count(*)::int from purchase_bills where party_id=pg_temp.id('keep')),3,'all bills now belong to the kept supplier');
select is((select count(*)::int from purchase_bills where party_id=pg_temp.id('dup')),0,'no bill is left on the duplicate');
select is((select count(*)::int from purchase_bills where id in (pg_temp.id('bd1'),pg_temp.id('bd2'),pg_temp.id('bk1'))),3,'no bill was deleted');
select is((select party_id from payments where id=pg_temp.id('pay')),pg_temp.id('keep'),'the payment moved');
select is((select amount_paise||':'||status from payments where id=pg_temp.id('pay')),'4000:POSTED','the payment amount and status are unchanged');
select is((select count(*)::int from payment_allocations where payment_id=pg_temp.id('pay') and purchase_bill_id=pg_temp.id('bd1') and status='POSTED'),1,'the allocation is intact');
select is((select party_id from purchase_returns where client_id='e2-ret'),pg_temp.id('keep'),'the return moved');
select is((select party_id||':'||amount_paise||':'||status from account_openings where client_id='e2-open-d'),pg_temp.id('keep')||':2000:POSTED','the opening balance moved unchanged');
select is(pg_temp.total()::text,current_setting('e2.total_before'),'total supplier balance is unchanged');
select is(pg_temp.bal('keep'),current_setting('e2.sum_before'),'kept supplier balance = both balances before');
select is((select count(*)::int from parties where id=pg_temp.id('dup')),0,'the duplicate is archived (hidden)');
select is((select phone||'|'||gstin||'|'||address from parties where id=pg_temp.id('keep')),'9876500000|29ABCDE1234F1Z5|Old address',
  'contact details the kept supplier lacked are carried over');
select is((select moved->'contactCarriedOver' from party_merges where id=pg_temp.id('m')),
  '{"gstin": "29ABCDE1234F1Z5", "phone": "9876500000", "address": "Old address"}'::jsonb,'the merge record lists the carried-over details');
select is((select count(*)::int from supplier_payment_schedules where party_id=pg_temp.id('keep') and deleted_at is null),1,'one live schedule stays on the kept supplier');
select is((select count(*)::int from supplier_payment_schedules where party_id=pg_temp.id('keep')),2,'the duplicate''s schedule is kept as history');
select is((select jsonb_array_length(moved->'purchaseBills')||':'||jsonb_array_length(moved->'payments')||':'||jsonb_array_length(moved->'purchaseReturns')
  ||':'||jsonb_array_length(moved->'accountOpenings')||':'||jsonb_array_length(moved->'paymentSchedulesRemoved')||':'||source_name
  from party_merges where id=pg_temp.id('m')),'2:1:1:1:1:Ramesh Traders','the merge record lists every moved row');

-- replay and offline retries
select is(merge_parties(pg_temp.id('dup'),pg_temp.id('keep'),'e2-m-1'),pg_temp.id('m'),'replaying the merge returns the same record');
select throws_like(format($$select merge_parties(%L::uuid,%L::uuid,'e2-m-1')$$,pg_temp.id('keep'),pg_temp.id('oa')),'%DSB_PAYLOAD_MISMATCH%','a reused request id for another merge is refused');
select is(post_purchase(pg_temp.id('shop'),pg_temp.id('dup'),'RT-1','2026-09-10',0,0,'e2-bd1',
  jsonb_build_array(jsonb_build_object('item_id',pg_temp.id('item'),'qty','1','unit_price_paise',10000))),pg_temp.id('bd1'),
  'an offline purchase retry naming the duplicate is acknowledged, not rejected');
select is(record_supplier_payment(pg_temp.id('shop'),pg_temp.id('dup'),'2026-09-12',4000,'cash',null,
  jsonb_build_array(jsonb_build_object('purchase_bill_id',pg_temp.id('bd1'),'amount_paise',4000)),'e2000000-0000-0000-0000-0000000000a1'),pg_temp.id('pay'),
  'an offline payment retry naming the duplicate is acknowledged');
select set_config('e2.pay2',record_supplier_payment(pg_temp.id('shop'),pg_temp.id('dup'),'2026-09-14',700,'cash',null,
  jsonb_build_array(jsonb_build_object('purchase_bill_id',pg_temp.id('bk1'),'amount_paise',700)),'e2000000-0000-0000-0000-0000000000a3')::text,false);
select is((select party_id from payments where id=pg_temp.id('pay2')),pg_temp.id('keep'),'a payment queued for the merged supplier posts to the kept one');
reset role;
select is((select request->>'partyId' from financial_requests where client_id='e2000000-0000-0000-0000-0000000000a3'),pg_temp.id('dup')::text,'the stored request keeps the name the device sent');
set role authenticated;
select pg_temp.act('e2000000-0000-0000-0000-000000000001');
select is(record_supplier_payment(pg_temp.id('shop'),pg_temp.id('dup'),'2026-09-14',700,'cash',null,
  jsonb_build_array(jsonb_build_object('purchase_bill_id',pg_temp.id('bk1'),'amount_paise',700)),'e2000000-0000-0000-0000-0000000000a3'),pg_temp.id('pay2'),
  'its retry returns the same payment');
select throws_like(format($$select post_purchase(%L::uuid,%L::uuid,'RT-9','2026-09-14',0,0,'e2-new',jsonb_build_array(jsonb_build_object('item_id',%L,'qty','1','unit_price_paise',100)))$$,
  pg_temp.id('shop'),pg_temp.id('dup'),pg_temp.id('item')),'%party%','a new bill for the archived duplicate is refused');
select throws_like(format($$select merge_parties(%L::uuid,%L::uuid,'e2-m-2')$$,pg_temp.id('dup'),pg_temp.id('keep')),'%DSB_PARTY_ARCHIVED%','a merged supplier cannot be merged again');
select lives_ok(format($$select void_supplier_payment(%L::uuid,'entered twice','e2000000-0000-0000-0000-0000000000a2')$$,pg_temp.id('pay')),'the moved payment can still be voided normally');
select is((check_invariants()->>'ok')::boolean,true,'invariants hold after the merge');

-- self-check: identical bills are listed, never removed
select is(jsonb_array_length(get_supplier_duplicate_bills(pg_temp.id('shop'),pg_temp.id('keep'))),1,'one group of identical bills');
select ok((get_supplier_duplicate_bills(pg_temp.id('shop'),pg_temp.id('keep'))->0->'billIds')
  @> jsonb_build_array(pg_temp.id('bd1'),pg_temp.id('bk1')),'it names both identical bills');

-- opening conflict: both suppliers have a POSTED opening in the same shop
select record_account_opening(pg_temp.id('shop'),'SUPPLIER',pg_temp.id('oa'),'2026-08-31',100,'cutover','e2-open-a');
select record_account_opening(pg_temp.id('shop'),'SUPPLIER',pg_temp.id('ob'),'2026-08-31',200,'cutover','e2-open-b');
select ok((get_party_merge_preview(pg_temp.id('shop'),pg_temp.id('oa'),pg_temp.id('ob'))->>'openingConflict')::boolean,'preview warns about the opening conflict');
select throws_like(format($$select merge_parties(%L::uuid,%L::uuid,'e2-m-3')$$,pg_temp.id('oa'),pg_temp.id('ob')),'%DSB_MERGE_OPENING_CONFLICT%','two opening balances are never summed silently');
select is((select count(*)::int from parties where id=pg_temp.id('oa')),1,'a refused merge changes nothing');

-- the record itself is immutable
reset role;
select throws_like(format($$update party_merges set target_name='x' where id=%L::uuid$$,pg_temp.id('m')),'%immutable%','merge record cannot be edited');
select is((select name from parties where id=pg_temp.id('keep')),'Ramesh Trader','the kept supplier keeps its own name');
select throws_like(format($$delete from party_merges where id=%L::uuid$$,pg_temp.id('m')),'%immutable%','merge record cannot be deleted');
select * from finish();
rollback;
