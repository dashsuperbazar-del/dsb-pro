-- Packet profit (mig 0060): read-only FIFO profit report with hand-computed expectations.
begin;
create extension if not exists pgtap with schema extensions;
select plan(48);
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
 (current_tenant_id(),'Item A','piece','pf-a'),(current_tenant_id(),'Item B','piece','pf-b'),
 (current_tenant_id(),'Item P','piece','pf-p'),(current_tenant_id(),'Item V','piece','pf-v'),(current_tenant_id(),'Item W','piece','pf-w'),(current_tenant_id(),'Item C','piece','pf-c');
select set_config('pf.a',(select id::text from items where client_id='pf-a'),false);
select set_config('pf.b',(select id::text from items where client_id='pf-b'),false);
select set_config('pf.p',(select id::text from items where client_id='pf-p'),false);
select set_config('pf.v',(select id::text from items where client_id='pf-v'),false);
select set_config('pf.w',(select id::text from items where client_id='pf-w'),false);
select set_config('pf.c',(select id::text from items where client_id='pf-c'),false);
reset role;
update shops set allow_negative_stock=true where id=pg_temp.id('shop');
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id) values
 (pg_temp.id('tenant'),'f1000000-0000-0000-0000-000000000002','cashier',array[pg_temp.id('shop')],'active','pf-cash'),
 (pg_temp.id('tenant'),'f1000000-0000-0000-0000-000000000003','accountant',array[pg_temp.id('shop')],'active','pf-acct');
insert into item_prices(tenant_id,item_id,shop_id,kind,unit_level,price_paise,effective_from,client_id) values
 (pg_temp.id('tenant'),pg_temp.id('a'),pg_temp.id('shop'),'retail',1,2000,now()-interval '1 day','pf-pa'),
 (pg_temp.id('tenant'),pg_temp.id('b'),pg_temp.id('shop'),'retail',1,1000,now()-interval '1 day','pf-pb'),
 (pg_temp.id('tenant'),pg_temp.id('v'),pg_temp.id('shop'),'retail',1,1000,now()-interval '1 day','pf-pv'),
 (pg_temp.id('tenant'),pg_temp.id('p'),pg_temp.id('shop'),'retail',1,1000,now()-interval '1 day','pf-pp'),
 (pg_temp.id('tenant'),pg_temp.id('w'),pg_temp.id('shop'),'retail',1,1000,now()-interval '1 day','pf-pw'),
 (pg_temp.id('tenant'),pg_temp.id('c'),pg_temp.id('shop'),'retail',1,2000,now()-interval '1 day','pf-pc');
-- Item B: opening stock of 5 whose cost nobody knows (legacy import / count gain).
insert into stock_movements(tenant_id,shop_id,item_id,source_type,source_id,qty_base,client_id,created_by)
 values(pg_temp.id('tenant'),pg_temp.id('shop'),pg_temp.id('b'),'ADJUSTMENT',pg_temp.id('b'),5,'pf-open-b','f1000000-0000-0000-0000-000000000001');
set role authenticated;
select pg_temp.act('f1000000-0000-0000-0000-000000000001');
create function pg_temp.buy(p_client text,p_date date,p_qty text,p_price int) returns uuid language sql as $$
 select post_purchase(pg_temp.id('shop'),null,p_client,p_date,0,0,p_client,
  jsonb_build_array(jsonb_build_object('item_id',pg_temp.id('a'),'qty',p_qty,'unit_price_paise',p_price))) $$;
create function pg_temp.buy_item(p_client text,p_date date,p_item text,p_qty text,p_price int,p_extra int default 0) returns uuid language sql as $$
 select post_purchase(pg_temp.id('shop'),null,p_client,p_date,0,p_extra,p_client,
  jsonb_build_array(jsonb_build_object('item_id',pg_temp.id(p_item),'qty',p_qty,'unit_price_paise',p_price))) $$;
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


-- Review findings, each pinned by a number worked out by hand.
-- (1) Item V has no purchase at all: 2 pcs sold and both returned. Refunding sales that never had a cost must not show
--     up as a loss: unknown-cost revenue goes to 0 together with the net revenue, and profit stays 0.
select lives_ok($$select set_config('pf.v1',pg_temp.sell('pf-v1','2026-10-04','v',2,2000)::text,false)$$,'item V: 2 pcs sold with no purchase on record');
select lives_ok(format($$select post_return('SALE',%L::uuid,'2026-10-05','pf-vr',
  jsonb_build_array(jsonb_build_object('sale_invoice_item_id',(select id from sale_invoice_items where sale_invoice_id=%L::uuid),'qty',2,'disposition','RETURN_TO_SELLABLE')),null)$$,
  pg_temp.id('v1'),pg_temp.id('v1')),'item V: both returned the next day');
select is((select jsonb_path_query_first(pg_temp.rep('2026-10-04','2026-10-05')->'items','$[*] ? (@.name=="Item V")')->>'grossProfitPaise'),'0','V sold and returned in one period: no profit, no loss');
select is((select jsonb_path_query_first(pg_temp.rep('2026-10-05','2026-10-05')->'items','$[*] ? (@.name=="Item V")')->>'grossProfitPaise'),'0','V return alone in a later period: the refund is not booked as a loss');
select is((select jsonb_path_query_first(pg_temp.rep('2026-10-05','2026-10-05')->'items','$[*] ? (@.name=="Item V")')->>'unknownCostRevenuePaise'),'-2000','the refund reduces the unknown-cost revenue instead');
-- (2) Item W: 3 pcs sold on 10-01, but the only purchase (10 @ 5.00) is dated 10-10. A purchase dated later cannot supply
--     an earlier sale: those 3 units are ESTIMATED (at that purchase's cost), not known, and the layer stays whole.
select lives_ok($$select pg_temp.sell('pf-w1','2026-10-01','w',3,3000)$$,'item W: sold before any purchase');
select lives_ok($$select pg_temp.buy_item('pf-wp','2026-10-10','w','10',500)$$,'item W: purchase dated later');
select lives_ok($$select pg_temp.sell('pf-w2','2026-10-11','w',2,2000)$$,'item W: later sale from the 10-10 layer');
select is((select jsonb_path_query_first(pg_temp.rep('2026-10-01','2026-10-31')->'items','$[*] ? (@.name=="Item W")')->>'estimatedCostPaise'),'1500','W: the early sale is estimated (3 x 5.00), not known');
select is((select jsonb_path_query_first(pg_temp.rep('2026-10-01','2026-10-31')->'items','$[*] ? (@.name=="Item W")')->>'costOfGoodsPaise'),'2500','W: 1500 estimated + 2 x 5.00 known from the intact layer');
-- (3) Item C: 10 @ 10.00 with 5.00 freight on the bill: each unit really costs 10.50. 4 sold = 42.00.
select lives_ok($$select pg_temp.buy_item('pf-cp','2026-10-07','c','10',1000,500)$$,'item C: 10 @ 10.00 plus 5.00 freight');
select lives_ok($$select pg_temp.sell('pf-c1','2026-10-08','c',4,8000)$$,'item C: 4 sold');
select is((select jsonb_path_query_first(pg_temp.rep('2026-10-07','2026-10-08')->'items','$[*] ? (@.name=="Item C")')->>'costOfGoodsPaise'),'4200','C: freight is part of the unit cost');

-- (5) Rounding never leaks paise: 3 pieces cost 3 x 3.34 + 0.01 freight = 10.03 in total; sold one by one the three lines must
--     add up to 1003, not 3 x round(334.33) = 1002.
select lives_ok($$select pg_temp.buy_item('pf-pp1','2026-10-13','p','3',334,1)$$,'item P: 3 pieces @ 3.34 plus 0.01 freight');
select lives_ok($$select pg_temp.sell('pf-ps1','2026-10-14','p',1,1000)$$,'item P: first piece');
select lives_ok($$select pg_temp.sell('pf-ps2','2026-10-14','p',1,1000)$$,'item P: second piece');
select lives_ok($$select pg_temp.sell('pf-ps3','2026-10-14','p',1,1000)$$,'item P: third piece');
select is((select jsonb_path_query_first(pg_temp.rep('2026-10-13','2026-10-14')->'items','$[*] ? (@.name=="Item P")')->>'costOfGoodsPaise'),'1003','P: the three one-piece sales add up to the exact cost');

-- (4) The revenue allocation equals the item-sales report's: one invoice, two lines, a header discount of 3.33.
select lives_ok($$select post_sale(pg_temp.id('shop'),null,'2026-10-12',333,0,'pf-disc',
  jsonb_build_array(jsonb_build_object('item_id',pg_temp.id('a'),'unit_level',1,'qty',1,'price_kind','retail','discount_paise',0),
                    jsonb_build_object('item_id',pg_temp.id('c'),'unit_level',1,'qty',1,'price_kind','retail','discount_paise',0)),
  jsonb_build_array(jsonb_build_object('amount_paise',3667,'mode','cash')))$$,'a two-line sale with a header discount');
select is((select sum((x->>'netRevenuePaise')::bigint) from jsonb_array_elements(pg_temp.rep('2026-10-12','2026-10-12')->'items') x),
          (select sum(net_sales_paise) from get_item_sales_report(pg_temp.id('shop'),'2026-10-12','2026-10-12')),
          'profit revenue equals the item-sales report (same allocation, per item and in total)');
select is((select count(*) from get_item_sales_report(pg_temp.id('shop'),'2026-10-12','2026-10-12') r
           join jsonb_array_elements(pg_temp.rep('2026-10-12','2026-10-12')->'items') x on (x->>'itemId')::uuid=r.item_id
           and (x->>'netRevenuePaise')::bigint=r.net_sales_paise),2::bigint,'each of the two items matches individually');

-- Access and input checks.
select throws_like($$select pg_temp.rep('2026-09-05','2026-09-01')$$,'DSB_INVALID_PERIOD%','a backwards period is refused');
select pg_temp.act('f1000000-0000-0000-0000-000000000002');
select throws_like($$select pg_temp.rep('2026-09-01','2026-09-30')$$,'%not permitted%','a cashier never sees cost or profit');
select pg_temp.act('f1000000-0000-0000-0000-000000000003');
select lives_ok($$select pg_temp.rep('2026-09-01','2026-09-30')$$,'an accountant (VIEW_REPORTS) can read it');
select * from finish();
rollback;
