begin;
create extension if not exists pgtap with schema extensions;
select plan(15);

insert into auth.users(id) values ('af000000-0000-0000-0000-000000000001') on conflict do nothing;
set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','af000000-0000-0000-0000-000000000001','role','authenticated')::text,true);
select lives_ok($$select create_tenant('Batch B','batch-b','B Shop','batch-b-tenant')$$,'creates fixed-point test tenant');
select set_config('b.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
select lives_ok($$select register_device('batch-b-till','fixed-point-test')$$,'registers fixed-point test till');
select lives_ok($$insert into items(tenant_id,name,unit1,tax_rate_bp,client_id) values(current_tenant_id(),'Half-paisa item','Each',0,'batch-b-item')$$,'creates half-paisa item');
select set_config('b.item',(select id::text from items where tenant_id=current_tenant_id() and client_id='batch-b-item'),false);
select lives_ok(format($q$select set_item_price(%L::uuid,%L::uuid,'retail',1::smallint,100::bigint,'batch-b-price')$q$,current_setting('b.item'),current_setting('b.shop')),'sets 100-paise price');
select lives_ok(format($q$select post_purchase(%L::uuid,null,'B-SEED','2026-09-20',0,0,'batch-b-seed',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',1,'qty',1,'unit_price_paise',50)),null)$q$,current_setting('b.shop'),current_setting('b.item')),'seeds stock');

select set_config('b.ack',phase5_sync_post_sale(
  'batch-b-till',1,current_setting('b.shop')::uuid,null,'2026-09-20',0,0,'batch-b-sale',
  jsonb_build_array(jsonb_build_object(
    'item_id',current_setting('b.item'),'unit_level',1,'qty','0.145','price_kind','retail',
    'discount_paise',0,'expected_unit_price_paise',100,
    'intent_fingerprint','intent-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')),
  jsonb_build_array(jsonb_build_object('amount_paise',15,'mode','cash')),null
)::text,false);

select is((current_setting('b.ack')::jsonb->>'totalPaise')::bigint,15::bigint,'0.145 times 100 posts as 15 paise');
select is((current_setting('b.ack')::jsonb#>>'{lines,0,lineTotalPaise}')::bigint,15::bigint,'authoritative line total is returned');
select is(current_setting('b.ack')::jsonb->>'intentFingerprint','intent-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','acknowledgement echoes exact intent fingerprint');
select is((select count(*) from sale_invoices where tenant_id=current_tenant_id() and client_id='batch-b-sale'),1::bigint,'sale posts exactly once');
select is((phase5_sync_post_sale(
  'batch-b-till',1,current_setting('b.shop')::uuid,null,'2026-09-20',0,0,'batch-b-sale',
  jsonb_build_array(jsonb_build_object(
    'item_id',current_setting('b.item'),'unit_level',1,'qty','0.145','price_kind','retail',
    'discount_paise',0,'expected_unit_price_paise',100,
    'intent_fingerprint','intent-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')),
  jsonb_build_array(jsonb_build_object('amount_paise',15,'mode','cash')),null
)->>'saleId'),current_setting('b.ack')::jsonb->>'saleId','unknown-outcome retry returns the same sale');

select throws_ok(format($q$select phase5_sync_post_sale(
  'batch-b-till',1,%L::uuid,null,'2026-09-20',0,0,'batch-b-too-precise',
  jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',1,'qty','0.1450001','price_kind','retail','discount_paise',0,'expected_unit_price_paise',100,'intent_fingerprint','intent-v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')),
  jsonb_build_array(jsonb_build_object('amount_paise',15,'mode','cash')),null)$q$,current_setting('b.shop'),current_setting('b.item')),
  null,'quantity must be a positive plain decimal with at most 6 places','rejects more than six quantity decimals');
select throws_ok(format($q$select phase5_sync_post_sale(
  'batch-b-till',1,%L::uuid,null,'2026-09-20',0,0,'batch-b-bad-fingerprint',
  jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',1,'qty','0.145','price_kind','retail','discount_paise',0,'expected_unit_price_paise',100,'intent_fingerprint','wrong')),
  jsonb_build_array(jsonb_build_object('amount_paise',15,'mode','cash')),null)$q$,current_setting('b.shop'),current_setting('b.item')),
  null,'invalid sale intent fingerprint','rejects malformed intent fingerprint');

select throws_ok(format($q$select post_sale(
  %L::uuid,null,'2026-09-20',0,0,'batch-b-direct-too-precise',
  jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',1,'qty','0.1450001','price_kind','retail','discount_paise',0)),
  jsonb_build_array(jsonb_build_object('amount_paise',15,'mode','cash')),null)$q$,current_setting('b.shop'),current_setting('b.item')),
  null,'quantity must be a positive plain decimal with at most 6 places','direct sales enforce the quantity contract');
select throws_ok(format($q$select post_purchase(
  %L::uuid,null,'B-PRECISE','2026-09-20',0,0,'batch-b-purchase-too-precise',
  jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',1,'qty','0.1450001','unit_price_paise',100)),null)$q$,current_setting('b.shop'),current_setting('b.item')),
  null,'quantity must be a positive plain decimal with at most 6 places','purchases enforce the quantity contract');
select throws_ok(format($q$select post_return(
  'SALE',(select id from sale_invoices where client_id='batch-b-sale'),'2026-09-20','batch-b-return-too-precise',
  jsonb_build_array(jsonb_build_object('sale_invoice_item_id',(select id from sale_invoice_items where sale_invoice_id=(select id from sale_invoices where client_id='batch-b-sale')),'qty','0.0000001','disposition','RETURN_TO_SELLABLE')),null)$q$),
  null,'quantity must be a positive plain decimal with at most 6 places','returns enforce the quantity contract');

select * from finish();
rollback;
