begin;
create extension if not exists pgtap with schema extensions;
select plan(37);

insert into auth.users(id) values
 ('a9000000-0000-0000-0000-000000000001'),
 ('a9000000-0000-0000-0000-000000000002')
on conflict do nothing;

select ok(to_regclass('public.sync_conflicts') is not null,'sync_conflicts table exists');
select ok((select relrowsecurity from pg_class where oid='public.sync_conflicts'::regclass),'sync_conflicts has RLS');
select ok(not has_table_privilege('authenticated','public.sync_conflicts','INSERT'),'authenticated cannot directly insert conflicts');
select ok(not has_function_privilege('anon','public.phase5_sync_pull(text,uuid,integer,jsonb)','EXECUTE'),'anon cannot call sync pull');
select ok(to_regclass('public.sync_idempotency_keys') is not null,'sync idempotency key table exists');
select ok((select relrowsecurity from pg_class where oid='public.sync_idempotency_keys'::regclass),'sync idempotency keys have RLS');
select ok(not has_table_privilege('authenticated','public.sync_idempotency_keys','INSERT'),'authenticated cannot directly write sync idempotency keys');

set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a9000000-0000-0000-0000-000000000001','role','authenticated')::text,true);
select lives_ok($$select create_tenant('Phase5 A','phase5-a','A Shop','p5-tenant')$$,'create Phase 5 tenant');
select set_config('p5.tenant',current_tenant_id()::text,false);
select set_config('p5.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
select lives_ok($$select register_device('owner-phone','p5-test')$$,'owner registers sync device');
select lives_ok($$insert into items(tenant_id,name,unit1,tax_rate_bp,client_id) values(current_tenant_id(),'Offline Item','Pcs',0,'p5-item')$$,'create offline sale item');
select set_config('p5.item',(select id::text from items where client_id='p5-item'),false);
select lives_ok(format($q$select set_item_price(%L::uuid,%L::uuid,'retail',1::smallint,100::bigint,'p5-price')$q$,current_setting('p5.item'),current_setting('p5.shop')),'set offline price');
select lives_ok(format($q$select post_purchase(%L::uuid,null,'P5-SEED','2026-09-09',0,0,'p5-seed',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',1,'qty',5,'unit_price_paise',50)),null)$q$,current_setting('p5.shop'),current_setting('p5.item')),'seed offline stock');
select pg_sleep(1.1); -- phase5_sync_pull intentionally ignores the newest 1 second to make cursor commits safe.

select lives_ok(format($q$select phase5_sync_pull('owner-phone',%L::uuid,1,'{}'::jsonb)$q$,current_setting('p5.shop')),'registered active device can pull');
select is((phase5_sync_pull('owner-phone',current_setting('p5.shop')::uuid,1,'{}'::jsonb)->>'schemaVersion')::int,1,'pull negotiates schema version');
select ok(jsonb_array_length(phase5_sync_pull('owner-phone',current_setting('p5.shop')::uuid,1,'{}'::jsonb)->'items')>=1,'pull mirrors item master');
select is((phase5_sync_pull('owner-phone',current_setting('p5.shop')::uuid,1,'{}'::jsonb)->'policy'->>'allowCashierOfflineFinalization')::boolean,false,'cashier offline finalization defaults off');
select throws_ok(format($q$select phase5_sync_pull('owner-phone',%L::uuid,99,'{}'::jsonb)$q$,current_setting('p5.shop')),null,'sync schema update required','unsupported sync schema is refused');

select lives_ok($$select phase5_set_offline_finalization_policy(true)$$,'owner can enable cashier offline finalization');
select is((phase5_sync_pull('owner-phone',current_setting('p5.shop')::uuid,1,'{}'::jsonb)->'policy'->>'allowCashierOfflineFinalization')::boolean,true,'pull exposes owner offline policy');

select lives_ok(format($q$select phase5_sync_post_sale('owner-phone',1,%L::uuid,null,'2026-09-09',0,0,'p5-offline-sale',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',1,'qty',2,'price_kind','retail','discount_paise',0,'expected_unit_price_paise',100)),jsonb_build_array(jsonb_build_object('amount_paise',200,'mode','cash')),null)$q$,current_setting('p5.shop'),current_setting('p5.item')),'offline outbox sale posts through device-aware RPC');
select is((select count(*) from sale_invoices where client_id='p5-offline-sale'),1::bigint,'offline sale persists once');
reset role;
select is((select count(*) from sync_idempotency_keys where operation='post_sale' and op_client_id='p5-offline-sale'),1::bigint,'sync request fingerprint persists once');
set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a9000000-0000-0000-0000-000000000001','role','authenticated')::text,true);
select throws_ok(format($q$select phase5_sync_post_sale('owner-phone',1,%L::uuid,null,'2026-09-09',0,0,'p5-offline-sale',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',1,'qty',3,'price_kind','retail','discount_paise',0,'expected_unit_price_paise',100)),jsonb_build_array(jsonb_build_object('amount_paise',300,'mode','cash')),null)$q$,current_setting('p5.shop'),current_setting('p5.item')),null,'client_id payload mismatch','divergent retry under the same client_id is rejected');
select lives_ok(format($q$select phase5_sync_post_sale('owner-phone',1,%L::uuid,null,'2026-09-09',0,0,'p5-offline-sale',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',1,'qty',2,'price_kind','retail','discount_paise',0,'expected_unit_price_paise',100)),jsonb_build_array(jsonb_build_object('amount_paise',200,'mode','cash')),null)$q$,current_setting('p5.shop'),current_setting('p5.item')),'unknown-outcome retry is idempotent');
select is((select count(*) from sale_invoices where client_id='p5-offline-sale'),1::bigint,'retry creates no duplicate invoice');
select is((select qty_base from stock_current where shop_id=current_setting('p5.shop')::uuid and item_id=current_setting('p5.item')::uuid),3::numeric,'offline sync sale decrements stock once');
select lives_ok(format($q$select set_item_price(%L::uuid,%L::uuid,'retail',1::smallint,120::bigint,'p5-price-changed')$q$,current_setting('p5.item'),current_setting('p5.shop')),'server price can change after an offline bill was captured');
select lives_ok(format($q$select phase5_sync_post_sale('owner-phone',1,%L::uuid,null,'2026-09-09',0,0,'p5-offline-sale',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',1,'qty',2,'price_kind','retail','discount_paise',0,'expected_unit_price_paise',100)),jsonb_build_array(jsonb_build_object('amount_paise',200,'mode','cash')),null)$q$,current_setting('p5.shop'),current_setting('p5.item')),'exact unknown-outcome retry still resolves after the server price later changes');
select throws_ok(format($q$select phase5_sync_post_sale('owner-phone',1,%L::uuid,null,'2026-09-09',0,0,'p5-stale-price-sale',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',1,'qty',1,'price_kind','retail','discount_paise',0,'expected_unit_price_paise',100)),jsonb_build_array(jsonb_build_object('amount_paise',100,'mode','cash')),null)$q$,current_setting('p5.shop'),current_setting('p5.item')),null,'offline sale price changed; review required','stale offline price is rejected instead of silently changing the customer total');

select lives_ok($$select phase5_sync_ack('owner-phone',1,'{"items":{"updatedAt":123,"id":"abc"}}'::jsonb)$$,'device acknowledges durable cursor');
select is((select sync_cursors#>>'{items,id}' from devices where device_id='owner-phone'),'abc','server stores device cursor for tombstone safety');

reset role;
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id)
values(current_setting('p5.tenant')::uuid,'a9000000-0000-0000-0000-000000000002','cashier',array[current_setting('p5.shop')::uuid],'active','p5-cashier');
set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a9000000-0000-0000-0000-000000000002','role','authenticated')::text,true);
select lives_ok($$select register_device('cashier-phone','p5-test')$$,'cashier registers sync device');
select lives_ok($$select phase5_record_sync_conflict('cashier-phone',1,'op-1','financial-rejection','post_sale','insufficient stock','{}','{}','p5-conflict-1')$$,'device records rejected mutation for review');
select is((select count(*) from sync_conflicts where op_client_id='op-1'),1::bigint,'rejected mutation is retained in conflict tray');

reset role;
set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a9000000-0000-0000-0000-000000000001','role','authenticated')::text,true);
select lives_ok($select revoke_device((select id from devices where device_id='owner-phone'))$,'owner revokes current sync device');
select throws_ok($select register_device('owner-phone','p5-retry')$,null,'device revoked','revoked browser identity cannot silently re-register');
select throws_ok(format($q$select phase5_sync_pull('owner-phone',%L::uuid,1,'{}'::jsonb)$q$,current_setting('p5.shop')),null,'device revoked','revoked device cannot sync');

select * from finish();
rollback;
