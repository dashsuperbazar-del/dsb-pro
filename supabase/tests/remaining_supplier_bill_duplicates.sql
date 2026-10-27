-- Packet supplierbillsearch (mig 0075): find_supplier_bill_duplicates finds a repeated bill number anywhere in a
-- supplier's history (not just the latest 1,000), ignoring case/outer/inner spaces, returns VOID copies with their
-- status, stays inside the caller's tenant/shop/supplier, finds a same-total bill only within 3 days, and is
-- refused to anon and to a caller without POST_PURCHASES. It is read-only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(13);
insert into auth.users(id) values
 ('e7500000-0000-0000-0000-000000000001'),  -- owner
 ('e7500000-0000-0000-0000-000000000003'),  -- cashier
 ('e7500000-0000-0000-0000-000000000004');  -- owner of another tenant
create function pg_temp.act(p_user text) returns void language sql as
 $$ select set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true) $$;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select current_setting('e75.'||p_key)::uuid $$;
create function pg_temp.post(p_client text,p_party text,p_no text,p_date date,p_qty int) returns uuid language sql as $$
 select (post_purchase_v2(pg_temp.id('shop'),p_client,jsonb_build_object('party_id',pg_temp.id(p_party),'payment_type','credit',
   'bill_no',p_no,'business_date',p_date,'total_paise',p_qty*1000,'round_off_paise',0,
   'lines',jsonb_build_array(jsonb_build_object('item_id',pg_temp.id('a'),'qty',p_qty::text,'unit_price_paise',1000,
     'discount_bp',0,'gst_bp',null,'line_total_paise',p_qty*1000))))->>'billId')::uuid $$;
create function pg_temp.find(p_party text,p_no text,p_total bigint,p_date date) returns jsonb language sql as $$
 select find_supplier_bill_duplicates(pg_temp.id('shop'),pg_temp.id(p_party),p_no,p_total,p_date) $$;

set role authenticated;
select pg_temp.act('e7500000-0000-0000-0000-000000000004');
select create_tenant('E75 Other','e75-other','E75 Other Shop','e75-other-tenant');
select pg_temp.act('e7500000-0000-0000-0000-000000000001');
select create_tenant('E75 Co','e75-co','E75 Shop','e75-tenant');
select set_config('e75.tenant',current_tenant_id()::text,false);
select set_config('e75.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'E75 Rice','kg','e75-a');
select set_config('e75.a',(select id::text from items where client_id='e75-a'),false);
insert into parties(tenant_id,name,client_id) values(current_tenant_id(),'E75 One','e75-s'),(current_tenant_id(),'E75 Two','e75-t');
select set_config('e75.s',(select id::text from parties where client_id='e75-s'),false);
select set_config('e75.t',(select id::text from parties where client_id='e75-t'),false);
reset role;
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id) values
 (pg_temp.id('tenant'),'e7500000-0000-0000-0000-000000000003','cashier',array[pg_temp.id('shop')],'active','e75-cash');

select ok(not has_function_privilege('anon','find_supplier_bill_duplicates(uuid,uuid,text,bigint,date)','execute')
  and has_function_privilege('authenticated','find_supplier_bill_duplicates(uuid,uuid,text,bigint,date)','execute'),'anon has no access');
select ok(exists(select 1 from pg_indexes where indexname='purchase_bills_supplier_billno_idx'),'the lookup index exists');

set role authenticated;
select pg_temp.act('e7500000-0000-0000-0000-000000000001');
select set_config('e75.old',pg_temp.post('e7500000-0000-4000-8000-000000000001','s','INV-77',current_date-400,3)::text,false);
select set_config('e75.mid',pg_temp.post('e7500000-0000-4000-8000-000000000002','s','Other 1',current_date-10,4)::text,false);
select set_config('e75.tt',pg_temp.post('e7500000-0000-4000-8000-000000000003','t','INV-77',current_date-5,3)::text,false);
select set_config('e75.vd',pg_temp.post('e7500000-0000-4000-8000-000000000004','s','V-1',current_date-2,6)::text,false);
select void_purchase(pg_temp.id('vd'),'e75-void-vd');

select is(jsonb_array_length(pg_temp.find('s','INV-77',null,null)),1,'a bill number from 400 days ago is found');
select is(pg_temp.find('s','INV-77',null,null)->0->>'id',pg_temp.id('old')::text,'it is the right bill');
select is(jsonb_array_length(pg_temp.find('s','  inv-77 ',null,null)),1,'case and outer spaces are ignored');
select is(jsonb_array_length(pg_temp.find('s','Other   1',null,null)),1,'inner runs of spaces are ignored');
select is(jsonb_array_length(pg_temp.find('s','INV-78',null,null)),0,'a different number finds nothing');
select is(jsonb_array_length(pg_temp.find('s','',null,null)),0,'a blank number finds nothing');
select is(pg_temp.find('s','V-1',null,null)->0->>'status','VOID','a voided copy comes back as VOID');
select is(jsonb_array_length(pg_temp.find('s',null,4000,current_date-8)),1,'same total within 3 days is found');
select is(jsonb_array_length(pg_temp.find('s',null,4000,current_date-20)),0,'same total beyond 3 days is not');
select pg_temp.act('e7500000-0000-0000-0000-000000000003');
select throws_like($$select pg_temp.find('s','INV-77',null,null)$$,'%not permitted%','a cashier without POST_PURCHASES is refused');
select pg_temp.act('e7500000-0000-0000-0000-000000000004');
select throws_ok($$select pg_temp.find('s','INV-77',null,null)$$,null,null,'another tenant is refused');
select * from finish();
rollback;
