-- Packet remarks (mig 0067): pending remarks on purchase bills and sale invoices. Append-only history written by
-- a trigger, idempotent add by client id, stale edits refused, owner/manager-only reopen, cross-shop and
-- cross-tenant refusal, remarks follow bill edits (0066) without moving rows, export coverage.
begin;
create extension if not exists pgtap with schema extensions;
select plan(51);
insert into auth.users(id) values
 ('e7000000-0000-0000-0000-000000000001'),  -- owner
 ('e7000000-0000-0000-0000-000000000002'),  -- manager
 ('e7000000-0000-0000-0000-000000000003'),  -- cashier (shop A only)
 ('e7000000-0000-0000-0000-000000000004'),  -- owner of another tenant
 ('e7000000-0000-0000-0000-000000000005');  -- accountant (shop A only)
create function pg_temp.act(p_user text) returns void language sql as
 $$ select set_config('request.jwt.claims',json_build_object('sub','e7000000-0000-0000-0000-00000000000'||p_user,'role','authenticated')::text,true) $$;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select current_setting('e7.'||p_key)::uuid $$;
create function pg_temp.bill(p_qty int) returns jsonb language sql as $$
 select jsonb_build_object('party_id',pg_temp.id('sup'),'payment_type','credit','total_paise',p_qty*1000,'round_off_paise',0,
   'lines',jsonb_build_array(jsonb_build_object('item_id',pg_temp.id('item'),'qty',p_qty::text,'unit_price_paise',1000,
     'discount_bp',0,'gst_bp',null,'line_total_paise',p_qty*1000))) $$;
create function pg_temp.add(p_kind text,p_doc text,p_body text,p_client text,p_shop text default 'shop') returns uuid language sql as $$
 select add_document_remark(pg_temp.id(p_shop),p_kind,pg_temp.id(p_doc),p_body,p_client) $$;

set role authenticated;
select pg_temp.act('4');
select create_tenant('E7 Other','e7-other','E7 Other Shop','e7-other-tenant');
select pg_temp.act('1');
select create_tenant('E7 Co','e7-co','E7 Shop','e7-tenant');
select set_config('e7.tenant',current_tenant_id()::text,false);
select set_config('e7.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into items(tenant_id,name,unit1,tax_rate_bp,client_id) values(current_tenant_id(),'E7 Sugar','kg',0,'e7-item');
select set_config('e7.item',(select id::text from items where client_id='e7-item'),false);
insert into parties(tenant_id,name,client_id) values(current_tenant_id(),'Shankar Traders','e7-sup');
select set_config('e7.sup',(select id::text from parties where client_id='e7-sup'),false);
reset role;
insert into shops(id,tenant_id,name,created_by) values
 ('e7000000-0000-0000-0000-0000000000b0',pg_temp.id('tenant'),'E7 Second Shop','e7000000-0000-0000-0000-000000000001');
select set_config('e7.shopb','e7000000-0000-0000-0000-0000000000b0',false);
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id) values
 (pg_temp.id('tenant'),'e7000000-0000-0000-0000-000000000003','cashier',array[pg_temp.id('shop')],'active','e7-cash'),
 (pg_temp.id('tenant'),'e7000000-0000-0000-0000-000000000002','manager',array[pg_temp.id('shop')],'active','e7-mgr'),
 (pg_temp.id('tenant'),'e7000000-0000-0000-0000-000000000005','accountant',array[pg_temp.id('shop')],'active','e7-acct');
insert into sale_invoices(id,tenant_id,shop_id,doc_no,doc_seq,business_date,subtotal_paise,total_paise,client_id) values
 ('e7000000-0000-0000-0000-0000000000a1',pg_temp.id('tenant'),pg_temp.id('shop'),'E7-1',1,'2026-10-01',1000,1000,'e7-sale-a'),
 ('e7000000-0000-0000-0000-0000000000a2',pg_temp.id('tenant'),pg_temp.id('shopb'),'E7-B1',1,'2026-10-01',1000,1000,'e7-sale-b');
select set_config('e7.sale','e7000000-0000-0000-0000-0000000000a1',false);
select set_config('e7.saleb','e7000000-0000-0000-0000-0000000000a2',false);

-- Hygiene
select ok((select relrowsecurity from pg_class where relname='document_remarks')
  and (select relrowsecurity from pg_class where relname='document_remark_events'),'RLS is on for both tables');
select ok(not has_table_privilege('authenticated','document_remarks','insert,update,delete')
  and not has_table_privilege('authenticated','document_remark_events','insert,update,delete')
  and not has_table_privilege('anon','document_remarks','select'),'clients cannot write remarks or history directly');
select ok(has_table_privilege('authenticated','document_remarks','select')
  and has_table_privilege('authenticated','document_remark_events','select'),'clients read through RLS');
select ok(not has_function_privilege('anon','add_document_remark(uuid,text,uuid,text,text)','execute')
  and not has_function_privilege('anon','settle_document_remark(uuid)','execute')
  and not has_function_privilege('anon','list_open_remarks(uuid)','execute')
  and not has_function_privilege('authenticated','dr_remark_history()','execute')
  and not has_function_privilege('authenticated','dr_lock_remark(uuid)','execute')
  and has_function_privilege('authenticated','reopen_document_remark(uuid)','execute'),'anon has no access; helpers are internal');

set role authenticated;
select pg_temp.act('1');
select set_config('e7.b1',(post_purchase_v2(pg_temp.id('shop'),'e7000000-0000-0000-0000-0000000000c1',pg_temp.bill(10))->>'billId'),false);

-- Cashier: sale remarks only, own shop only. Idempotent add.
select pg_temp.act('3');
select set_config('e7.r1',pg_temp.add('sale','sale','  Customer will collect 2 kg sugar tomorrow ','e7-r1')::text,false);
select is((select row(doc_kind,sale_invoice_id::text,body,status,version)::text from document_remarks where id=pg_temp.id('r1')),
  format('(sale,%s,"Customer will collect 2 kg sugar tomorrow",OPEN,1)',pg_temp.id('sale')),'cashier adds a sale remark (trimmed, open, v1)');
select is(pg_temp.add('sale','sale','Customer will collect 2 kg sugar tomorrow','e7-r1'),pg_temp.id('r1'),'same id + same text returns the same remark');
select throws_like($$select pg_temp.add('sale','sale','other text','e7-r1')$$,'%DSB_PAYLOAD_MISMATCH%','same id with other text is refused');
select is((select count(*) from document_remarks where client_id='e7-r1'),1::bigint,'retries made no extra remark');
select throws_like($$select pg_temp.add('purchase','b1','5 kg short','e7-x1')$$,'%not permitted%','cashier cannot remark on purchase bills');
select throws_like($$select pg_temp.add('sale','saleb','note','e7-x2','shopb')$$,'%not permitted%','cashier cannot remark in another shop');
select throws_like($$select pg_temp.add('sale','saleb','note','e7-x3')$$,'%DSB_REMARK_DOC_NOT_FOUND%','a document of another shop is refused');
select throws_like($$select pg_temp.add('sale','sale','   ','e7-x4')$$,'%DSB_INVALID_REMARK%','an empty remark is refused');
select throws_like($$select pg_temp.add('sale','sale',repeat('x',301),'e7-x5')$$,'%DSB_INVALID_REMARK%','a remark over 300 characters is refused');
select throws_like($$select pg_temp.add('bill','sale','x','e7-x6')$$,'%DSB_INVALID_REMARK%','an unknown document kind is refused');
select throws_like(format($$insert into document_remarks(tenant_id,shop_id,doc_kind,sale_invoice_id,body,client_id) values(%L,%L,'sale',%L,'x','e7-direct')$$,
  pg_temp.id('tenant'),pg_temp.id('shop'),pg_temp.id('sale')),'%permission denied%','direct insert is refused');

-- Settle (anyone who can see it), idempotent; reopen owner/manager only.
select is(settle_document_remark(pg_temp.id('r1')),2,'cashier settles (items handed over)');
select is(settle_document_remark(pg_temp.id('r1')),2,'settling again changes nothing');
select is((select row(status,settled_by::text)::text from document_remarks where id=pg_temp.id('r1')),
  '(SETTLED,e7000000-0000-0000-0000-000000000003)','settled by the cashier');
select throws_like($$select reopen_document_remark(pg_temp.id('r1'))$$,'%not permitted%','cashier cannot reopen');
select throws_like($$select edit_document_remark(pg_temp.id('r1'),'changed',2)$$,'%DSB_REMARK_SETTLED%','a settled remark cannot be edited');
select pg_temp.act('2');
select is(reopen_document_remark(pg_temp.id('r1')),3,'manager reopens');
select is((select row(status,settled_by,settled_at)::text from document_remarks where id=pg_temp.id('r1')),'(OPEN,,)','reopen clears the settlement');
select is(reopen_document_remark(pg_temp.id('r1')),3,'reopening an open remark changes nothing');

-- Edits: versioned, stale refused, exact retry safe, every earlier text kept.
select throws_like($$select edit_document_remark(pg_temp.id('r1'),'Customer will collect 3 kg',2)$$,'%DSB_REMARK_STALE%','a stale edit is refused (no last-write-wins)');
select is(edit_document_remark(pg_temp.id('r1'),'Customer will collect 3 kg',3),4,'manager edits at the current version');
select is(edit_document_remark(pg_temp.id('r1'),'Customer will collect 3 kg',3),4,'exact retry of the edit is safe');
select is((select string_agg(version||':'||action||':'||status||':'||body,'|' order by version) from document_remark_events where remark_id=pg_temp.id('r1')),
  '1:ADD:OPEN:Customer will collect 2 kg sugar tomorrow|2:SETTLE:SETTLED:Customer will collect 2 kg sugar tomorrow|3:REOPEN:OPEN:Customer will collect 2 kg sugar tomorrow|4:EDIT:OPEN:Customer will collect 3 kg',
  'history keeps every step and the earlier text');
select is((select string_agg(actor::text,',' order by version) from document_remark_events where remark_id=pg_temp.id('r1')),
  'e7000000-0000-0000-0000-000000000003,e7000000-0000-0000-0000-000000000003,e7000000-0000-0000-0000-000000000002,e7000000-0000-0000-0000-000000000002',
  'history records who did each step');
select is(pg_temp.add('sale','sale','Ask for the empty crate back','e7-r2')::text is not null,true,'manager adds a sale remark');
select set_config('e7.r2',(select id::text from document_remarks where client_id='e7-r2'),false);
select pg_temp.act('3');
select throws_like($$select edit_document_remark(pg_temp.id('r2'),'mine now',1)$$,'%not permitted%','cashier cannot edit someone else''s remark');

-- History and remarks are immutable even for the database owner role.
reset role;
select throws_like(format($$update document_remark_events set body='x' where remark_id=%L$$,pg_temp.id('r1')),'%DSB_REMARK_HISTORY_IMMUTABLE%','history cannot be changed');
select throws_like(format($$delete from document_remark_events where remark_id=%L$$,pg_temp.id('r1')),'%DSB_REMARK_HISTORY_IMMUTABLE%','history cannot be deleted');
select throws_like(format($$delete from document_remarks where id=%L$$,pg_temp.id('r1')),'%DSB_REMARK_IMMUTABLE%','a remark cannot be deleted');
select throws_like(format($$update document_remarks set sale_invoice_id=%L,version=version+1 where id=%L$$,pg_temp.id('saleb'),pg_temp.id('r1')),
  '%DSB_REMARK_IMMUTABLE%','a remark cannot move to another document');
select throws_like(format($$update document_remarks set body='silent' where id=%L$$,pg_temp.id('r1')),'%DSB_REMARK_IMMUTABLE%','a change without a version step is refused');

-- Purchase remarks follow bill edits (0066) without moving rows.
set role authenticated;
select pg_temp.act('1');
select set_config('e7.p1',pg_temp.add('purchase','b1','5 kg sugar short, supplier to send','e7-p1')::text,false);
select set_config('e7.b2',(edit_purchase_bill(pg_temp.id('b1'),'e7000000-0000-0000-0000-0000000000e1',pg_temp.bill(12))->>'billId'),false);
select is((select string_agg(remark_id::text||':'||from_earlier_bill,',') from list_document_remarks('purchase',pg_temp.id('b2'))),
  pg_temp.id('p1')||':true','the corrected bill shows the remark written on the original');
select is((select doc_id from list_open_remarks(pg_temp.id('shop')) where remark_id=pg_temp.id('p1')),pg_temp.id('b2'),'Home opens the corrected bill');
select is((select purchase_bill_id from document_remarks where id=pg_temp.id('p1')),pg_temp.id('b1'),'the remark row still names the original bill');
select is((select array_agg(t.remark_id order by t.n) from list_open_remarks(pg_temp.id('shop'))
    with ordinality t(remark_id,doc_kind,doc_id,doc_no,party_name,business_date,doc_status,body,created_at,version,n)),
  (select array_agg(id order by created_at,id) from document_remarks where status='OPEN' and shop_id=pg_temp.id('shop')),
  'open remarks come oldest first');
select is((select count(*) from list_open_remarks(pg_temp.id('shop'))),3::bigint,'three open remarks (two sale, one purchase)');

-- Cashier never sees purchase remarks; accountant can add them.
select pg_temp.act('3');
select is((select count(*) from document_remarks where doc_kind='purchase'),0::bigint,'cashier cannot read purchase remarks');
select is((select count(*) from list_open_remarks(pg_temp.id('shop')) where doc_kind='purchase'),0::bigint,'cashier Home shows no purchase remarks');
select is((select count(*) from list_document_remarks('purchase',pg_temp.id('b2'))),0::bigint,'cashier cannot list a bill''s remarks');
select throws_like($$select settle_document_remark(pg_temp.id('p1'))$$,'%DSB_REMARK_NOT_FOUND%','cashier cannot settle a purchase remark');
select pg_temp.act('5');
select is(pg_temp.add('purchase','b2','Rate difference to claim','e7-a1') is not null,true,'accountant adds a purchase remark');

-- Another tenant sees and changes nothing.
select pg_temp.act('4');
select is((select count(*) from document_remarks)+(select count(*) from document_remark_events),0::bigint,'other tenant reads no remarks or history');
select throws_like($$select settle_document_remark(pg_temp.id('p1'))$$,'%DSB_REMARK_NOT_FOUND%','other tenant cannot settle');
select throws_like($$select pg_temp.add('sale','sale','x','e7-o1')$$,'%not permitted%','other tenant cannot add to our shop');
select throws_like($$select list_open_remarks(pg_temp.id('shop'))$$,'%not permitted%','other tenant cannot list our open remarks');

-- Export carries remarks and their full history.
select pg_temp.act('1');
select is(jsonb_array_length(phase6_export_tenant(pg_temp.id('shop'))->'documentRemarks'),4,'export carries the shop''s remarks');
select is(jsonb_array_length(phase6_export_tenant(pg_temp.id('shop'))->'documentRemarkEvents'),7,'export carries every history step');

select * from finish();
rollback;
