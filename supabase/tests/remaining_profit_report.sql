-- Packet profit (mig 0060): read-only FIFO profit report with hand-computed expectations.
begin;
create extension if not exists pgtap with schema extensions;
select plan(27);
insert into auth.users(id) values
 ('f1000000-0000-0000-0000-000000000001'),  -- owner
 ('f1000000-0000-0000-0000-000000000002'),  -- cashier
 ('f1000000-0000-0000-0000-000000000003'),  -- accountant
 ('f1000000-0000-0000-0000-000000000004');  -- other tenant owner
create function pg_temp.act(p_user text) returns void language sql as
 $$ select set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true) $$;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select current_setting('pf.'||p_key)::uuid $$;
set role authenticated;
select pg_temp.act('f1000000-0000-0000-0000-000000000001');
select create_tenant('PF Co','pf-co','PF Shop','pf-tenant');
select set_config('pf.tenant',current_tenant_id()::text,false);
select set_config('pf.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into items(tenant_id,name,unit1,client_id) values
 (current_tenant_id(),'Item A','piece','pf-a'),(current_tenant_id(),'Item B','piece','pf-b');
select set_config('pf.a',(select id::text from items where client_id='pf-a'),false);
select set_config('pf.b',(select id::text from items where client_id='pf-b'),false);
reset role;
update shops set allow_negative_stock=true where id=pg_temp.id('shop');
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id) values
 (pg_temp.id('tenant'),'f1000000-0000-0000-0000-000000000002','cashier',array[pg_temp.id('shop')],'active','pf-cash'),
 (pg_temp.id('tenant'),'f1000000-0000-0000-0000-000000000003','accountant',array[pg_temp.id('shop')],'active','pf-acct');
insert into item_prices(tenant_id,item_id,shop_id,kind,unit_level,price_paise,effective_from,client_id) values
 (pg_temp.id('tenant'),pg_temp.id('a'),pg_temp.id('shop'),'retail',1,2000,now()-interval '1 day','pf-pa'),
 (pg_temp.id('tenant'),pg_temp.id('b'),pg_temp.id('shop'),'retail',1,1000,now()-interval '1 day','pf-pb');
-- Item B: opening stock of 5 whose cost nobody knows (legacy import / count gain).
insert into stock_movements(tenant_id,shop_id,item_id,source_type,source_id,qty_base,client_id,created_by)
 values(pg_temp.id('tenant'),pg_temp.id('shop'),pg_temp.id('b'),'ADJUSTMENT',pg_temp.id('b'),5,'pf-open-b','f1000000-0000-0000-0000-000000000001');
set role authenticated;
select pg_temp.act('f1000000-0000-0000-0000-000000000001');
create function pg_temp.buy(p_client text,p_date date,p_qty text,p_price int) returns uuid language sql as $$
 select post_purchase(pg_temp.id('shop'),null,p_client,p_date,0,0,p_client,
  jsonb_build_array(jsonb_build_object('item_id',pg_temp.id('a'),'qty',p_qty,'unit_price_paise',p_price))) $$;
create function pg_temp.sell(p_client text,p_date date,p_item text,p_qty int,p_total int) returns uuid language sql as $$
 select post_sale(pg_temp.id('shop'),null,p_date,0,0,p_client,
  jsonb_build_array(jsonb_build_object('item_id',pg_temp.id(p_item),'unit_level',1,'qty',p_qty,'price_kind','retail','discount_paise',0)),
  jsonb_build_array(jsonb_build_object('amount_paise',p_total,'mode','cash'))) $$;
create function pg_temp.rep(p_from date,p_to date) returns jsonb language sql as $$ select get_profit_report(pg_temp.id('shop'),p_from,p_to) $$;

-- Item A: two purchase layers (10 @ 10.00, 10 @ 12.00), three sales, one voided sale, one return.
-- A purchase dated BEFORE layer 1 that is then voided must not be consumed first (it would change every cost).
select lives_ok($$select set_config('pf.p0',pg_temp.buy('pf-p0','2026-08-31','5',900)::text,false)$$,'a cheap early purchase');
select lives_ok($$select void_purchase(pg_temp.id('p0'),'pf-p0-void')$$,'voided: excluded as if it never happened');
select lives_ok($$select pg_temp.buy('pf-p1','2026-09-01','10',1000)$$,'layer 1: 10 @ 10.00');
select lives_ok($$select pg_temp.buy('pf-p2','2026-09-02','10',1200)$$,'layer 2: 10 @ 12.00');
select lives_ok($$select pg_temp.sell('pf-s1','2026-09-03','a',4,8000)$$,'sale 1: 4 pcs');
select lives_ok($$select set_config('pf.s2',pg_temp.sell('pf-s2','2026-09-04','a',9,18000)::text,false)$$,'sale 2: 9 pcs');
select lives_ok($$select pg_temp.sell('pf-s3','2026-09-05','a',8,16000)$$,'sale 3: 8 pcs (one more than any layer holds)');
select lives_ok($$select pg_temp.sell('pf-b1','2026-09-04','b',3,3000)$$,'item B: 3 pcs from unknown-cost opening stock');
select lives_ok($$select set_config('pf.s4',pg_temp.sell('pf-s4','2026-09-04','a',1,2000)::text,false)$$,'a sale that will be voided');
select lives_ok($$select void_sale(pg_temp.id('s4'),'pf-s4-void')$$,'void it');

-- Full month: revenue 8000+18000+16000 = 42000; FIFO known 4000+9600+8400 = 22000; estimated 1200 (the one unit with no layer).
select is(pg_temp.rep('2026-09-01','2026-09-30')->'summary'->>'costedRevenuePaise','42000','month: costed revenue');
select is(pg_temp.rep('2026-09-01','2026-09-30')->'summary'->>'knownCostPaise','22000','month: FIFO cost from purchase layers');
select is(pg_temp.rep('2026-09-01','2026-09-30')->'summary'->>'estimatedCostPaise','1200','month: one unit estimated at the latest purchase cost');
select is(pg_temp.rep('2026-09-01','2026-09-30')->'summary'->>'grossProfitPaise','18800','month: gross profit');
select is(pg_temp.rep('2026-09-01','2026-09-30')->'summary'->>'unknownCostRevenuePaise','3000','month: item B revenue is reported apart, never as profit');
select is((select jsonb_path_query_first(pg_temp.rep('2026-09-01','2026-09-30')->'items','$[*] ? (@.name=="Item A")')->>'costOfGoodsPaise'),'23200','item A row: 22000 known + 1200 estimated');
select is((select jsonb_path_query_first(pg_temp.rep('2026-09-01','2026-09-30')->'items','$[*] ? (@.name=="Item B")')->>'unknownCostQty'),'3.000000','item B row: three units with no known cost');
-- A period that starts later still honours the older sales that used up the oldest layers (FIFO prefix).
select is(pg_temp.rep('2026-09-04','2026-09-05')->'summary'->>'knownCostPaise','18000','later period: sale 2 and 3 only, cost from the right layers');
select is(pg_temp.rep('2026-09-04','2026-09-05')->'summary'->>'grossProfitPaise','14800','later period: profit');
select is(pg_temp.rep('2026-09-03','2026-09-03')->'summary'->>'grossProfitPaise','4000','a single day: sale 1 = 8000 - 4000');
-- A return of 2 pcs of sale 2 back to sellable stock credits the original line's cost pro rata: 9600*2/9 = 2133.
select lives_ok(format($$select post_return('SALE',(select sale_invoice_id from sale_invoice_items where sale_invoice_id=%L::uuid limit 1),'2026-09-06','pf-r1',
  jsonb_build_array(jsonb_build_object('sale_invoice_item_id',(select id from sale_invoice_items where sale_invoice_id=%L::uuid),'qty',2,'disposition','RETURN_TO_SELLABLE')),null)$$,
  pg_temp.id('s2'),pg_temp.id('s2')),'return 2 pcs of sale 2');
select is(pg_temp.rep('2026-09-04','2026-09-06')->'summary'->>'netRevenuePaise','33000','with the return: net revenue 34000 - 4000 + 3000 (item B)');
select is(pg_temp.rep('2026-09-04','2026-09-06')->'summary'->>'grossProfitPaise','12933','with the return: 30000 - (15867 known + 1200 estimated)');
select is((pg_temp.rep('2026-09-04','2026-09-06')->'summary'->>'marginBp')::int,4311,'margin in basis points on costed revenue only');

-- Access and input checks.
select throws_like($$select pg_temp.rep('2026-09-05','2026-09-01')$$,'DSB_INVALID_PERIOD%','a backwards period is refused');
select pg_temp.act('f1000000-0000-0000-0000-000000000002');
select throws_like($$select pg_temp.rep('2026-09-01','2026-09-30')$$,'%not permitted%','a cashier never sees cost or profit');
select pg_temp.act('f1000000-0000-0000-0000-000000000003');
select lives_ok($$select pg_temp.rep('2026-09-01','2026-09-30')$$,'an accountant (VIEW_REPORTS) can read it');
select * from finish();
rollback;
