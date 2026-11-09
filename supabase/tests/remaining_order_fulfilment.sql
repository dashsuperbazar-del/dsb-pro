-- Packet orderfulfil (mig 0080): a READY order becomes exactly one normal sale through post_sale; holds are released
-- once; a price change or a short payment rolls everything back and the stock stays held; replay is safe.
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);
insert into auth.users(id) values ('e8000000-0000-0000-0000-000000000001'),('e8000000-0000-0000-0000-000000000003');
create function pg_temp.act(p_user text) returns void language sql as
 $$ select set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true) $$;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select current_setting('e80.'||p_key)::uuid $$;
create function pg_temp.stock() returns numeric[] language sql as
 $$ select array[on_hand,reserved] from stock_current where item_id=pg_temp.id('a') $$;
create function pg_temp.rev() returns int language sql as $$ select revision from orders where id=pg_temp.id('o') $$;

set role authenticated;
select pg_temp.act('e8000000-0000-0000-0000-000000000001');
select create_tenant('E80 Co','e80-co','E80 Shop','e80-tenant');
select set_config('e80.tenant',current_tenant_id()::text,false);
select set_config('e80.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into items(tenant_id,name,unit1,unit2,conv1,client_id) values(current_tenant_id(),'E80 Rice','bag','kg',25,'e80-a');
select set_config('e80.a',(select id::text from items where client_id='e80-a'),false);
reset role;
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id) values
 (pg_temp.id('tenant'),'e8000000-0000-0000-0000-000000000003','cashier',array[pg_temp.id('shop')],'active','e80-cash');
insert into item_prices(tenant_id,item_id,shop_id,kind,unit_level,price_paise,client_id) values
 (pg_temp.id('tenant'),pg_temp.id('a'),null,'retail',2,5000,'e80-p2'),(pg_temp.id('tenant'),pg_temp.id('a'),null,'retail',1,120000,'e80-p1');
insert into stock_movements(tenant_id,shop_id,item_id,source_type,source_id,qty_base,client_id)
 values(pg_temp.id('tenant'),pg_temp.id('shop'),pg_temp.id('a'),'ADJUSTMENT',gen_random_uuid(),10,'e80-open');
set role authenticated;
select pg_temp.act('e8000000-0000-0000-0000-000000000001');
select set_storefront_items(pg_temp.id('shop'),jsonb_build_array(jsonb_build_object('itemId',pg_temp.id('a'),'published',true)),'e80-i');
select set_storefront_settings(pg_temp.id('shop'),'{"slug":"e80-shop","displayName":"E80","enabled":true,"deliveryEnabled":true,"deliveryFeePaise":3000}','e80-s');
reset role;
set role anon;
select place_order('e80-shop','b0000000-0000-4000-8000-000000000001',repeat('7',40),'delivery',null,
  '{"name":"Ravi","phone":"9876543210","address":"1 Road"}',jsonb_build_array(jsonb_build_object('itemId',pg_temp.id('a'),'unitLevel',2,'qty','4')));
reset role;
select set_config('e80.o',(select id::text from orders where request_id='b0000000-0000-4000-8000-000000000001'),false);

set role authenticated;
select pg_temp.act('e8000000-0000-0000-0000-000000000003');
select throws_like($$ select fulfil_order(pg_temp.id('o'),1,'[{"mode":"cash","amount_paise":23000}]') $$,'%only a READY%','a NEW order cannot be handed over');
select set_order_status(pg_temp.id('o'),'CONFIRMED',1);
select set_order_status(pg_temp.id('o'),'PREPARING',2);
select set_order_status(pg_temp.id('o'),'READY',3);
select throws_like($$ select fulfil_order(pg_temp.id('o'),4,'[{"mode":"cash","amount_paise":10000}]') $$,'%fully paid%','a short payment for a walk-in is refused');
select is(pg_temp.stock(),array[10,4]::numeric[],'after a refused hand-over the stock is still held, nothing sold');
-- Price goes up before hand-over: the sale would differ from what the customer accepted.
reset role;
insert into item_prices(tenant_id,item_id,shop_id,kind,unit_level,price_paise,client_id) values
 (pg_temp.id('tenant'),pg_temp.id('a'),pg_temp.id('shop'),'retail',2,5500,'e80-p2b');
set role authenticated;
select pg_temp.act('e8000000-0000-0000-0000-000000000003');
select throws_like($$ select fulfil_order(pg_temp.id('o'),4,'[{"mode":"cash","amount_paise":25000}]') $$,'%DSB_ORDER_REQUOTE_REQUIRED%','a changed price is never hidden: re-quote required');
select is(pg_temp.stock(),array[10,4]::numeric[],'the refused re-quote changed nothing');
select is((select count(*)::int from sale_invoices where client_id='order-sale:'||pg_temp.id('o')::text),0,'no sale was kept');
reset role;
update item_prices set deleted_at=1 where client_id='e80-p2b';
set role authenticated;
select pg_temp.act('e8000000-0000-0000-0000-000000000003');
select is(fulfil_order(pg_temp.id('o'),4,'[{"mode":"cash","amount_paise":23000}]')->>'status','DELIVERED','a READY order paid in full becomes a sale');
select is(pg_temp.stock(),array[6,0]::numeric[],'stock moves by exactly 4 kg and nothing stays held');
select is((select total_paise from sale_invoices where id=(select sale_invoice_id from orders where id=pg_temp.id('o'))),23000::bigint,'sale total = items + delivery fee');
select is((select count(*)::int from stock_reservations where order_id=pg_temp.id('o') and release_reason='FULFILLED'),1,'the hold is released once as FULFILLED');
select is(fulfil_order(pg_temp.id('o'),4,'[{"mode":"cash","amount_paise":23000}]')->>'replayed','true','a repeat returns the same sale');
select is((select count(*)::int from sale_invoices where client_id='order-sale:'||pg_temp.id('o')::text),1,'still exactly one sale');
select throws_like($$ select set_order_status(pg_temp.id('o'),'CANCELLED',5,'oops') $$,'%DSB_ORDER_STEP%','a delivered order cannot be cancelled');
select pg_temp.act('e8000000-0000-0000-0000-000000000001');
select ok((check_invariants()->>'ok')::boolean,'ledger invariants hold');
reset role;
select * from finish();
rollback;
