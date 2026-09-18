begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

insert into auth.users(id) values ('b6530000-0000-0000-0000-000000000001');

set role authenticated;
select set_config('request.jwt.claims','{"sub":"b6530000-0000-0000-0000-000000000001","role":"authenticated"}',true);
select create_tenant('Negative Stock Co','negative-stock-co','Negative Stock Shop','ns-tenant');
select set_config('ns.tenant',current_tenant_id()::text,false);
select set_config('ns.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'Negative Stock Item','piece','ns-item');
select set_config('ns.item',(select id::text from items where client_id='ns-item'),false);
select set_item_price(current_setting('ns.item')::uuid,current_setting('ns.shop')::uuid,'retail',1::smallint,100::bigint,'ns-price');
select post_purchase(current_setting('ns.shop')::uuid,null,'NS-SEED','2026-09-18',0,0,'ns-purchase',jsonb_build_array(jsonb_build_object('item_id',current_setting('ns.item'),'unit_level',1,'qty',2,'unit_price_paise',50)),null);

-- Default policy (off): a sale big enough to oversell is blocked and leaves nothing behind.
select throws_ok($$select post_sale(current_setting('ns.shop')::uuid,null,'2026-09-18',0,0,'ns-oversell-blocked',jsonb_build_array(jsonb_build_object('item_id',current_setting('ns.item'),'unit_level',1,'qty',5,'price_kind','retail')),jsonb_build_array(jsonb_build_object('amount_paise',500,'mode','cash')),null)$$,null,'insufficient stock','oversell is blocked by default');
select is((select count(*) from sale_invoices where client_id='ns-oversell-blocked'),0::bigint,'blocked oversell leaves no sale document');
select is((select on_hand from stock_current where tenant_id=current_tenant_id() and shop_id=current_setting('ns.shop')::uuid and item_id=current_setting('ns.item')::uuid),2::numeric,'stock is untouched after the blocked attempt');

select lives_ok($$select update_shop_settings(current_setting('ns.shop')::uuid,'Negative Stock Shop','','','','Asia/Kolkata','80mm',4::smallint,true)$$,'owner enables the override');

-- With the override on, the same shape of oversell posts and goes negative.
select lives_ok($$select post_sale(current_setting('ns.shop')::uuid,null,'2026-09-18',0,0,'ns-oversell-allowed',jsonb_build_array(jsonb_build_object('item_id',current_setting('ns.item'),'unit_level',1,'qty',5,'price_kind','retail')),jsonb_build_array(jsonb_build_object('amount_paise',500,'mode','cash')),null)$$,'override allows a sale to oversell');
select is((select on_hand from stock_current where tenant_id=current_tenant_id() and shop_id=current_setting('ns.shop')::uuid and item_id=current_setting('ns.item')::uuid),(-3)::numeric,'stock goes negative by exactly the oversold amount');

-- check_invariants() must treat this as the owner's deliberate policy, not a bug.
select ok((check_invariants()->>'ok')::boolean,'check_invariants treats owner-permitted negative stock as healthy');
select is((check_invariants()->>'negativeStock')::bigint,0::bigint,'negativeStock excludes shops with the override on');

-- Reserved safety net still holds even with the override on. Server-side
-- `reserved` is always 0 today (Phase 8 will set it through a real RPC for
-- online-order holds); seed it directly here to exercise the guard that
-- protects a concurrently reserved unit from being oversold anyway.
reset role;
update stock_current set reserved=1 where tenant_id=current_setting('ns.tenant')::uuid and shop_id=current_setting('ns.shop')::uuid and item_id=current_setting('ns.item')::uuid;
set role authenticated;
select set_config('request.jwt.claims','{"sub":"b6530000-0000-0000-0000-000000000001","role":"authenticated"}',true);
select throws_ok($$select post_sale(current_setting('ns.shop')::uuid,null,'2026-09-18',0,0,'ns-reserved-guard',jsonb_build_array(jsonb_build_object('item_id',current_setting('ns.item'),'unit_level',1,'qty',1,'price_kind','retail')),jsonb_build_array(jsonb_build_object('amount_paise',100,'mode','cash')),null)$$,null,'insufficient stock','override never lets on_hand drop below a reserved unit');

select * from finish();
rollback;
