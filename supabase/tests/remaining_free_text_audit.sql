-- Packet backlog (mig 0070): free-text sale lines (no item, no stock, typed price owner/manager only, GST at
-- the typed rate, unknown cost in profit, not returnable, void-safe, idempotent through sp_sync_post_sale),
-- manager audit access through the narrow audit_feed view (VIEW_AUDIT_FEED; raw audit_log stays owner-only).
begin;
create extension if not exists pgtap with schema extensions;
select plan(52);
insert into auth.users(id) values
 ('e7000000-0000-0000-0000-000000000001'),  -- owner
 ('e7000000-0000-0000-0000-000000000002'),  -- manager
 ('e7000000-0000-0000-0000-000000000003'),  -- cashier
 ('e7000000-0000-0000-0000-000000000004'),  -- accountant
 ('e7000000-0000-0000-0000-000000000005');  -- other tenant owner
create function pg_temp.act(p_user text) returns void language sql as
 $$ select set_config('request.jwt.claims',json_build_object('sub','e7000000-0000-0000-0000-00000000000'||p_user,'role','authenticated')::text,true) $$;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select current_setting('e7.'||p_key)::uuid $$;
set role authenticated;
select pg_temp.act('1');
select create_tenant('E7 Co','e7-co','E7 Shop','e7-tenant');
select register_device('e7-dev-1','test');
select set_config('e7.tenant',current_tenant_id()::text,false);
select set_config('e7.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into items(tenant_id,name,unit1,tax_rate_bp,client_id) values (current_tenant_id(),'Soap','piece',1800,'e7-a');
select set_config('e7.a',(select id::text from items where client_id='e7-a'),false);
select set_item_price(pg_temp.id('a'),pg_temp.id('shop'),'retail',1::smallint,1000::bigint,'e7-price-a');
select post_purchase(pg_temp.id('shop'),null,'E7-SEED','2026-09-01',0,0,'e7-seed',
 jsonb_build_array(jsonb_build_object('item_id',pg_temp.id('a'),'unit_level',1,'qty',10,'unit_price_paise',600)),null);
reset role;
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id) values
 (pg_temp.id('tenant'),'e7000000-0000-0000-0000-000000000002','manager',array[pg_temp.id('shop')],'active','e7-mgr'),
 (pg_temp.id('tenant'),'e7000000-0000-0000-0000-000000000003','cashier',array[pg_temp.id('shop')],'active','e7-cash'),
 (pg_temp.id('tenant'),'e7000000-0000-0000-0000-000000000004','accountant',array[pg_temp.id('shop')],'active','e7-acc');
set role authenticated;
select pg_temp.act('2'); select register_device('e7-dev-2','test');
select pg_temp.act('3'); select register_device('e7-dev-3','test');

create function pg_temp.ft(p_name text,p_qty text,p_price bigint,p_rate int,p_disc bigint default 0) returns jsonb language sql as $$
 select jsonb_build_object('free_text_name',p_name,'free_text_tax_rate_bp',p_rate,'qty',p_qty,'discount_paise',p_disc,
   'manual_unit_price_paise',p_price,'expected_unit_price_paise',null) $$;
create function pg_temp.it(p_qty text) returns jsonb language sql as $$
 select jsonb_build_object('item_id',pg_temp.id('a'),'unit_level',1,'qty',p_qty,'price_kind','retail','discount_paise',0,'expected_unit_price_paise',1000) $$;
create function pg_temp.sp(p_user text,p_client text,p_lines jsonb,p_paid bigint,p_type text,p_expected bigint) returns jsonb language plpgsql as $$
begin
 perform pg_temp.act(p_user);
 return sp_sync_post_sale('e7-dev-'||p_user,1,pg_temp.id('shop'),null,'2026-09-20',0,0,p_client,p_lines,
   jsonb_build_array(jsonb_build_object('amount_paise',p_paid,'mode','cash')),null,p_type,false,p_expected);
end $$;
create function pg_temp.inv(p_client text) returns sale_invoices language sql as $$ select * from sale_invoices where client_id=p_client $$;
create function pg_temp.ftline(p_client text) returns sale_invoice_items language sql as
 $$ select * from sale_invoice_items where sale_invoice_id=(select id from sale_invoices where client_id=p_client) and line_kind='free_text' limit 1 $$;
create function pg_temp.stock() returns numeric language sql as
 $$ select on_hand from stock_current where shop_id=pg_temp.id('shop') and item_id=pg_temp.id('a') $$;

-- Schema
select ok(not (select attnotnull from pg_attribute where attrelid='sale_invoice_items'::regclass and attname='item_id'),'item_id nullable');
select is((select count(*)::int from sale_invoice_items where line_kind is null),0,'every line has a kind');
select ok(exists(select 1 from pg_constraint where conname='sale_invoice_items_free_text_check'),'free-text check present');

-- Owner: one item line + one free-text line, GST included (price includes 18%)
select lives_ok($$select pg_temp.sp('1','ft-1',jsonb_build_array(pg_temp.it('2'),pg_temp.ft(' Gift wrap ','3','2000',1800,500)),7500,'gst_included',7500)$$,
  'owner posts an item line and a free-text line');
select is(((pg_temp.ftline('ft-1')).item_id,(pg_temp.ftline('ft-1')).item_name_snapshot,(pg_temp.ftline('ft-1')).tax_rate_bp_snapshot),
  (null::uuid,'Gift wrap'::text,1800),'free-text line: no item, trimmed name, typed GST rate');
select is(((pg_temp.ftline('ft-1')).price_source,(pg_temp.ftline('ft-1')).overridden_by,(pg_temp.ftline('ft-1')).line_total_paise),
  ('manual'::text,'e7000000-0000-0000-0000-000000000001'::uuid,5500::bigint),'typed price, owner recorded, total qty x price - discount');
select is(((pg_temp.inv('ft-1')).subtotal_paise,(pg_temp.inv('ft-1')).discount_paise,(pg_temp.inv('ft-1')).total_paise),
  (8000::bigint,500::bigint,7500::bigint),'invoice totals include the free-text line');
select is(pg_temp.stock(),8::numeric,'only the item line moved stock');
select is((select count(*)::int from stock_movements where source_id=(pg_temp.inv('ft-1')).id),1,'one stock movement for two lines');
select is((select count(*)::int from stock_movements where item_id is null),0,'no stock row without an item');

-- Replay is idempotent; same client id with a changed free-text line is refused
select is((pg_temp.sp('1','ft-1',jsonb_build_array(pg_temp.it('2'),pg_temp.ft(' Gift wrap ','3','2000',1800,500)),7500,'gst_included',7500))->>'saleId',
  (pg_temp.inv('ft-1')).id::text,'replay returns the same sale');
select is((select count(*)::int from sale_invoices where client_id='ft-1'),1,'replay wrote nothing new');
select throws_like($$select pg_temp.sp('1','ft-1',jsonb_build_array(pg_temp.it('2'),pg_temp.ft('Other name','3','2000',1800,500)),7500,'gst_included',7500)$$,
  '%payload mismatch%','changed free-text name under the same client id is refused');
select is(pg_temp.stock(),8::numeric,'replays did not move stock');

-- Roles: manager yes, cashier no (typed price rule)
select lives_ok($$select pg_temp.sp('2','ft-mgr',jsonb_build_array(pg_temp.ft('Repair','1','1000',0)),1000,'gst_included',1000)$$,'manager posts a free-text-only sale');
select is((pg_temp.ftline('ft-mgr')).overridden_by,'e7000000-0000-0000-0000-000000000002'::uuid,'manager recorded');
select throws_like($$select pg_temp.sp('3','ft-cash',jsonb_build_array(pg_temp.ft('Repair','1','1000',0)),1000,'gst_included',1000)$$,
  '%DSB_PRICE_OVERRIDE_NOT_PERMITTED%','cashier cannot add a free-text item');
select is((select count(*)::int from sale_invoices where client_id='ft-cash'),0,'nothing written for the cashier');

-- Validation
select throws_like($$select pg_temp.sp('1','ft-bad1',jsonb_build_array(pg_temp.ft('','1','1000',0)),1000,'gst_included',1000)$$,'%DSB_FREE_TEXT_INVALID%','empty name refused');
select throws_like($$select pg_temp.sp('1','ft-bad2',jsonb_build_array(pg_temp.ft(repeat('x',121),'1','1000',0)),1000,'gst_included',1000)$$,'%DSB_FREE_TEXT_INVALID%','name over 120 refused');
select throws_like($$select pg_temp.sp('1','ft-bad3',jsonb_build_array(pg_temp.ft('X','1','1000',10001)),1000,'gst_included',1000)$$,'%DSB_FREE_TEXT_INVALID%','GST over 100% refused');
select throws_like($$select pg_temp.sp('1','ft-bad4',jsonb_build_array(pg_temp.ft('X','1',null,0)),1000,'gst_included',1000)$$,'%','no typed price refused (offline price check or free-text check)');
select throws_like($$select pg_temp.sp('1','ft-bad5',jsonb_build_array(pg_temp.ft('X','1','1000',0)||jsonb_build_object('item_id',pg_temp.id('a'))),1000,'gst_included',1000)$$,
  '%DSB_FREE_TEXT_INVALID%','free-text line with an item refused');
select throws_like($$select pg_temp.sp('1','ft-bad6',jsonb_build_array(pg_temp.ft('X','1','1000',0)||jsonb_build_object('unit_level',2)),1000,'gst_included',1000)$$,
  '%DSB_FREE_TEXT_INVALID%','free-text line at another unit level refused');
select throws_like($$select pg_temp.sp('1','ft-bad7',jsonb_build_array(pg_temp.ft('X','1','1000',0)),1000,'gst_included',900)$$,'%DSB_TOTAL_MISMATCH%','device total still checked');
select is((select count(*)::int from sale_invoices where client_id like 'ft-bad%'),0,'no refused sale wrote anything');
-- Older paths never accept a free-text line (no item)
select throws_ok($$select phase5_sync_post_sale('e7-dev-1',1,pg_temp.id('shop'),null,'2026-09-20',0,0,'ft-old',
  jsonb_build_array(pg_temp.ft('X','1','1000',0)),jsonb_build_array(jsonb_build_object('amount_paise',1000,'mode','cash')),null)$$,
  null,null,'old sync path refuses a free-text line');
reset role;
select throws_like($$insert into sale_invoice_items(tenant_id,shop_id,sale_invoice_id,item_id,line_no,item_name_snapshot,tax_rate_bp_snapshot,unit_name_snapshot,unit_level,entry_mode,is_big_unit,qty,base_qty,price_kind,unit_price_paise,line_total_paise,client_id,line_kind)
  values(pg_temp.id('tenant'),pg_temp.id('shop'),(pg_temp.inv('ft-1')).id,null,99,'X',0,'unit',1,'big',true,1,1,'retail',1,1,'ft-direct','free_text')$$,
  '%sale_invoice_items_free_text_check%','a list-priced free-text row violates the check');
select throws_like($$insert into sale_invoice_items(tenant_id,shop_id,sale_invoice_id,item_id,line_no,item_name_snapshot,tax_rate_bp_snapshot,unit_name_snapshot,unit_level,entry_mode,is_big_unit,qty,base_qty,price_kind,unit_price_paise,line_total_paise,client_id)
  values(pg_temp.id('tenant'),pg_temp.id('shop'),(pg_temp.inv('ft-1')).id,null,98,'X',0,'unit',1,'big',true,1,1,'retail',1,1,'ft-direct2')$$,
  '%sale_invoice_items_free_text_check%','an item line without an item violates the check');
set role authenticated;

-- GST-extra: tax at the typed rate
select lives_ok($$select pg_temp.sp('1','ft-x',jsonb_build_array(pg_temp.ft('Labour','1','1000',500)),1100,'gst_extra',1100)$$,'GST-extra free-text sale');
select is(((pg_temp.ftline('ft-x')).tax_paise,(pg_temp.ftline('ft-x')).line_total_paise,(pg_temp.inv('ft-x')).tax_paise),
  (50::bigint,1050::bigint,50::bigint),'5% added on top of the typed price');

-- GST summary groups the line under its typed rate
select pg_temp.act('1');
select is((select gross_sales_paise from get_gst_summary(pg_temp.id('shop'),'2026-09-20','2026-09-20') where tax_rate_bp=500),1050::bigint,'GST summary has the 5% line');
select is((select gross_sales_paise from get_gst_summary(pg_temp.id('shop'),'2026-09-20','2026-09-20') where tax_rate_bp=0),1000::bigint,'GST summary has the 0% line');

-- Profit: free-text revenue is unknown-cost revenue, never profit
select is((get_profit_report(pg_temp.id('shop'),'2026-09-20','2026-09-20')->'summary'->>'unknownCostRevenuePaise')::bigint,
  (select sum(line_total_paise) from sale_invoice_items where line_kind='free_text')::bigint,'free-text revenue is reported as unknown cost');
select is((get_profit_report(pg_temp.id('shop'),'2026-09-20','2026-09-20')->'summary'->>'grossProfitPaise')::bigint,800::bigint,
  'profit counts only the item line (2 x (10.00 - 6.00))');

-- Returns: free-text line refused, item line still returnable
select throws_like(format($q$select post_return('SALE',%L::uuid,'2026-09-21','ft-ret-1',jsonb_build_array(jsonb_build_object('sale_invoice_item_id',%L,'qty',1,'disposition','RETURN_TO_SELLABLE')),'try')$q$,
  (pg_temp.inv('ft-1')).id,(pg_temp.ftline('ft-1')).id),'%DSB_FREE_TEXT_NOT_RETURNABLE%','a free-text line cannot be returned');
select lives_ok(format($q$select post_return('SALE',%L::uuid,'2026-09-21','ft-ret-2',jsonb_build_array(jsonb_build_object('sale_invoice_item_id',%L,'qty',1,'disposition','RETURN_TO_SELLABLE')),'ok')$q$,
  (pg_temp.inv('ft-1')).id,(select id from sale_invoice_items where sale_invoice_id=(pg_temp.inv('ft-1')).id and line_kind='item')),'the item line of the same bill can be returned');

-- Void: only item lines reverse stock
select lives_ok($$select void_sale((pg_temp.inv('ft-mgr')).id,'ft-void-mgr')$$,'void a free-text-only sale');
select is((pg_temp.inv('ft-mgr')).status,'VOID','voided');
select lives_ok($$select void_sale((pg_temp.inv('ft-x')).id,'ft-void-x')$$,'void a GST-extra free-text sale');
select ok((check_invariants()->>'ok')::boolean,'invariants clean with free-text lines, a return and voids');

-- Audit log: manager reads, cashier/accountant do not; remark events and price overrides appear in audit_feed
select add_document_remark(pg_temp.id('shop'),'sale',(pg_temp.inv('ft-1')).id,'Customer will pay wrap later','ft-remark-1');
select pg_temp.act('1');
select ok((select count(*) from audit_log) > 0,'owner still reads the raw audit log');
select pg_temp.act('2');
select is((select count(*)::int from audit_log),0,'manager cannot read the raw audit log (invite tokens, cost rows)');
select ok((select count(*) from audit_feed) > 0,'manager reads the audit feed');
select is((select count(*)::int from audit_feed where table_name not in ('sale_invoices','purchase_bills','payments','item_prices','items','customers','tenant_users','sale_invoice_items','document_remark_events')),0,'the feed only carries the listed tables (no invites, devices, stock or cost rows)');
select is((select count(*)::int from audit_feed where table_name='sale_invoice_items' and coalesce(after->>'price_source','')<>'manual'),0,'sale lines appear only when the price was typed');
select is((select count(*)::int from audit_feed where table_name='document_remark_events' and after->>'body'='Customer will pay wrap later'),1,'manager sees the remark event in the feed');
select ok(exists(select 1 from audit_feed where table_name='sale_invoice_items' and action='INSERT' and after->>'price_source'='manual' and after->>'line_kind'='free_text'),
  'manager sees typed-price lines in the feed');
select pg_temp.act('3');
select is((select count(*)::int from audit_feed),0,'cashier sees no feed rows');
select pg_temp.act('4');
select is((select count(*)::int from audit_feed),0,'accountant sees no feed rows');
select pg_temp.act('5');
select create_tenant('E7 Other','e7-other','E7 Other Shop','e7-other-tenant');
select is((select count(*)::int from audit_feed where tenant_id=pg_temp.id('tenant')),0,'another tenant sees nothing of this tenant');
reset role;
set role anon;
select throws_ok($$select * from audit_feed$$,'42501',null,'anon cannot read the feed');
reset role;

select * from finish();
rollback;
