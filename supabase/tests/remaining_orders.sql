-- Packet orders (mig 0079): an online order holds stock and never moves it; a POS sale can never take held stock
-- even with negative stock allowed; replays need the same token; cancel/expiry release exactly once; delivery fee,
-- minimum and slots are server rules; anon sees only its own order status; rate limit; staff steps are checked.
begin;
create extension if not exists pgtap with schema extensions;
select plan(31);
insert into auth.users(id) values ('e7900000-0000-0000-0000-000000000001'),('e7900000-0000-0000-0000-000000000003');
create function pg_temp.act(p_user text) returns void language sql as
 $$ select set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true) $$;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select current_setting('e79.'||p_key)::uuid $$;
create function pg_temp.lines(p_qty text) returns jsonb language sql as
 $$ select jsonb_build_array(jsonb_build_object('itemId',pg_temp.id('a'),'unitLevel',2,'qty',p_qty)) $$;
create function pg_temp.res() returns numeric language sql as
 $$ select reserved from stock_current where item_id=pg_temp.id('a') $$;
create function pg_temp.tok(n int) returns text language sql as $$ select repeat(n::text,40) $$;

set role authenticated;
select pg_temp.act('e7900000-0000-0000-0000-000000000001');
select create_tenant('E79 Co','e79-co','E79 Shop','e79-tenant');
select set_config('e79.tenant',current_tenant_id()::text,false);
select set_config('e79.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into items(tenant_id,name,unit1,unit2,conv1,client_id) values(current_tenant_id(),'E79 Rice','bag','kg',25,'e79-a');
select set_config('e79.a',(select id::text from items where client_id='e79-a'),false);
reset role;
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id) values
 (pg_temp.id('tenant'),'e7900000-0000-0000-0000-000000000003','cashier',array[pg_temp.id('shop')],'active','e79-cash');
insert into item_prices(tenant_id,item_id,shop_id,kind,unit_level,price_paise,client_id) values
 (pg_temp.id('tenant'),pg_temp.id('a'),null,'retail',2,5000,'e79-p2'),(pg_temp.id('tenant'),pg_temp.id('a'),null,'retail',1,120000,'e79-p1');
insert into stock_movements(tenant_id,shop_id,item_id,source_type,source_id,qty_base,client_id)
 values(pg_temp.id('tenant'),pg_temp.id('shop'),pg_temp.id('a'),'ADJUSTMENT',gen_random_uuid(),10,'e79-open');
update shops set allow_negative_stock=true where id=pg_temp.id('shop');
set role authenticated;
select pg_temp.act('e7900000-0000-0000-0000-000000000001');
select set_storefront_items(pg_temp.id('shop'),jsonb_build_array(jsonb_build_object('itemId',pg_temp.id('a'),'published',true)),'e79-i');
select set_storefront_settings(pg_temp.id('shop'),'{"slug":"e79-shop","displayName":"E79","enabled":true,"deliveryEnabled":true,"deliveryFeePaise":3000,"minOrderPaise":5000,"freeDeliveryAbovePaise":30000,"deliverySlots":["9-11 am"]}','e79-s');
reset role;

set role anon;
select is(place_order('e79-shop','a0000000-0000-4000-8000-000000000001',pg_temp.tok(1),'pickup',null,
  '{"name":"Ravi","phone":"98765 43210"}',pg_temp.lines('4'))->>'totalPaise','20000','the server prices the order (4 kg x 50)');
reset role;
select is(pg_temp.res(),4::numeric,'4 kg are held');
select is((select on_hand from stock_current where item_id=pg_temp.id('a')),10::numeric,'no stock moved');
select is((select count(*)::int from stock_movements where item_id=pg_temp.id('a')),1,'no stock movement written');
set role anon;
select is(place_order('e79-shop','a0000000-0000-4000-8000-000000000001',pg_temp.tok(1),'pickup',null,
  '{"name":"Ravi","phone":"98765 43210"}',pg_temp.lines('4'))->>'replayed','true','a replay returns the same order');
reset role;
select is(pg_temp.res(),4::numeric,'a replay holds nothing more');
set role anon;
select throws_like($$ select place_order('e79-shop','a0000000-0000-4000-8000-000000000001',pg_temp.tok(2),'pickup',null,'{"name":"X","phone":"9876543210"}',pg_temp.lines('1')) $$,'%already used%','a replay with another token is refused');
select throws_like($$ select place_order('e79-shop','a0000000-0000-4000-8000-000000000002',pg_temp.tok(2),'pickup',null,'{"name":"X","phone":"9876543210"}',pg_temp.lines('7')) $$,'%DSB_ORDER_STOCK%','more than the free stock is refused');
select throws_like($$ select place_order('e79-shop','a0000000-0000-4000-8000-000000000003',pg_temp.tok(3),'pickup',null,'{"name":"X","phone":"9876543210"}',
  jsonb_build_array(jsonb_build_object('itemId',pg_temp.id('a'),'unitLevel',2,'qty','0.5','pricePaise','999999'))) $$,'%DSB_ORDER_MINIMUM%','a client price is ignored and the minimum applies');
select throws_like($$ select place_order('e79-shop','a0000000-0000-4000-8000-000000000004',pg_temp.tok(4),'delivery','7 pm','{"name":"X","phone":"9876543210","address":"1 Road"}',pg_temp.lines('2')) $$,'%delivery time%','an unknown delivery slot is refused');
select is(place_order('e79-shop','a0000000-0000-4000-8000-000000000005',pg_temp.tok(5),'delivery','9-11 am','{"name":"Asha","phone":"9876543210","address":"1 Road"}',pg_temp.lines('2'))->>'totalPaise','13000','delivery fee added below the free threshold');
select throws_like($$ select place_order('e79-shop','a0000000-0000-4000-8000-000000000006',pg_temp.tok(6),'delivery','9-11 am','{"name":"X","phone":"9876543210"}',pg_temp.lines('1')) $$,'%address%','delivery needs an address');
reset role;
select set_config('e79.ref1',(select public_ref from orders where request_id='a0000000-0000-4000-8000-000000000001'),false);
set role anon;
select throws_ok($$ select count(*) from orders $$,'42501',null,'anon cannot read orders');
select is(public_order_status(current_setting('e79.ref1'),pg_temp.tok(1))->>'totalPaise','20000','the customer sees their order with the token');
select is(public_order_status(current_setting('e79.ref1'),pg_temp.tok(9)),null,'a wrong token sees nothing');
select ok(not (public_order_status(current_setting('e79.ref1'),pg_temp.tok(1)) ?| array['contactPhone','contactName','contact_phone','address']),'status shows no contact details');
reset role;
select is(pg_temp.res(),6::numeric,'6 kg held across two orders');

-- POS: free stock is 4. A sale of 5 with negative stock ALLOWED must still be refused (it would eat a hold).
set role authenticated;
select pg_temp.act('e7900000-0000-0000-0000-000000000001');
select throws_like($$ select post_sale(pg_temp.id('shop'),null,current_date,0,0,'e79-sale-1',
  jsonb_build_array(jsonb_build_object('item_id',pg_temp.id('a'),'unit_level',2,'qty','5','price_kind','retail')),
  '[{"mode":"cash","amount_paise":25000}]'::jsonb) $$,'%DSB_STOCK_RESERVED%','a POS sale cannot take held stock even with negative stock allowed');
select lives_ok($$ select post_sale(pg_temp.id('shop'),null,current_date,0,0,'e79-sale-2',
  jsonb_build_array(jsonb_build_object('item_id',pg_temp.id('a'),'unit_level',2,'qty','4','price_kind','retail')),
  '[{"mode":"cash","amount_paise":20000}]'::jsonb) $$,'a POS sale of the free stock works');

-- Staff steps.
select pg_temp.act('e7900000-0000-0000-0000-000000000003');
select set_config('e79.o1',(select id::text from orders where request_id='a0000000-0000-4000-8000-000000000001'),false);
select is(set_order_status(pg_temp.id('o1'),'CONFIRMED',1)->>'status','CONFIRMED','a cashier confirms');
select throws_like($$ select set_order_status(pg_temp.id('o1'),'PREPARING',1) $$,'%DSB_ORDER_CHANGED%','a stale revision is refused');
select throws_like($$ select set_order_status(pg_temp.id('o1'),'DELIVERED',2) $$,'%DSB_ORDER_STEP%','DELIVERED is not a manual step');
select throws_like($$ select set_order_status(pg_temp.id('o1'),'CANCELLED',2) $$,'%reason%','cancel needs a reason');
select is(set_order_status(pg_temp.id('o1'),'CANCELLED',2,'Customer called')->>'status','CANCELLED','cancel works');
reset role;
select is(pg_temp.res(),2::numeric,'cancel releases exactly its 4 kg');
select is((select count(*)::int from stock_reservations where order_id=pg_temp.id('o1') and release_reason='CANCELLED'),1,'its hold is released once');

-- Expiry.
update orders set reservation_expires_at=clock_timestamp()-interval '1 minute' where request_id='a0000000-0000-4000-8000-000000000005';
set role authenticated;
select pg_temp.act('e7900000-0000-0000-0000-000000000001');
select is(expire_due_orders(pg_temp.id('shop')),1,'an expired order is cancelled');
reset role;
select is(pg_temp.res(),0::numeric,'nothing is held after expiry');
select is((select reserved from stock_current where item_id=pg_temp.id('a')),
  (select coalesce(sum(qty_base),0) from stock_reservations where item_id=pg_temp.id('a') and released_at is null),'held == sum of active holds');

-- A stock count cannot go below what is held either (0042 rule kept): cancel the order first.
set role anon;
select place_order('e79-shop','a0000000-0000-4000-8000-000000000007',pg_temp.tok(7),'pickup',null,'{"name":"Z","phone":"9876543210"}',pg_temp.lines('3'));
reset role;
select throws_ok($$ insert into stock_movements(tenant_id,shop_id,item_id,source_type,source_id,qty_base,client_id)
  values(pg_temp.id('tenant'),pg_temp.id('shop'),pg_temp.id('a'),'ADJUSTMENT',gen_random_uuid(),-5,'e79-count') $$,null,'insufficient stock','a count cannot take held stock either');

-- Rate limit: 10 orders per 10 minutes per caller network.
do $$ begin for i in 1..10 loop
  insert into orders(tenant_id,shop_id,public_ref,fulfilment,contact_name,contact_phone,subtotal_paise,total_paise,request_id,token_digest,caller_digest,reservation_expires_at,client_id,status)
  values(current_setting('e79.tenant')::uuid,current_setting('e79.shop')::uuid,'RATEQQQQQ'||chr(64+i),'pickup','R','9876543210',0,0,gen_random_uuid(),repeat('a',64),order_caller_digest(),clock_timestamp(),'rate-'||i,'CANCELLED');
 end loop; end $$;
set role anon;
select throws_like($$ select place_order('e79-shop','a0000000-0000-4000-8000-000000000008',pg_temp.tok(8),'pickup',null,'{"name":"Z","phone":"9876543210"}',pg_temp.lines('1')) $$,'%RATE_LIMIT%','the 11th order from one network in 10 minutes is refused');
reset role;
select * from finish();
rollback;
