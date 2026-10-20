-- Packet salepricing (mig 0065): typed sale prices (owner/manager only, stored per line), GST-extra invoices,
-- customer credit limits with an owner/manager override, and the unchanged old sync paths.
begin;
create extension if not exists pgtap with schema extensions;
select plan(73);
insert into auth.users(id) values
 ('e5000000-0000-0000-0000-000000000001'),  -- owner
 ('e5000000-0000-0000-0000-000000000002'),  -- manager
 ('e5000000-0000-0000-0000-000000000003');  -- cashier
create function pg_temp.act(p_user text) returns void language sql as
 $$ select set_config('request.jwt.claims',json_build_object('sub','e5000000-0000-0000-0000-00000000000'||p_user,'role','authenticated')::text,true) $$;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select current_setting('e5.'||p_key)::uuid $$;
set role authenticated;
select pg_temp.act('1');
select create_tenant('E5 Co','e5-co','E5 Shop','e5-tenant');
select register_device('e5-dev-1','test');
select set_config('e5.tenant',current_tenant_id()::text,false);
select set_config('e5.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into items(tenant_id,name,unit1,tax_rate_bp,client_id) values
 (current_tenant_id(),'Priced 18','piece',1800,'e5-a'),(current_tenant_id(),'Unpriced 5','piece',500,'e5-b');
select set_config('e5.a',(select id::text from items where client_id='e5-a'),false);
select set_config('e5.b',(select id::text from items where client_id='e5-b'),false);
select set_item_price(pg_temp.id('a'),pg_temp.id('shop'),'retail',1::smallint,1049::bigint,'e5-price-a');
select post_purchase(pg_temp.id('shop'),null,'E5-SEED','2026-09-01',0,0,'e5-seed',
 jsonb_build_array(jsonb_build_object('item_id',pg_temp.id('a'),'unit_level',1,'qty',100,'unit_price_paise',500),
   jsonb_build_object('item_id',pg_temp.id('b'),'unit_level',1,'qty',100,'unit_price_paise',500)),null);
insert into customers(tenant_id,name,client_id) values(current_tenant_id(),'Limit Customer','e5-cust'),(current_tenant_id(),'Free Customer','e5-free');
select set_config('e5.cust',(select id::text from customers where client_id='e5-cust'),false);
select set_config('e5.free',(select id::text from customers where client_id='e5-free'),false);
reset role;
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id) values
 (pg_temp.id('tenant'),'e5000000-0000-0000-0000-000000000002','manager',array[pg_temp.id('shop')],'active','e5-mgr'),
 (pg_temp.id('tenant'),'e5000000-0000-0000-0000-000000000003','cashier',array[pg_temp.id('shop')],'active','e5-cash');
set role authenticated;
select pg_temp.act('2'); select register_device('e5-dev-2','test');
select pg_temp.act('3'); select register_device('e5-dev-3','test');

-- p_item: 'a'|'b'; p_manual: typed price or null; p_expected: the list price the device saw (null = none)
create function pg_temp.ln(p_item text,p_qty text,p_manual bigint,p_disc bigint,p_expected bigint) returns jsonb language sql as $$
 select jsonb_build_object('item_id',pg_temp.id(p_item),'unit_level',1,'qty',p_qty,'price_kind','retail','discount_paise',p_disc,
   'expected_unit_price_paise',p_expected)||case when p_manual is null then '{}'::jsonb else jsonb_build_object('manual_unit_price_paise',p_manual) end $$;
create function pg_temp.sp(p_user text,p_client text,p_customer text,p_lines jsonb,p_paid bigint,p_type text,p_override boolean,
  p_expected bigint,p_bill_discount bigint default 0,p_date date default '2026-09-20') returns jsonb language plpgsql as $$
begin
 perform pg_temp.act(p_user);
 return sp_sync_post_sale('e5-dev-'||p_user,1,pg_temp.id('shop'),case when p_customer is null then null else pg_temp.id(p_customer) end,
   p_date,p_bill_discount,0,p_client,p_lines,
   case when p_paid is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('amount_paise',p_paid,'mode','cash')) end,
   null,p_type,p_override,p_expected);
end $$;
create function pg_temp.old(p_fn text,p_user text,p_client text,p_customer text,p_lines jsonb,p_paid bigint) returns jsonb language plpgsql as $$
declare r jsonb;
begin
 perform pg_temp.act(p_user);
 execute format('select %s(%L,1,%L::uuid,%s,%L,0,0,%L,%L::jsonb,%L::jsonb,null)',p_fn,'e5-dev-'||p_user,pg_temp.id('shop'),
   case when p_customer is null then 'null' else quote_literal(pg_temp.id(p_customer))||'::uuid' end,'2026-09-20',p_client,p_lines,
   case when p_paid is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('amount_paise',p_paid,'mode','cash')) end) into r;
 return r;
end $$;
create function pg_temp.inv(p_client text) returns sale_invoices language sql as $$ select * from sale_invoices where client_id=p_client $$;
create function pg_temp.line(p_client text) returns sale_invoice_items language sql as
 $$ select * from sale_invoice_items where sale_invoice_id=(select id from sale_invoices where client_id=p_client) order by line_no limit 1 $$;

-- GST maths: same golden cases as packages/core saleGst.test.ts
select is(array[sp_gst_extra_tax(1000,1800),sp_gst_extra_tax(1049,1800),sp_gst_extra_tax(25,1800),sp_gst_extra_tax(1,500),
  sp_gst_extra_tax(10,500),sp_gst_extra_tax(0,1800),sp_gst_extra_tax(9999,2800),sp_gst_extra_tax(123456789,1200),sp_gst_extra_tax(2000,0)],
  array[180,189,5,0,1,0,2800,14814815,0]::bigint[],'GST-extra tax = net x rate, rounded half up once per item');

-- Hygiene
select ok(not has_function_privilege('anon','sp_sync_post_sale(text,integer,uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text,text,boolean,bigint)','execute'),'anon cannot post sales');
select ok(not has_function_privilege('authenticated','sp_list_price(uuid,uuid,uuid,text,integer)','execute'),'list-price helper is internal');

-- List-priced sale through the new path
select lives_ok($$select pg_temp.sp('3','s-list',null,jsonb_build_array(pg_temp.ln('a','1',null,0,1049)),1000,'gst_included',false,1000)$$,'cashier sells a priced item');
select is(((pg_temp.line('s-list')).price_source,(pg_temp.line('s-list')).list_price_snapshot_paise,(pg_temp.line('s-list')).unit_price_paise),
  ('list'::text,1049::bigint,1049::bigint),'list line records its source and list price');
select is((pg_temp.line('s-list')).overridden_by,null,'nobody overrode a list price');
select is((pg_temp.inv('s-list')).invoice_type,'gst_included','default invoice type is GST included');

-- Typed prices
select lives_ok($$select pg_temp.sp('1','s-own',null,jsonb_build_array(pg_temp.ln('a','1',900,0,1049)),900,'gst_included',false,900)$$,'owner types a lower price on a priced item');
select is(((pg_temp.line('s-own')).price_source,(pg_temp.line('s-own')).unit_price_paise,(pg_temp.line('s-own')).list_price_snapshot_paise),
  ('manual'::text,900::bigint,1049::bigint),'typed price stored as sold, list price kept');
select is((pg_temp.line('s-own')).overridden_by,'e5000000-0000-0000-0000-000000000001'::uuid,'owner recorded as overriding');
select lives_ok($$select pg_temp.sp('2','s-mgr',null,jsonb_build_array(pg_temp.ln('b','2',1250,0,null)),2500,'gst_included',false,2500)$$,'manager prices an unpriced item');
select is(((pg_temp.line('s-mgr')).unit_price_paise,(pg_temp.line('s-mgr')).list_price_snapshot_paise),(1250::bigint,null::bigint),'no list price recorded for an unpriced item');
select is((pg_temp.line('s-mgr')).overridden_by,'e5000000-0000-0000-0000-000000000002'::uuid,'manager recorded');
select throws_like($$select pg_temp.sp('3','s-cash',null,jsonb_build_array(pg_temp.ln('a','1',900,0,1049)),900,'gst_included',false,900)$$,
  '%DSB_PRICE_OVERRIDE_NOT_PERMITTED%','cashier cannot type a price over an existing one');
select throws_like($$select pg_temp.sp('3','s-cash2',null,jsonb_build_array(pg_temp.ln('b','1',900,0,null)),900,'gst_included',false,900)$$,
  '%DSB_PRICE_OVERRIDE_NOT_PERMITTED%','cashier cannot price an unpriced item');
select throws_matching($$select pg_temp.sp('3','s-cash3',null,jsonb_build_array(pg_temp.ln('b','1',null,0,null)),900,'gst_included',false,900)$$,
  'sale price unavailable|offline sale price changed','cashier cannot sell an unpriced item');
select is((select count(*) from sale_invoices where client_id like 's-cash%'),0::bigint,'refused sales write nothing');
select throws_like($$select pg_temp.sp('1','s-zero',null,jsonb_build_array(pg_temp.ln('b','1',0,0,null)),0,'gst_included',false,0)$$,
  '%invalid sale line%','a typed price must be above zero');
select throws_like($$select pg_temp.sp('1','s-str',null,jsonb_build_array(pg_temp.ln('a','1',null,0,1049)||'{"manual_unit_price_paise":"900"}'),900,'gst_included',false,900)$$,
  '%invalid sale line%','a typed price must be a JSON number');
select throws_like($$select pg_temp.sp('3','s-stale',null,jsonb_build_array(pg_temp.ln('a','1',null,0,1000)),1000,'gst_included',false,1000)$$,
  '%offline sale price changed%','a list line still checks the price the device saw');

-- Old paths ignore the new fields and post exactly as before
select lives_ok($$select pg_temp.old('r0_sync_post_sale','1','o-r0',null,jsonb_build_array(pg_temp.ln('a','1',500,0,1049)),1000)$$,'old rounded path posts');
select is(((pg_temp.line('o-r0')).unit_price_paise,(pg_temp.line('o-r0')).price_source),(1049::bigint,'list'::text),'old path ignores a typed price');
select ok(not ((pg_temp.old('r0_sync_post_sale','1','o-r0',null,jsonb_build_array(pg_temp.ln('a','1',500,0,1049)),1000))->'lines'->0 ? 'taxPaise')
  and not ((pg_temp.old('r0_sync_post_sale','1','o-r0',null,jsonb_build_array(pg_temp.ln('a','1',500,0,1049)),1000)) ? 'invoiceType'),'old path answer is unchanged (replay)');
select lives_ok($$select pg_temp.old('phase5_sync_post_sale','1','o-p5',null,jsonb_build_array(pg_temp.ln('a','1',null,0,1049)),1049)$$,'oldest path posts exact paise');
select is((pg_temp.inv('o-p5')).total_paise,1049::bigint,'oldest path not rounded');
select throws_matching($$select pg_temp.old('phase5_sync_post_sale','1','o-unp',null,jsonb_build_array(pg_temp.ln('b','1',500,0,null)),500)$$,
  'sale price unavailable|offline sale price changed','old path still refuses an unpriced item even with a typed price');

-- Expected total and idempotency
select throws_like($$select pg_temp.sp('1','s-mis',null,jsonb_build_array(pg_temp.ln('a','1',null,0,1049)),1000,'gst_included',false,1049)$$,
  '%DSB_TOTAL_MISMATCH%','device total differing from the server total is refused');
reset role;
select is((select count(*) from sale_invoices where client_id='s-mis')+(select count(*) from sync_idempotency_keys where op_client_id='s-mis'),0::bigint,'mismatch writes nothing');
set role authenticated;
select is((pg_temp.sp('1','s-own',null,jsonb_build_array(pg_temp.ln('a','1',900,0,1049)),900,'gst_included',false,900))->>'saleId',
  (pg_temp.inv('s-own')).id::text,'exact replay returns the same sale');
select throws_like($$select pg_temp.sp('1','s-own',null,jsonb_build_array(pg_temp.ln('a','1',900,0,1049)),900,'gst_extra',false,900)$$,
  '%payload mismatch%','replay with another invoice type is refused');
select throws_like($$select pg_temp.sp('1','s-own',null,jsonb_build_array(pg_temp.ln('a','1',800,0,1049)),900,'gst_included',false,900)$$,
  '%payload mismatch%','replay with another typed price is refused');
select throws_like($$select pg_temp.sp('1','s-bad',null,jsonb_build_array(pg_temp.ln('a','1',null,0,1049)),1000,'gst_maybe',false,1000)$$,
  '%invalid invoice type%','unknown invoice type refused');

-- GST-extra invoice: 2 x 10.49 - 0.98 = 20.00 net, 18% = 3.60, item total 23.60; second item 5% on 12.50 = 0.63
select lives_ok($$select pg_temp.sp('1','s-gx',null,jsonb_build_array(pg_temp.ln('a','2',null,98,1049),pg_temp.ln('b','1',1250,0,null)),3700,'gst_extra',false,3700,0,'2026-09-25')$$,
  'GST-extra invoice posts');
select is(((pg_temp.inv('s-gx')).invoice_type,(pg_temp.inv('s-gx')).tax_paise),('gst_extra'::text,423::bigint),'invoice type and total tax stored');
select is((select array_agg(tax_paise order by line_no) from sale_invoice_items where sale_invoice_id=(pg_temp.inv('s-gx')).id),array[360,63]::bigint[],'tax per item');
select is((select array_agg(line_total_paise order by line_no) from sale_invoice_items where sale_invoice_id=(pg_temp.inv('s-gx')).id),array[2360,1313]::bigint[],'item totals include their GST');
select is(((pg_temp.inv('s-gx')).subtotal_paise,(pg_temp.inv('s-gx')).discount_paise,(pg_temp.inv('s-gx')).round_off_paise,(pg_temp.inv('s-gx')).total_paise),
  (3771::bigint,98::bigint,27::bigint,3700::bigint),'subtotal (incl. GST) - discount + round-off = total');
select is((pg_temp.sp('1','s-gx',null,jsonb_build_array(pg_temp.ln('a','2',null,98,1049),pg_temp.ln('b','1',1250,0,null)),3700,'gst_extra',false,3700,0,'2026-09-25'))->>'taxPaise',
  '423','answer carries the tax');
select throws_like($$select pg_temp.sp('1','s-gxd',null,jsonb_build_array(pg_temp.ln('a','1',null,0,1049)),1100,'gst_extra',false,1100,100)$$,
  '%DSB_GST_EXTRA_BILL_DISCOUNT%','bill discount refused on a GST-extra invoice');
select lives_ok($$select pg_temp.sp('1','s-gi',null,jsonb_build_array(pg_temp.ln('a','1',1180,0,1049)),1200,'gst_included',false,1200,0,'2026-09-25')$$,'GST-included sale the same day');
select pg_temp.act('1');
select results_eq($$select tax_rate_bp,taxable_sales_paise,gross_sales_paise from get_gst_summary(pg_temp.id('shop'),'2026-09-25','2026-09-25')$$,
  $$select * from (values(500,1250::bigint,1313::bigint),(1800,3000::bigint,3540::bigint)) v$$,
  'GST summary: GST-extra items exact (20.00 + 10.00 incl. 11.80 back-calculated at 18%)');
select lives_ok($$select post_return('SALE',(pg_temp.inv('s-gx')).id,'2026-09-26','r-gx',jsonb_build_array(jsonb_build_object(
   'sale_invoice_item_id',(select id from sale_invoice_items where sale_invoice_id=(pg_temp.inv('s-gx')).id and line_no=1),
   'qty',1,'disposition','RETURN_TO_SELLABLE')),null)$$,'one GST-extra item returned');
select is((select amount_paise from sale_return_items where sale_return_id=(select id from sale_returns where client_id='r-gx')),1180::bigint,'refund includes the GST charged');
select results_eq($$select tax_rate_bp,taxable_sales_paise,gross_sales_paise from get_gst_summary(pg_temp.id('shop'),'2026-09-26','2026-09-26')$$,
  $$select * from (values(1800,-1000::bigint,-1180::bigint)) v$$,'GST summary of the return: taxable and tax reversed exactly');

-- Credit limit
select pg_temp.act('3');
update customers set sale_credit_limit_paise=1 where id=pg_temp.id('cust');
select is((select sale_credit_limit_paise from customers where id=pg_temp.id('cust')),null::bigint,'cashier cannot set a credit limit');
select throws_like($$insert into customers(tenant_id,name,sale_credit_limit_paise,client_id) values(pg_temp.id('tenant'),'Cash Made',100,'e5-cm')$$,
  '%DSB_CREDIT_LIMIT_NOT_PERMITTED%','cashier cannot create a customer with a limit');
select lives_ok($$insert into customers(tenant_id,name,client_id) values(pg_temp.id('tenant'),'Cash Made',  'e5-cm')$$,'cashier creates a customer without a limit');
select pg_temp.act('1');
update customers set sale_credit_limit_paise=5000 where id=pg_temp.id('cust');
select is((select sale_credit_limit_paise from customers where id=pg_temp.id('cust')),5000::bigint,'owner sets a credit limit');
select lives_ok($$select pg_temp.sp('3','c-1','cust',jsonb_build_array(pg_temp.ln('a','3',null,0,1049)),null,'gst_included',false,3100)$$,'credit sale within the limit');
select throws_like($$select pg_temp.sp('3','c-2','cust',jsonb_build_array(pg_temp.ln('a','3',null,0,1049)),null,'gst_included',false,3100)$$,
  '%DSB_CREDIT_LIMIT_EXCEEDED%','credit sale over the limit refused');
select throws_like($$select pg_temp.sp('3','c-2','cust',jsonb_build_array(pg_temp.ln('a','3',null,0,1049)),null,'gst_included',true,3100)$$,
  '%DSB_CREDIT_OVERRIDE_NOT_PERMITTED%','cashier cannot override the limit');
select throws_like($$select pg_temp.sp('3','c-3','cust',jsonb_build_array(pg_temp.ln('a','3',null,0,1049)),1100,'gst_included',false,3100)$$,
  '%DSB_CREDIT_LIMIT_EXCEEDED%','a part-paid sale counts only its unpaid part, still over');
select lives_ok($$select pg_temp.sp('3','c-4','cust',jsonb_build_array(pg_temp.ln('a','3',null,0,1049)),3100,'gst_included',false,3100)$$,'fully paid sale to the customer is never blocked');
select lives_ok($$select pg_temp.sp('2','c-2','cust',jsonb_build_array(pg_temp.ln('a','3',null,0,1049)),null,'gst_included',true,3100)$$,'manager overrides the limit');
select is(((pg_temp.inv('c-2')).credit_override_by,(pg_temp.inv('c-2')).credit_limit_snapshot_paise,(pg_temp.inv('c-2')).credit_outstanding_snapshot_paise),
  ('e5000000-0000-0000-0000-000000000002'::uuid,5000::bigint,3100::bigint),'override, limit and outstanding are recorded');
select is((pg_temp.inv('c-1')).credit_override_by,null,'no override recorded when within the limit');
-- Every old sale path enforces the limit too, and none of them can override it.
select throws_like($$select pg_temp.old('r0_sync_post_sale','3','c-old','cust',jsonb_build_array(pg_temp.ln('a','3',null,0,1049)),null)$$,
  '%DSB_CREDIT_LIMIT_EXCEEDED%','r0_sync_post_sale refused over the limit');
select throws_like($$select pg_temp.old('phase5_sync_post_sale','3','c-old5','cust',jsonb_build_array(pg_temp.ln('a','3',null,0,1049)),null)$$,
  '%DSB_CREDIT_LIMIT_EXCEEDED%','phase5_sync_post_sale refused over the limit');
select pg_temp.act('1');
select throws_like($$select post_sale(pg_temp.id('shop'),pg_temp.id('cust'),'2026-09-20',0,0,'c-direct',jsonb_build_array(pg_temp.ln('a','1',null,0,1049)),'[]'::jsonb,null)$$,
  '%DSB_CREDIT_LIMIT_EXCEEDED%','direct post_sale refused over the limit (even for the owner)');
select throws_like($$select set_config('dsb.sale_credit_override','on',false), pg_temp.old('r0_sync_post_sale','1','c-sneak','cust',jsonb_build_array(pg_temp.ln('a','3',null,0,1049)),null)$$,
  '%DSB_CREDIT_LIMIT_EXCEEDED%','an override cannot be smuggled into an old path');
select set_config('dsb.sale_credit_override','off',false);
select lives_ok($$select pg_temp.old('r0_sync_post_sale','3','c-oldpaid','cust',jsonb_build_array(pg_temp.ln('a','3',null,0,1049)),3100)$$,'old path: fully paid sale to a limited customer posts');
select lives_ok($$select pg_temp.old('phase5_sync_post_sale','3','c-oldfree','free',jsonb_build_array(pg_temp.ln('a','3',null,0,1049)),null)$$,'old path: customer without a limit unchanged');
select pg_temp.act('1');
update customers set sale_credit_limit_paise=1000000 where id=pg_temp.id('free');
select lives_ok($$select pg_temp.old('r0_sync_post_sale','3','c-oldunder','free',jsonb_build_array(pg_temp.ln('a','3',null,0,1049)),null)$$,'old path: under the limit unchanged');
update customers set sale_credit_limit_paise=null where id=pg_temp.id('free');
select is((select count(*) from sale_invoices where client_id in ('c-old','c-old5','c-direct','c-sneak')),0::bigint,'refused old-path sales write nothing');

-- Item GST % (owner/manager only, audited)
select pg_temp.act('3');
select throws_like($$select set_item_tax_rate(pg_temp.id('b'),1200)$$,'%not permitted%','cashier cannot set an item GST rate');
select pg_temp.act('2');
select is(set_item_tax_rate(pg_temp.id('b'),1200),1200,'manager sets an item GST rate');
select throws_like($$select set_item_tax_rate(pg_temp.id('b'),10001)$$,'%invalid tax rate%','rate above 100% refused');
reset role;
select ok(exists(select 1 from audit_log where table_name='items' and row_id=pg_temp.id('b') and action='UPDATE' and (after->>'tax_rate_bp')='1200'),'GST rate change is audited');
update items set tax_rate_bp=500 where id=pg_temp.id('b');
set role authenticated;
select lives_ok($$select pg_temp.sp('3','c-free','free',jsonb_build_array(pg_temp.ln('a','3',null,0,1049)),null,'gst_included',false,3100)$$,'no limit = no check');

-- Immutability and invariants
reset role;
select throws_like($$update sale_invoices set invoice_type='gst_included' where client_id='s-gx'$$,'%immutable%','invoice type cannot change');
select throws_like($$update sale_invoices set credit_override_by=null where client_id='c-2'$$,'%immutable%','override record cannot change');
select throws_like($$update sale_invoice_items set price_source='list',overridden_by=null where client_id like 's-own:line:%'$$,'%immutable%','typed price record cannot change');
set role authenticated;
select pg_temp.act('1');
select is((check_invariants()->>'ok')::boolean,true,'invariants hold for GST-extra, typed-price and override sales');

select * from finish();
rollback;
