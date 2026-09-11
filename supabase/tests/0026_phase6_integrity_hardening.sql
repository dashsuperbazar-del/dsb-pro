begin;
create extension if not exists pgtap with schema extensions;
select plan(18);

insert into auth.users(id) values
 ('a6100000-0000-0000-0000-000000000001'),
 ('a6100000-0000-0000-0000-000000000002') on conflict do nothing;

set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a6100000-0000-0000-0000-000000000001','role','authenticated')::text,true);
select lives_ok($$select create_tenant('P6 hardening','p6-hardening','P6 hardening shop','p6-hardening-tenant')$$,'owner tenant created');
select set_config('p6h.tenant',current_tenant_id()::text,false);
select set_config('p6h.shop',(select id::text from shops where tenant_id=current_tenant_id() limit 1),false);

select lives_ok(format($q$select post_expense(%L::uuid,'2026-09-10','Rent','Monthly rent',12345,'cash',null,'stable-expense-id')$q$,current_setting('p6h.shop')),'expense posts');
select is(
 (select post_expense(current_setting('p6h.shop')::uuid,'2026-09-10','Rent','Monthly rent',12345,'cash',null,'stable-expense-id')),
 (select id from expenses where client_id='stable-expense-id'),
 'same expense retry converges to one row'
);
select throws_ok(
 $$select post_expense(current_setting('p6h.shop')::uuid,'2026-09-10','Rent','Changed payload',12345,'cash',null,'stable-expense-id')$$,
 null,'client_id already used with different expense payload','divergent expense retry is rejected'
);
select is((select count(*) from expenses where client_id='stable-expense-id'),1::bigint,'expense remains single');
select ok((phase6_export_tenant(current_setting('p6h.shop')::uuid) ?& array['categories','itemBarcodes','itemPrices','documentSequences','auditLog','invites','permissions','rolePermissions','syncIdempotencyKeys','schemaMeta']),'portable export includes master, price, control, idempotency and audit records');
select is((phase6_export_tenant(current_setting('p6h.shop')::uuid)->>'exportKind'),'portable-business-data','export labels its recovery scope accurately');
select ok(check_invariants() ?& array['stockProjectionViolations','voidReversalViolations'],'invariants expose projection and reversal checks');
select ok((check_invariants()->>'ok')::boolean,'strengthened invariants pass on consistent data');
select lives_ok($$insert into items(tenant_id,name,unit1,tax_rate_bp,client_id) values(current_tenant_id(),'Permission priced item','pcs',0,'p6h-item')$$,'owner creates priced item');
select set_config('p6h.item',(select id::text from items where client_id='p6h-item'),false);
select lives_ok(format($q$select set_item_price(%L::uuid,%L::uuid,'retail',1::smallint,200::bigint,'p6h-retail')$q$,current_setting('p6h.item'),current_setting('p6h.shop')),'owner creates sell price');
select lives_ok(format($q$select set_item_price(%L::uuid,%L::uuid,'cost_last',1::smallint,100::bigint,'p6h-cost')$q$,current_setting('p6h.item'),current_setting('p6h.shop')),'owner creates cost price');
reset role;

insert into tenant_users(tenant_id,user_id,role,shop_ids,created_by)
values(current_setting('p6h.tenant')::uuid,'a6100000-0000-0000-0000-000000000002','cashier',array[current_setting('p6h.shop')::uuid],'a6100000-0000-0000-0000-000000000001');
set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a6100000-0000-0000-0000-000000000002','role','authenticated')::text,true);
select throws_ok(format($q$select * from get_day_book(%L::uuid,'2026-09-10','2026-09-10')$q$,current_setting('p6h.shop')),null,'not permitted','cashier cannot read day book');
select throws_ok(format($q$select * from get_stock_valuation(%L::uuid)$q$,current_setting('p6h.shop')),null,'not permitted','cashier cannot read stock cost valuation');
select throws_ok(format($q$select * from get_gst_summary(%L::uuid,'2026-09-10','2026-09-10')$q$,current_setting('p6h.shop')),null,'not permitted','cashier cannot read GST report');
select throws_ok($$select check_invariants()$$,null,'not permitted','cashier cannot call financial invariant report');
select is((select count(*) from expenses),0::bigint,'cashier cannot read expense rows directly');
select results_eq($$select kind from item_prices order by kind$$,$$values ('retail'::text)$$,'cashier sees sell price but not cost_last');

reset role;
select * from finish();
rollback;
