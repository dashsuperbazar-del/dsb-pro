begin;
create extension if not exists pgtap with schema extensions;
select plan(30);

insert into auth.users(id) values ('a6000000-0000-0000-0000-000000000001') on conflict do nothing;
select ok(to_regclass('public.expenses') is not null,'expenses exists');
select ok(to_regclass('public.stock_counts') is not null,'stock_counts exists');
select ok((select relrowsecurity from pg_class where oid='public.expenses'::regclass),'expenses RLS');
select ok(not has_table_privilege('authenticated','public.expenses','INSERT'),'no direct expense insert');
select ok(not has_function_privilege('anon','public.post_expense(uuid,date,text,text,bigint,text,text,text)','EXECUTE'),'anon cannot post expense');

set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a6000000-0000-0000-0000-000000000001','role','authenticated')::text,true);
select lives_ok($$select create_tenant('P6','p6','P6 shop','p6-tenant')$$,'create tenant');
select set_config('p6.shop',(select id::text from shops where tenant_id=current_tenant_id() limit 1),false);
select lives_ok(format($q$select post_expense(%L::uuid,'2026-09-09','Rent','Monthly rent',10000,'cash',null,'p6-exp')$q$,current_setting('p6.shop')),'post expense');
select is((select count(*) from expenses where client_id='p6-exp'),1::bigint,'expense stored once');
select lives_ok(format($q$select post_expense(%L::uuid,'2026-09-09','Rent','Monthly rent',10000,'cash',null,'p6-exp')$q$,current_setting('p6.shop')),'expense retry idempotent');
select is((select count(*) from expenses where client_id='p6-exp'),1::bigint,'no duplicate expense');
select throws_ok($auth$update expenses set amount_paise=1 where client_id='p6-exp'$auth$,'42501','permission denied for table expenses','authenticated direct expense update denied');
reset role;
select throws_ok($priv$update expenses set amount_paise=1 where client_id='p6-exp'$priv$,null,'expense is immutable; use void_expense','privileged edit still blocked by immutability trigger');
set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a6000000-0000-0000-0000-000000000001','role','authenticated')::text,true);
select lives_ok($void$select void_expense((select id from expenses where client_id='p6-exp'))$void$,'expense void allowed');

select lives_ok($$insert into items(tenant_id,name,unit1,tax_rate_bp,client_id) values(current_tenant_id(),'Counted','Pcs',0,'p6-item')$$,'create item');
select set_config('p6.item',(select id::text from items where client_id='p6-item'),false);
select lives_ok(format($q$select post_purchase(%L::uuid,null,'P6','2026-09-09',0,0,'p6-seed',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',1,'qty',5,'unit_price_paise',100)),null)$q$,current_setting('p6.shop'),current_setting('p6.item')),'seed stock');
select lives_ok(format($q$select create_stock_count(%L::uuid,'2026-09-09',jsonb_build_array(jsonb_build_object('item_id',%L,'counted_qty',4,'reason','physical count')),'test','p6-count')$q$,current_setting('p6.shop'),current_setting('p6.item')),'create stock count');
select lives_ok($$select post_stock_count((select id from stock_counts where client_id='p6-count'))$$,'post stock count through movement ledger');
select is((select qty_base from stock_current where shop_id=current_setting('p6.shop')::uuid and item_id=current_setting('p6.item')::uuid),4::numeric,'stock count adjusts derived stock');

select lives_ok(format($q$select * from get_day_book(%L::uuid,'2026-09-09','2026-09-09')$q$,current_setting('p6.shop')),'day book reads');
select lives_ok(format($q$select * from get_stock_valuation(%L::uuid)$q$,current_setting('p6.shop')),'stock valuation reads');
select is((select value_paise from get_stock_valuation(current_setting('p6.shop')::uuid) where item_id=current_setting('p6.item')::uuid),400::bigint,'valuation uses latest immutable purchase cost per base unit');
select lives_ok(format($q$select * from get_gst_summary(%L::uuid,'2026-09-01','2026-09-30')$q$,current_setting('p6.shop')),'GST summary reads');
select is((select gross_purchases_paise from get_gst_summary(current_setting('p6.shop')::uuid,'2026-09-01','2026-09-30') where tax_rate_bp=0),500::bigint,'GST purchase gross comes from posted line snapshots');
select lives_ok(format($q$select set_item_price(%L::uuid,%L::uuid,'retail',1::smallint,200::bigint,'p6-price')$q$,current_setting('p6.item'),current_setting('p6.shop')),'set retail price for discount test');
select lives_ok(format($q$select post_sale(%L::uuid,null,'2026-09-09',10,0,'p6-sale',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',1,'qty',1,'price_kind','retail','discount_paise',20)),jsonb_build_array(jsonb_build_object('amount_paise',170,'mode','cash')),null)$q$,current_setting('p6.shop'),current_setting('p6.item')),'post sale with line and header discounts');
select is((select total_paise from sale_invoices where client_id='p6-sale'),170::bigint,'sale total applies each discount exactly once');
select is((select gross_sales_paise from get_gst_summary(current_setting('p6.shop')::uuid,'2026-09-01','2026-09-30') where tax_rate_bp=0),170::bigint,'GST gross applies line plus header discounts exactly once');
select lives_ok(format($q$select phase6_export_tenant(%L::uuid)$q$,current_setting('p6.shop')),'full export reads');
select ok((phase6_export_tenant(current_setting('p6.shop')::uuid)->>'schemaVersion')::int=3,'export schema versioned');
select ok((check_invariants()->>'ok')::boolean,'invariants clean');

reset role;
select * from finish();
rollback;
