-- Packet billcode (mig 0069): every purchase bill and sale invoice gets a server-made, unique-per-shop,
-- immutable bill code by trigger alone; the posting functions and all money are unchanged.
begin;
create extension if not exists pgtap with schema extensions;
select plan(53);
insert into auth.users(id) values
 ('c9000000-0000-0000-0000-000000000001'),  -- owner of shop 1
 ('c9000000-0000-0000-0000-000000000002');  -- owner of shop 2 (another tenant)
create function pg_temp.act(p_user text) returns void language sql as
 $$ select set_config('request.jwt.claims',json_build_object('sub','c9000000-0000-0000-0000-00000000000'||p_user,'role','authenticated')::text,true) $$;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select current_setting('c9.'||p_key)::uuid $$;
create function pg_temp.bill(p_item text,p_sup text,p_qty int) returns jsonb language sql as $$
 select jsonb_build_object('party_id',pg_temp.id(p_sup),'payment_type','credit','total_paise',p_qty*1000,'round_off_paise',0,
   'lines',jsonb_build_array(jsonb_build_object('item_id',pg_temp.id(p_item),'qty',p_qty::text,'unit_price_paise',1000,
     'discount_bp',0,'gst_bp',null,'line_total_paise',p_qty*1000))) $$;
create function pg_temp.line(p_item text,p_qty text) returns jsonb language sql as $$
 select jsonb_build_object('item_id',pg_temp.id(p_item),'unit_level',1,'qty',p_qty,'price_kind','retail','discount_paise',0,
   'expected_unit_price_paise',1500) $$;
create function pg_temp.sale(p_dev text,p_client text,p_qty text) returns jsonb language plpgsql as $$
begin
 return sp_sync_post_sale(p_dev,1,pg_temp.id('shop'),null,'2026-09-20',0,0,p_client,jsonb_build_array(pg_temp.line('item',p_qty)),
   jsonb_build_array(jsonb_build_object('amount_paise',(p_qty::int)*1500,'mode','cash')),null,'gst_included',false,(p_qty::int)*1500);
end $$;
create function pg_temp.oldsale(p_fn text,p_client text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
 execute format('select %s(%L,1,%L::uuid,null,%L,0,0,%L,%L::jsonb,%L::jsonb,null)',p_fn,'c9-dev-1',pg_temp.id('shop'),'2026-09-20',p_client,
   jsonb_build_array(pg_temp.line('item','1')),jsonb_build_array(jsonb_build_object('amount_paise',1500,'mode','cash'))) into r;
 return r;
end $$;
create function pg_temp.stock() returns numeric language sql as
 $$ select coalesce((select qty_base from stock_current where item_id=pg_temp.id('item') and shop_id=pg_temp.id('shop')),0) $$;
create function pg_temp.owed() returns bigint language sql as
 $$ select coalesce(sum(outstanding_paise),0)::bigint from purchase_bill_outstanding where purchase_bill_id in
    (select id from purchase_bills where shop_id=pg_temp.id('shop') and status='POSTED') $$;

-- Shop 1
set role authenticated;
select pg_temp.act('1');
select create_tenant('C9 Co','c9-co','C9 Shop','c9-tenant');
select register_device('c9-dev-1','test');
select set_config('c9.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into items(tenant_id,name,unit1,tax_rate_bp,client_id) values(current_tenant_id(),'C9 Rice','kg',0,'c9-item');
select set_config('c9.item',(select id::text from items where client_id='c9-item'),false);
insert into parties(tenant_id,name,client_id) values(current_tenant_id(),'C9 Supplier','c9-sup');
select set_config('c9.sup',(select id::text from parties where client_id='c9-sup'),false);
select set_item_price(pg_temp.id('item'),pg_temp.id('shop'),'retail',1::smallint,1500::bigint,'c9-price');
reset role;
select set_config('c9.tenant',(select id::text from tenants where slug='c9-co'),false);

select ok(not has_function_privilege('authenticated','dsb_new_bill_code(uuid,boolean)','execute')
  and not has_function_privilege('anon','dsb_new_bill_code(uuid,boolean)','execute')
  and not has_function_privilege('authenticated','dsb_bill_code_candidate()','execute')
  and not has_function_privilege('authenticated','dsb_bill_code_guard()','execute'),'the generator and guard are server-only');
select ok((select bool_and(attnotnull) from pg_attribute where attname='bill_code' and attnum>0
  and attrelid in ('purchase_bills'::regclass,'sale_invoices'::regclass)),'bill_code is NOT NULL on both tables');

-- Purchase paths (v2 and the old post_purchase) and sale paths (sp, phase5, r0) each produce a code.
set role authenticated;
select pg_temp.act('1');
select set_config('c9.b1',(post_purchase_v2(pg_temp.id('shop'),'c9000000-0000-0000-0000-0000000000b1',pg_temp.bill('item','sup',10))->>'billId'),false);
select is(pg_temp.stock(),10::numeric,'purchase: stock is the quantity bought');
select is(pg_temp.owed(),10000::bigint,'purchase: the supplier is owed exactly the bill');
select is((select total_paise from purchase_bills where id=pg_temp.id('b1')),10000::bigint,'purchase: bill total is exact');
select set_config('c9.b2',(post_purchase(pg_temp.id('shop'),pg_temp.id('sup'),'C9-OLD','2026-09-01',0,0,'c9-old-client',
  jsonb_build_array(jsonb_build_object('item_id',pg_temp.id('item'),'unit_level',1,'qty',5,'unit_price_paise',1000)),null))::text,false);
select is(pg_temp.stock(),15::numeric,'old purchase path: stock unchanged by the code');
select set_config('c9.s1',(pg_temp.sale('c9-dev-1','c9-sale-1','2')->>'saleId'),false);
select is((select total_paise from sale_invoices where id=pg_temp.id('s1')),3000::bigint,'sale: invoice total is exact');
select is(pg_temp.stock(),13::numeric,'sale: stock fell by the quantity sold');
select is((select sum(amount_paise)::bigint from payments where source_sale_invoice_id=pg_temp.id('s1') and status='POSTED'),3000::bigint,
  'sale: the receipt equals the sale');
select lives_ok($$select pg_temp.oldsale('phase5_sync_post_sale','c9-sale-p5')$$,'oldest sale path posts');
select lives_ok($$select pg_temp.oldsale('r0_sync_post_sale','c9-sale-r0')$$,'rounded sale path posts');
select is(pg_temp.stock(),11::numeric,'old sale paths: stock exact');
reset role;

select is((select count(*) from purchase_bills where shop_id=pg_temp.id('shop') and bill_code ~ '^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$'),
  (select count(*) from purchase_bills where shop_id=pg_temp.id('shop')),'every purchase bill has a code in the format');
select is((select count(*) from sale_invoices where shop_id=pg_temp.id('shop') and bill_code ~ '^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$'),
  (select count(*) from sale_invoices where shop_id=pg_temp.id('shop')),'every sale invoice has a code in the format');
select is((select count(*) from purchase_bills where shop_id=pg_temp.id('shop')),2::bigint,'two purchase bills posted');
select is((select count(*) from sale_invoices where shop_id=pg_temp.id('shop')),3::bigint,'three sale invoices posted');
select is((select count(distinct c) from (select bill_code c from purchase_bills where shop_id=pg_temp.id('shop')
  union all select bill_code from sale_invoices where shop_id=pg_temp.id('shop')) x),5::bigint,
  'the five documents have five different codes (shared between bills and invoices)');
select ok(not exists(select 1 from purchase_bills where bill_code ~ '[01ILO]' union all select 1 from sale_invoices where bill_code ~ '[01ILO]'),
  'no ambiguous characters (0 O 1 I L)');

-- Retry returns the same document and so the same code
select set_config('c9.code_b1',(select bill_code from purchase_bills where id=pg_temp.id('b1')),false);
select set_config('c9.code_s1',(select bill_code from sale_invoices where id=pg_temp.id('s1')),false);
set role authenticated;
select pg_temp.act('1');
select is((post_purchase_v2(pg_temp.id('shop'),'c9000000-0000-0000-0000-0000000000b1',pg_temp.bill('item','sup',10))->>'billId')::uuid,pg_temp.id('b1'),
  'purchase retry answers the same bill');
select is((pg_temp.sale('c9-dev-1','c9-sale-1','2')->>'saleId')::uuid,pg_temp.id('s1'),'sale retry answers the same invoice');
select is(pg_temp.stock(),11::numeric,'retries moved no stock');
select is(pg_temp.owed(),15000::bigint,'retries added no debt');
reset role;
select is((select bill_code from purchase_bills where id=pg_temp.id('b1')),current_setting('c9.code_b1'),'purchase code unchanged by the retry');
select is((select bill_code from sale_invoices where id=pg_temp.id('s1')),current_setting('c9.code_s1'),'sale code unchanged by the retry');
select is((select count(*) from purchase_bills where shop_id=pg_temp.id('shop'))+(select count(*) from sale_invoices where shop_id=pg_temp.id('shop')),5::bigint,
  'retries made no new document');

-- Immutable
select throws_like($$update purchase_bills set bill_code='ZZZZ-ZZZZ' where id=pg_temp.id('b1')$$,'%DSB_BILL_CODE_IMMUTABLE%','a purchase code cannot be changed');
select throws_like($$update sale_invoices set bill_code='ZZZZ-ZZZZ' where id=pg_temp.id('s1')$$,'%immutable%','a finalized sale is refused any change, the code included');
alter table sale_invoices disable trigger sale_invoice_guard;
select throws_like($$update sale_invoices set bill_code='ZZZZ-ZZZZ' where id=pg_temp.id('s1')$$,'%DSB_BILL_CODE_IMMUTABLE%','a sale code cannot be changed even without the older guard');
alter table sale_invoices enable trigger sale_invoice_guard;
select throws_like($$update purchase_bills set bill_code=null where id=pg_temp.id('b1')$$,'%DSB_BILL_CODE_IMMUTABLE%','a code cannot be cleared');
set role authenticated;
select pg_temp.act('1');
select throws_like($$update purchase_bills set bill_code='ZZZZ-ZZZZ' where id=pg_temp.id('b1')$$,'%permission denied%','a client has no write access to the code');
select ok((select bool_and(bill_code is not null) from purchase_bills),'a client reads the codes of its own bills');
select void_sale(pg_temp.id('s1'),'c9-void-1');
select is(pg_temp.stock(),13::numeric,'voiding a sale still restores its stock exactly');
reset role;
select is((select bill_code from sale_invoices where id=pg_temp.id('s1')),current_setting('c9.code_s1'),'a voided invoice keeps its code');
-- a supplied code is ignored on insert
insert into sale_invoices(id,tenant_id,shop_id,doc_no,doc_seq,business_date,subtotal_paise,total_paise,client_id,bill_code) values
 ('c9000000-0000-0000-0000-0000000000a1',pg_temp.id('tenant'),pg_temp.id('shop'),'C9-1',1,'2026-10-01',1000,1000,'c9-direct','ZZZZ-ZZZZ');
select isnt((select bill_code from sale_invoices where client_id='c9-direct'),'ZZZZ-ZZZZ','a code supplied by the caller is replaced by a server code');

-- Unique per shop (index backstop): with the guard off, a duplicate in the same shop is refused
alter table purchase_bills disable trigger purchase_bills_bill_code;
select throws_ok($$update purchase_bills set bill_code=(select bill_code from purchase_bills where id=pg_temp.id('b2')) where id=pg_temp.id('b1')$$,
  '23505',null,'two purchase bills of a shop cannot share a code');
alter table purchase_bills enable trigger purchase_bills_bill_code;
alter table sale_invoices disable trigger user;
select throws_ok($$update sale_invoices set bill_code=(select bill_code from sale_invoices where client_id='c9-sale-p5') where client_id='c9-sale-r0'$$,
  '23505',null,'two sale invoices of a shop cannot share a code');
alter table sale_invoices enable trigger user;

-- Collision handling (candidate source replaced inside this rolled-back transaction)
create or replace function public.dsb_bill_code_candidate() returns text language plpgsql as $f$
declare v_list text[] := string_to_array(current_setting('zz.cands'),',');
        v_i integer := coalesce(nullif(current_setting('zz.i',true),''),'0')::integer + 1;
begin
 perform set_config('zz.i',v_i::text,false);
 return v_list[least(v_i,array_length(v_list,1))];
end $f$;
select set_config('zz.cands','CCCC-2222',false); select set_config('zz.i','0',false);
set role authenticated; select pg_temp.act('1');
select set_config('c9.b3',(post_purchase_v2(pg_temp.id('shop'),'c9000000-0000-0000-0000-0000000000b3',pg_temp.bill('item','sup',1))->>'billId'),false);
reset role;
select is((select bill_code from purchase_bills where id=pg_temp.id('b3')),'CCCC-2222','the candidate becomes the code when it is free');
select set_config('zz.cands','CCCC-2222,CCCC-2222,DDDD-3333',false); select set_config('zz.i','0',false);
set role authenticated; select pg_temp.act('1');
select set_config('c9.s2',(pg_temp.sale('c9-dev-1','c9-sale-2','1')->>'saleId'),false);
reset role;
select is((select bill_code from sale_invoices where id=pg_temp.id('s2')),'DDDD-3333',
  'a taken candidate (even one used by a purchase bill) is skipped and the next free one is used');
select is(current_setting('zz.i'),'3','the generator tried three candidates');
select set_config('zz.cands','CCCC-2222',false); select set_config('zz.i','0',false);
set role authenticated; select pg_temp.act('1');
select throws_like($$select post_purchase_v2(pg_temp.id('shop'),'c9000000-0000-0000-0000-0000000000b4',pg_temp.bill('item','sup',3))$$,
  '%DSB_BILL_CODE_EXHAUSTED%','a generator that only finds taken codes fails with its own error');
reset role;
select is((select count(*) from purchase_bills where client_id='c9000000-0000-0000-0000-0000000000b4'),0::bigint,'the failed post left no bill behind');
select is((select qty_base from stock_current where item_id=pg_temp.id('item') and shop_id=pg_temp.id('shop')),13::numeric,
  'the failed post left no stock behind');

-- Shop 2 (another tenant) may use a code that shop 1 already has, and cannot see shop 1's documents
set role authenticated; select pg_temp.act('2');
select create_tenant('C9b Co','c9b-co','C9b Shop','c9b-tenant');
select set_config('c9.shop2',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into items(tenant_id,name,unit1,tax_rate_bp,client_id) values(current_tenant_id(),'C9b Rice','kg',0,'c9b-item');
select set_config('c9.item2',(select id::text from items where client_id='c9b-item'),false);
insert into parties(tenant_id,name,client_id) values(current_tenant_id(),'C9b Supplier','c9b-sup');
select set_config('c9.sup2',(select id::text from parties where client_id='c9b-sup'),false);
select set_config('zz.cands','CCCC-2222',false); select set_config('zz.i','0',false);
select set_config('c9.o1',(post_purchase_v2(pg_temp.id('shop2'),'c9000000-0000-0000-0000-0000000000d1',
  jsonb_build_object('party_id',pg_temp.id('sup2'),'payment_type','credit','total_paise',1000,'round_off_paise',0,
   'lines',jsonb_build_array(jsonb_build_object('item_id',pg_temp.id('item2'),'qty','1','unit_price_paise',1000,'discount_bp',0,'gst_bp',null,'line_total_paise',1000))))->>'billId'),false);
select is((select bill_code from purchase_bills where id=pg_temp.id('o1')),'CCCC-2222','the same code can exist in another shop');
select is((select count(*) from purchase_bills),1::bigint,'RLS: shop 2 sees only its own bills');
select ok(not exists(select 1 from purchase_bills where id=pg_temp.id('b1')),'RLS: shop 2 cannot read shop 1 codes');
reset role;

-- Search by code: case and dashes ignored, partial from 4 characters, only the caller's own shop
select set_config('c9.cb',(select bill_code from purchase_bills where id=pg_temp.id('b1')),false);
select set_config('c9.cs',(select bill_code from sale_invoices where id=pg_temp.id('s1')),false);
set role authenticated; select pg_temp.act('1');
select is((select id from find_bills_by_code(pg_temp.id('shop'),lower(replace(current_setting('c9.cb'),'-','')))),pg_temp.id('b1'),
  'a full code in lower case without the dash finds the purchase bill');
select is((select count(*) from find_bills_by_code(pg_temp.id('shop'),lower(substr(current_setting('c9.cb'),3,5)))),
  (select count(*) from (select bill_code from purchase_bills union all select bill_code from sale_invoices) x
   where replace(x.bill_code,'-','') like '%'||upper(replace(substr(current_setting('c9.cb'),3,5),'-',''))||'%'),
  'a part that crosses the dash is found (4 characters, any case)');
select is((select kind||':'||id from find_bills_by_code(pg_temp.id('shop'),current_setting('c9.cs')) limit 1),'sale:'||pg_temp.id('s1'),
  'a sale invoice is found by its code, exact code first');
select is((select count(*) from find_bills_by_code(pg_temp.id('shop'),substr(current_setting('c9.cb'),1,3))),0::bigint,
  'three characters find nothing');
select is((select count(*) from find_bills_by_code(pg_temp.id('shop'),'')),0::bigint,'an empty query finds nothing');
select pg_temp.act('2');
select is((select count(*) from find_bills_by_code(pg_temp.id('shop'),current_setting('c9.cb'))),0::bigint,
  'another tenant cannot find a code of this shop');
reset role;

-- Export carries the code
select pg_temp.act('1');
set role authenticated;
select ok((select bool_and(e ? 'bill_code') from jsonb_array_elements(phase6_export_tenant(pg_temp.id('shop'))->'purchases') e),
  'the business export carries bill_code on purchases');
select ok((select bool_and(e ? 'bill_code') from jsonb_array_elements(phase6_export_tenant(pg_temp.id('shop'))->'sales') e),
  'the business export carries bill_code on sales');
reset role;
select * from finish();
rollback;
