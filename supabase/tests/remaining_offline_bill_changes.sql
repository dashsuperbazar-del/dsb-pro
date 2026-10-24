-- Packet offlinebillchange (mig 0072): offline bill edit / void applied only if the bill is unchanged since the
-- device read its version. Replay first (same answer), stale version refused (DSB_BILL_CHANGED), void with a
-- payment refused (DSB_VOID_HAS_PAYMENTS), owner/manager only, tenant isolated, nothing changed by a refusal.
begin;
create extension if not exists pgtap with schema extensions;
select plan(29);
insert into auth.users(id) values
 ('e7200000-0000-0000-0000-000000000001'),  -- owner
 ('e7200000-0000-0000-0000-000000000002'),  -- manager
 ('e7200000-0000-0000-0000-000000000003'),  -- cashier
 ('e7200000-0000-0000-0000-000000000004');  -- owner of another tenant
create function pg_temp.act(p_user text) returns void language sql as
 $$ select set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true) $$;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select current_setting('e72.'||p_key)::uuid $$;
create function pg_temp.stock(p_item text) returns numeric language sql as $$
 select coalesce((select on_hand from stock_current where shop_id=pg_temp.id('shop') and item_id=pg_temp.id(p_item)),0) $$;
create function pg_temp.bill(p_type text,p_qty int,p_price bigint) returns jsonb language sql as $$
 select jsonb_build_object('party_id',pg_temp.id('s'),'payment_type',p_type,'total_paise',p_qty*p_price,'round_off_paise',0,
   'lines',jsonb_build_array(jsonb_build_object('item_id',pg_temp.id('a'),'qty',p_qty::text,'unit_price_paise',p_price,
     'discount_bp',0,'gst_bp',null,'line_total_paise',p_qty*p_price))) $$;
create function pg_temp.post(p_client text,p_bill jsonb) returns uuid language sql as $$
 select (post_purchase_v2(pg_temp.id('shop'),p_client,p_bill)->>'billId')::uuid $$;
create function pg_temp.ver(p_bill text) returns text language sql as $$ select get_purchase_bill_version(pg_temp.id(p_bill)) $$;

set role authenticated;
select pg_temp.act('e7200000-0000-0000-0000-000000000004');
select create_tenant('E72 Other','e72-other','E72 Other Shop','e72-other-tenant');
select pg_temp.act('e7200000-0000-0000-0000-000000000001');
select create_tenant('E72 Co','e72-co','E72 Shop','e72-tenant');
select set_config('e72.tenant',current_tenant_id()::text,false);
select set_config('e72.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'E72 Rice','kg','e72-a');
select set_config('e72.a',(select id::text from items where client_id='e72-a'),false);
insert into parties(tenant_id,name,client_id) values(current_tenant_id(),'E72 Traders','e72-s');
select set_config('e72.s',(select id::text from parties where client_id='e72-s'),false);
reset role;
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id) values
 (pg_temp.id('tenant'),'e7200000-0000-0000-0000-000000000003','cashier',array[pg_temp.id('shop')],'active','e72-cash'),
 (pg_temp.id('tenant'),'e7200000-0000-0000-0000-000000000002','manager',array[pg_temp.id('shop')],'active','e72-mgr');

select ok(not has_function_privilege('anon','edit_purchase_bill_if_unchanged(uuid,text,jsonb,text)','execute')
  and not has_function_privilege('anon','void_purchase_if_unchanged(uuid,text,text,text)','execute')
  and not has_function_privilege('anon','get_purchase_bill_version(uuid)','execute')
  and not has_function_privilege('authenticated','obc_bill_version(uuid,uuid)','execute'),'anon has no access; the version body is internal');

set role authenticated;
select pg_temp.act('e7200000-0000-0000-0000-000000000001');
select set_config('e72.x1',pg_temp.post('e7200000-0000-4000-8000-0000000000a1',pg_temp.bill('credit',10,1000))::text,false);
select set_config('e72.v1',pg_temp.ver('x1'),false);
select ok(current_setting('e72.v1') ~ '^[0-9a-f]{32}$','version token is an md5');
select is(pg_temp.ver('x1'),current_setting('e72.v1'),'version is stable while nothing changes');

-- 1. Edit with the current version: applied (normal edit rules).
select pg_temp.act('e7200000-0000-0000-0000-000000000002');
select set_config('e72.r1',edit_purchase_bill_if_unchanged(pg_temp.id('x1'),'e7200000-0000-4000-8000-0000000000e1',
  pg_temp.bill('credit',12,1000),current_setting('e72.v1'))::text,false);
select set_config('e72.n1',current_setting('e72.r1')::jsonb->>'billId',false);
select is(pg_temp.stock('a'),12::numeric,'manager edit applied: stock is the corrected quantity');
select isnt(pg_temp.ver('x1'),current_setting('e72.v1'),'the edited bill has a new version');
-- 2. Replay (the bill is now replaced): the same answer, nothing new.
select is(edit_purchase_bill_if_unchanged(pg_temp.id('x1'),'e7200000-0000-4000-8000-0000000000e1',
  pg_temp.bill('credit',12,1000),current_setting('e72.v1'))->>'billId',current_setting('e72.n1'),'replay returns the same corrected bill');
select is((select count(*)::int from purchase_bills where tenant_id=pg_temp.id('tenant')),2,'no extra bill from the replay');
select throws_like($$select edit_purchase_bill_if_unchanged(pg_temp.id('x1'),'e7200000-0000-4000-8000-0000000000e1',
  pg_temp.bill('credit',13,1000),current_setting('e72.v1'))$$,'%already used for a different request%','same id, different edit refused');
-- 3. Stale version: a second device's edit of the same original is refused, never last-write-wins.
select throws_like($$select edit_purchase_bill_if_unchanged(pg_temp.id('x1'),'e7200000-0000-4000-8000-0000000000e2',
  pg_temp.bill('credit',20,1000),current_setting('e72.v1'))$$,'DSB_BILL_CHANGED%','stale edit refused');
select is(pg_temp.stock('a'),12::numeric,'stale edit changed nothing');

-- 4. A payment assigned after the device read the bill makes the edit stale.
select set_config('e72.x2',pg_temp.post('e7200000-0000-4000-8000-0000000000a2',pg_temp.bill('credit',5,1000))::text,false);
select set_config('e72.v2',pg_temp.ver('x2'),false);
select set_config('e72.pay',record_supplier_payment(pg_temp.id('shop'),pg_temp.id('s'),shop_business_date(pg_temp.id('shop')),2000,'cash',null,
  '[]'::jsonb,'e7200000-0000-4000-8000-0000000000f1')::text,false);
select lives_ok($$select allocate_supplier_payment(pg_temp.id('pay'),jsonb_build_array(jsonb_build_object('purchase_bill_id',pg_temp.id('x2'),
  'amount_paise',2000)),'e7200000-0000-4000-8000-0000000000f2')$$,'payment assigned after the version was read');
select throws_like($$select edit_purchase_bill_if_unchanged(pg_temp.id('x2'),'e7200000-0000-4000-8000-0000000000e3',
  pg_temp.bill('credit',4,1000),current_setting('e72.v2'))$$,'DSB_BILL_CHANGED%','an assigned payment makes the edit stale');
-- 5. Void with a payment assigned: refused even with the current version.
select throws_like($$select void_purchase_if_unchanged(pg_temp.id('x2'),'e7200000-0000-4000-8000-0000000000d1','entered twice',pg_temp.ver('x2'))$$,
  'DSB_VOID_HAS_PAYMENTS%','void refused while a payment is assigned');
select is((select status from purchase_bills where id=pg_temp.id('x2')),'POSTED','the paid bill is still posted');

-- 6. Void with the current version: applied once; replay same answer; reason kept like the online void.
select set_config('e72.x3',pg_temp.post('e7200000-0000-4000-8000-0000000000a3',pg_temp.bill('credit',3,1000))::text,false);
select set_config('e72.v3',pg_temp.ver('x3'),false);
select set_config('e72.st3',pg_temp.stock('a')::text,false);
select is(void_purchase_if_unchanged(pg_temp.id('x3'),'e7200000-0000-4000-8000-0000000000d2',' entered   twice ',current_setting('e72.v3'))->>'voided',
  'true','void applied');
select is((select status from purchase_bills where id=pg_temp.id('x3')),'VOID','bill is void');
select is(pg_temp.stock('a'),current_setting('e72.st3')::numeric-3,'stock reversed once');
select is((select count(*)::int from stock_movements where source_id=pg_temp.id('x3') and source_type='PURCHASE_VOID'
  and client_id like 'purchase.void.v1:e7200000-0000-4000-8000-0000000000d2:reason:entered twice:stock:%'),1,'reason kept in the void movement id');
select is(void_purchase_if_unchanged(pg_temp.id('x3'),'e7200000-0000-4000-8000-0000000000d2','entered twice',current_setting('e72.v3'))->>'billId',
  current_setting('e72.x3'),'replay returns the same answer');
select is(pg_temp.stock('a'),current_setting('e72.st3')::numeric-3,'replay reversed nothing more');
select is(get_financial_request(pg_temp.id('shop'),'purchase.void.offline.v1','e7200000-0000-4000-8000-0000000000d2')->>'state','COMMITTED',
  'the stored answer can be looked up');
-- 7. Stale void (bill edited elsewhere after the version was read).
select set_config('e72.x4',pg_temp.post('e7200000-0000-4000-8000-0000000000a4',pg_temp.bill('credit',2,1000))::text,false);
select set_config('e72.v4',pg_temp.ver('x4'),false);
select lives_ok($$select edit_purchase_bill(pg_temp.id('x4'),'e7200000-0000-4000-8000-0000000000e4',pg_temp.bill('credit',1,1000))$$,'edited online meanwhile');
select throws_like($$select void_purchase_if_unchanged(pg_temp.id('x4'),'e7200000-0000-4000-8000-0000000000d3','wrong',current_setting('e72.v4'))$$,
  'DSB_BILL_CHANGED%','stale void refused');
select throws_like($$select void_purchase_if_unchanged(pg_temp.id('x4'),'e7200000-0000-4000-8000-0000000000d4','a:b',current_setting('e72.v4'))$$,
  'DSB_INVALID_REASON%','a reason with a colon is refused');

-- 8. Roles and tenancy.
select pg_temp.act('e7200000-0000-0000-0000-000000000003');
select throws_like($$select edit_purchase_bill_if_unchanged(pg_temp.id('n1'),'e7200000-0000-4000-8000-0000000000e5',pg_temp.bill('credit',1,1000),repeat('0',32))$$,
  'not permitted','cashier cannot edit offline');
select throws_like($$select void_purchase_if_unchanged(pg_temp.id('n1'),'e7200000-0000-4000-8000-0000000000d5','x',repeat('0',32))$$,
  'not permitted','cashier cannot void offline');
select pg_temp.act('e7200000-0000-0000-0000-000000000004');
select throws_like($$select void_purchase_if_unchanged(pg_temp.id('n1'),'e7200000-0000-4000-8000-0000000000d6','x',repeat('0',32))$$,
  'purchase not found','another tenant cannot void the bill');
select throws_like($$select get_purchase_bill_version(pg_temp.id('n1'))$$,'purchase not found','another tenant cannot read the version');
select pg_temp.act('e7200000-0000-0000-0000-000000000001');
select is((select status from purchase_bills where id=pg_temp.id('n1')),'POSTED','refusals changed nothing');
select * from finish();
rollback;
