-- Packet offlineitems (mig 0071): create_item_v2 with a device-generated id. Replay returns the same item;
-- a reused client id or id is a mismatch; same name + same units maps to the existing item (writes nothing);
-- same name with other units is refused; owner/manager only; tenant isolated; purchase posts against it.
begin;
create extension if not exists pgtap with schema extensions;
select plan(23);
insert into auth.users(id) values
 ('e7100000-0000-0000-0000-000000000001'),  -- owner
 ('e7100000-0000-0000-0000-000000000002'),  -- manager
 ('e7100000-0000-0000-0000-000000000003'),  -- cashier
 ('e7100000-0000-0000-0000-000000000004');  -- owner of another tenant
create function pg_temp.act(p_user text) returns void language sql as
 $$ select set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true) $$;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select current_setting('e71.'||p_key)::uuid $$;

set role authenticated;
select pg_temp.act('e7100000-0000-0000-0000-000000000004');
select create_tenant('E71 Other','e71-other','E71 Other Shop','e71-other-tenant');
insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'E71 Foreign','kg','e71-foreign');
select set_config('e71.foreign',(select id::text from items where client_id='e71-foreign'),false);
select pg_temp.act('e7100000-0000-0000-0000-000000000001');
select create_tenant('E71 Co','e71-co','E71 Shop','e71-tenant');
select set_config('e71.tenant',current_tenant_id()::text,false);
select set_config('e71.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into items(tenant_id,name,unit1,unit2,conv1,client_id) values(current_tenant_id(),'E71 Sugar','bag','kg',50,'e71-sugar');
select set_config('e71.sugar',(select id::text from items where client_id='e71-sugar'),false);
reset role;
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id) values
 (pg_temp.id('tenant'),'e7100000-0000-0000-0000-000000000003','cashier',array[pg_temp.id('shop')],'active','e71-cash'),
 (pg_temp.id('tenant'),'e7100000-0000-0000-0000-000000000002','manager',array[pg_temp.id('shop')],'active','e71-mgr');

select ok(not has_function_privilege('anon','create_item_v2(uuid,text,jsonb)','execute')
  and has_function_privilege('authenticated','create_item_v2(uuid,text,jsonb)','execute'),'anon cannot create items');

set role authenticated;
select pg_temp.act('e7100000-0000-0000-0000-000000000001');
-- New item under the device id.
select is(create_item_v2('a7100000-0000-4000-8000-000000000001','b7100000-0000-4000-8000-000000000001',
  '{"name":"  E71 Atta ","unit1":"bag","unit2":"kg","conv1":"10","tax_rate_bp":500}')->>'itemId',
  'a7100000-0000-4000-8000-000000000001','created under the device id');
select is((select name||'|'||unit1||'|'||unit2||'|'||conv1::int||'|'||tax_rate_bp from items where id='a7100000-0000-4000-8000-000000000001'),
  'E71 Atta|bag|kg|10|500','fields trimmed and stored');
select is((select client_id from items where id='a7100000-0000-4000-8000-000000000001'),'b7100000-0000-4000-8000-000000000001','client id kept');
select ok((select updated_at>0 from items where id='a7100000-0000-4000-8000-000000000001'),'server set updated_at');
-- Replay: same item, nothing new; still the same after a rename.
select is(create_item_v2('a7100000-0000-4000-8000-000000000001','b7100000-0000-4000-8000-000000000001',
  '{"name":"E71 Atta","unit1":"bag","unit2":"kg","conv1":"10","tax_rate_bp":500}')->>'created','false','replay returns the same item');
select is((select count(*)::int from items where tenant_id=pg_temp.id('tenant') and lower(name)='e71 atta'),1,'replay wrote no second item');
reset role;
update items set name='E71 Atta Chakki' where id='a7100000-0000-4000-8000-000000000001';
set role authenticated;
select pg_temp.act('e7100000-0000-0000-0000-000000000001');
select is(create_item_v2('a7100000-0000-4000-8000-000000000001','b7100000-0000-4000-8000-000000000001',
  '{"name":"E71 Atta","unit1":"bag","unit2":"kg","conv1":"10"}')->>'itemId','a7100000-0000-4000-8000-000000000001','replay after a rename still returns the item');
-- Mismatches: same client id with another id; an id already used.
select throws_like($$select create_item_v2('a7100000-0000-4000-8000-000000000009','b7100000-0000-4000-8000-000000000001','{"name":"E71 Atta","unit1":"bag"}')$$,
  'DSB_PAYLOAD_MISMATCH%','client id reused for another id is a mismatch');
select throws_like($$select create_item_v2('a7100000-0000-4000-8000-000000000001','b7100000-0000-4000-8000-000000000002','{"name":"E71 New","unit1":"bag"}')$$,
  'DSB_PAYLOAD_MISMATCH%','an id already used is a mismatch');
select throws_like(format($$select create_item_v2(%L,'b7100000-0000-4000-8000-000000000003','{"name":"E71 X","unit1":"bag"}')$$,
  pg_temp.id('foreign')),'DSB_PAYLOAD_MISMATCH%','another tenant''s item id is refused');
-- Same name + same units: mapped, nothing written.
select is(create_item_v2('a7100000-0000-4000-8000-000000000004','b7100000-0000-4000-8000-000000000004',
  '{"name":"e71 sugar ","unit1":"bag","unit2":"kg","conv1":50}')->>'itemId',pg_temp.id('sugar')::text,'same name and units maps to the existing item');
select ok(not exists(select 1 from items where id='a7100000-0000-4000-8000-000000000004' or client_id='b7100000-0000-4000-8000-000000000004'),'a mapping writes nothing');
-- Same name, other units: refused.
select throws_like($$select create_item_v2('a7100000-0000-4000-8000-000000000005','b7100000-0000-4000-8000-000000000005','{"name":"E71 SUGAR","unit1":"bag","unit2":"kg","conv1":25}')$$,
  'DSB_ITEM_NAME_TAKEN%','same name with other units is refused');
select throws_like($$select create_item_v2('a7100000-0000-4000-8000-000000000006','b7100000-0000-4000-8000-000000000006','{"name":"E71 Sugar","unit1":"bag","unit2":"kg","conv1":50,"sku":"S-1"}')$$,
  'DSB_ITEM_NAME_TAKEN%','same name with a different SKU is refused');
-- Unit rules and input.
select throws_like($$select create_item_v2('a7100000-0000-4000-8000-000000000007','b7100000-0000-4000-8000-000000000007','{"name":"E71 Y","unit1":"bag","unit2":"kg"}')$$,
  'DSB_INVALID_ITEM%','small unit without conversion refused');
select throws_like($$select create_item_v2('a7100000-0000-4000-8000-000000000007','B7100000-0000-4000-8000-000000000007','{"name":"E71 Y","unit1":"bag"}')$$,
  'DSB_INVALID_REQUEST_ID%','upper-case request id refused');
-- Manager may; cashier may not.
select pg_temp.act('e7100000-0000-0000-0000-000000000002');
select is(create_item_v2('a7100000-0000-4000-8000-000000000008','b7100000-0000-4000-8000-000000000008','{"name":"E71 Oil","unit1":"tin"}')->>'created','true','manager creates');
select pg_temp.act('e7100000-0000-0000-0000-000000000003');
select throws_like($$select create_item_v2('a7100000-0000-4000-8000-00000000000a','b7100000-0000-4000-8000-00000000000a','{"name":"E71 Z","unit1":"bag"}')$$,
  'not permitted','cashier cannot create');
-- Other tenant: cannot see or map to this tenant's items.
select pg_temp.act('e7100000-0000-0000-0000-000000000004');
select is(create_item_v2('a7100000-0000-4000-8000-00000000000b','b7100000-0000-4000-8000-00000000000b','{"name":"E71 Sugar","unit1":"bag","unit2":"kg","conv1":50}')->>'mapped',
  'false','another tenant never maps to this tenant''s item');
select is(create_item_v2('a7100000-0000-4000-8000-00000000000c','b7100000-0000-4000-8000-000000000001','{"name":"E71 Q","unit1":"bag"}')->>'created',
  'true','client ids are per tenant');
-- A purchase posts against the device-created item.
select pg_temp.act('e7100000-0000-0000-0000-000000000001');
select ok((post_purchase_v2(pg_temp.id('shop'),'c7100000-0000-4000-8000-000000000001',jsonb_build_object('payment_type','credit',
  'total_paise',2000,'round_off_paise',0,'lines',jsonb_build_array(jsonb_build_object('item_id','a7100000-0000-4000-8000-000000000001',
  'qty','2','unit_price_paise',1000,'discount_bp',0,'gst_bp',null,'line_total_paise',2000))))->>'billId') is not null,'a bill posts against the new item');
select is((select on_hand::int from stock_current where shop_id=pg_temp.id('shop') and item_id='a7100000-0000-4000-8000-000000000001'),20,'stock in the smallest unit');
select * from finish();
rollback;
