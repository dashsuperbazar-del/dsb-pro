begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

insert into auth.users(id) values
 ('a3100000-0000-0000-0000-000000000001'),
 ('a3100000-0000-0000-0000-000000000002')
on conflict do nothing;

set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a3100000-0000-0000-0000-000000000001','role','authenticated')::text,true);
select lives_ok($$select create_tenant('Integrity A','integrity-a','A','p3i-a')$$,'create integrity tenant A');
select set_config('p3i.tenant_a',current_tenant_id()::text,false);
select set_config('p3i.shop_a',(select id::text from shops where tenant_id=current_tenant_id() limit 1),false);
select lives_ok($$insert into categories(tenant_id,name,client_id) values(current_tenant_id(),'A Cat','p3i-cat-a')$$,'create category A');
select set_config('p3i.cat_a',(select id::text from categories where client_id='p3i-cat-a'),false);
select is(shop_business_date(current_setting('p3i.shop_a')::uuid),(clock_timestamp() at time zone 'Asia/Kolkata')::date,'shop business date uses shop timezone');
reset role;

set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a3100000-0000-0000-0000-000000000002','role','authenticated')::text,true);
select lives_ok($$select create_tenant('Integrity B','integrity-b','B','p3i-b')$$,'create integrity tenant B');
select throws_ok(format($q$insert into items(tenant_id,name,sku,category_id,unit1,client_id) values(current_tenant_id(),'Bad Ref','BAD-REF',%L::uuid,'ea','p3i-bad')$q$,current_setting('p3i.cat_a')),'23503',null,'cross-tenant category reference rejected structurally');
select throws_ok(format($q$select shop_business_date(%L::uuid)$q$,current_setting('p3i.shop_a')),null,'shop not in tenant','cross-tenant business-date lookup rejected');
reset role;

select * from finish();
rollback;
