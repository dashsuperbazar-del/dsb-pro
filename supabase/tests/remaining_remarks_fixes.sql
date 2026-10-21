-- Packet remarksfix (mig 0068): exact edit replay (no stale edit answered as saved, no null-version bypass) and
-- set-based list_open_remarks (follows a chain of bill edits, oldest first, capped at 500).
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);
insert into auth.users(id) values
 ('e8000000-0000-0000-0000-000000000001'),  -- owner
 ('e8000000-0000-0000-0000-000000000002');  -- manager
create function pg_temp.act(p_user text) returns void language sql as
 $$ select set_config('request.jwt.claims',json_build_object('sub','e8000000-0000-0000-0000-00000000000'||p_user,'role','authenticated')::text,true) $$;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select current_setting('e8.'||p_key)::uuid $$;
create function pg_temp.bill(p_qty int) returns jsonb language sql as $$
 select jsonb_build_object('party_id',pg_temp.id('sup'),'payment_type','credit','total_paise',p_qty*1000,'round_off_paise',0,
   'lines',jsonb_build_array(jsonb_build_object('item_id',pg_temp.id('item'),'qty',p_qty::text,'unit_price_paise',1000,
     'discount_bp',0,'gst_bp',null,'line_total_paise',p_qty*1000))) $$;
create function pg_temp.add(p_kind text,p_doc text,p_body text,p_client text) returns uuid language sql as $$
 select add_document_remark(pg_temp.id('shop'),p_kind,pg_temp.id(p_doc),p_body,p_client) $$;

set role authenticated;
select pg_temp.act('1');
select create_tenant('E8 Co','e8-co','E8 Shop','e8-tenant');
select set_config('e8.tenant',current_tenant_id()::text,false);
select set_config('e8.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into items(tenant_id,name,unit1,tax_rate_bp,client_id) values(current_tenant_id(),'E8 Rice','kg',0,'e8-item');
select set_config('e8.item',(select id::text from items where client_id='e8-item'),false);
insert into parties(tenant_id,name,client_id) values(current_tenant_id(),'Laxmi Traders','e8-sup');
select set_config('e8.sup',(select id::text from parties where client_id='e8-sup'),false);
reset role;
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id) values
 (pg_temp.id('tenant'),'e8000000-0000-0000-0000-000000000002','manager',array[pg_temp.id('shop')],'active','e8-mgr');
insert into sale_invoices(id,tenant_id,shop_id,doc_no,doc_seq,business_date,subtotal_paise,total_paise,client_id) values
 ('e8000000-0000-0000-0000-0000000000a1',pg_temp.id('tenant'),pg_temp.id('shop'),'E8-1',1,'2026-10-01',1000,1000,'e8-sale');
select set_config('e8.sale','e8000000-0000-0000-0000-0000000000a1',false);

set role authenticated;
select pg_temp.act('1');
-- Edit replay is exact.
select set_config('e8.r1',pg_temp.add('sale','sale','Two packets to collect','e8-r1')::text,false);
select throws_like($$select edit_document_remark(pg_temp.id('r1'),'Three packets',null)$$,'%DSB_REMARK_STALE%',
  'an edit without an expected version is refused (no last-write-wins)');
select is((select version from document_remarks where id=pg_temp.id('r1')),1,'the null-version edit changed nothing');
select is(settle_document_remark(pg_temp.id('r1')),2,'owner settles');
select throws_like($$select edit_document_remark(pg_temp.id('r1'),'Two packets to collect',1)$$,'%DSB_REMARK_SETTLED%',
  'a settle since the expected version is not answered as a saved edit');
select is(reopen_document_remark(pg_temp.id('r1')),3,'owner reopens');
select throws_like($$select edit_document_remark(pg_temp.id('r1'),'Two packets to collect',2)$$,'%DSB_REMARK_STALE%',
  'a reopen since the expected version is not answered as a saved edit');
select is(edit_document_remark(pg_temp.id('r1'),'Three packets',3),4,'edit at the current version');
select is(edit_document_remark(pg_temp.id('r1'),'Three packets',3),4,'exact replay of the caller''s own edit is answered');
select pg_temp.act('2');
select throws_like($$select edit_document_remark(pg_temp.id('r1'),'Three packets',3)$$,'%DSB_REMARK_STALE%',
  'the same text from another person after the change is stale');
select throws_like($$select edit_document_remark(pg_temp.id('r1'),'Four packets',3)$$,'%DSB_REMARK_STALE%',
  'other text at the old version is stale');

-- Open remarks follow a chain of edits to the live bill.
select pg_temp.act('1');
select set_config('e8.b1',(post_purchase_v2(pg_temp.id('shop'),'e8000000-0000-0000-0000-0000000000c1',pg_temp.bill(10))->>'billId'),false);
select set_config('e8.p1',pg_temp.add('purchase','b1','Two bags short','e8-p1')::text,false);
select set_config('e8.b2',(edit_purchase_bill(pg_temp.id('b1'),'e8000000-0000-0000-0000-0000000000e1',pg_temp.bill(12))->>'billId'),false);
select set_config('e8.b3',(edit_purchase_bill(pg_temp.id('b2'),'e8000000-0000-0000-0000-0000000000e2',pg_temp.bill(11))->>'billId'),false);
select is((select doc_id::text||':'||doc_status from list_open_remarks(pg_temp.id('shop')) where remark_id=pg_temp.id('p1')),
  pg_temp.id('b3')::text||':POSTED','a remark on a twice-edited bill opens the live bill');

-- Cap: the 500 oldest, in order.
select count(pg_temp.add('sale','sale','Note '||g,'e8-cap-'||g)) from generate_series(1,500) g;
select is((select count(*) from list_open_remarks(pg_temp.id('shop'))),500::bigint,'at most 500 open remarks are returned');
select is((select array_agg(t.remark_id order by t.n) from list_open_remarks(pg_temp.id('shop'))
    with ordinality t(remark_id,doc_kind,doc_id,doc_no,party_name,business_date,doc_status,body,created_at,version,n)),
  (select array_agg(id) from (select id from document_remarks where status='OPEN' and shop_id=pg_temp.id('shop')
    order by created_at,id limit 500) x),
  'the 500 oldest, oldest first');
reset role;
select ok(exists(select 1 from pg_proc where oid=to_regprocedure('public.list_open_remarks(uuid)')
  and position('open_chain' in prosrc)>0 and position('dr_current_purchase(' in prosrc)=0),'list_open_remarks is set-based');

select * from finish();
rollback;
