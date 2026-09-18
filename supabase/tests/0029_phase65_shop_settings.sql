begin;
create extension if not exists pgtap with schema extensions;
select plan(15);

insert into auth.users(id) values
 ('b6520000-0000-0000-0000-000000000001'),
 ('b6520000-0000-0000-0000-000000000002'),
 ('b6520000-0000-0000-0000-000000000003');

select ok(not has_function_privilege('anon','update_shop_settings(uuid,text,text,text,text,text,text,smallint)','execute'),'anonymous cannot change shop settings');

set role authenticated;
select set_config('request.jwt.claims','{"sub":"b6520000-0000-0000-0000-000000000001","role":"authenticated"}',true);
select create_tenant('Settings Co','settings-co','Settings Shop','st-tenant');
select set_config('st.tenant',current_tenant_id()::text,false);
select set_config('st.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);

select lives_ok($$select update_shop_settings(current_setting('st.shop')::uuid,'Renamed Shop','12 Market Road','27ABCDE1234F1Z5','RS','Asia/Kolkata','58mm',4)$$,'owner can update every shop setting');
select is((select name from shops where id=current_setting('st.shop')::uuid),'Renamed Shop','name persisted');
select is((select address from shops where id=current_setting('st.shop')::uuid),'12 Market Road','address persisted');
select is((select gstin from shops where id=current_setting('st.shop')::uuid),'27ABCDE1234F1Z5','gstin persisted');
select is((select invoice_prefix from shops where id=current_setting('st.shop')::uuid),'RS','invoice prefix persisted');
select is((select printer_width from shops where id=current_setting('st.shop')::uuid),'58mm','printer width persisted');
select is((select fiscal_year_start_month from shops where id=current_setting('st.shop')::uuid),4::smallint,'fiscal year start month persisted');

select throws_ok($$select update_shop_settings(current_setting('st.shop')::uuid,'','','','','Asia/Kolkata','58mm',4)$$,null,'shop name required','blank name is rejected');
select throws_ok($$select update_shop_settings(current_setting('st.shop')::uuid,'Renamed Shop','','','','Asia/Kolkata','110mm',4)$$,null,'invalid printer width','unsupported printer width is rejected');
select throws_ok($$select update_shop_settings(current_setting('st.shop')::uuid,'Renamed Shop','','','','Asia/Kolkata','58mm',13)$$,null,'invalid fiscal year start month','out-of-range fiscal month is rejected');
select is((select printer_width from shops where id=current_setting('st.shop')::uuid),'58mm','rejected update did not partially apply');

insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id) values
 (current_setting('st.tenant')::uuid,'b6520000-0000-0000-0000-000000000002','manager',array[current_setting('st.shop')::uuid],'active','st-manager'),
 (current_setting('st.tenant')::uuid,'b6520000-0000-0000-0000-000000000003','cashier',array[current_setting('st.shop')::uuid],'active','st-cashier');

select set_config('request.jwt.claims','{"sub":"b6520000-0000-0000-0000-000000000002","role":"authenticated"}',true);
select lives_ok($$select update_shop_settings(current_setting('st.shop')::uuid,'Manager Renamed','','','','Asia/Kolkata','80mm',1)$$,'manager can update shop settings');

select set_config('request.jwt.claims','{"sub":"b6520000-0000-0000-0000-000000000003","role":"authenticated"}',true);
select throws_ok($$select update_shop_settings(current_setting('st.shop')::uuid,'Cashier Renamed','','','','Asia/Kolkata','80mm',1)$$,null,'not permitted','cashier cannot change shop settings');

reset role;
insert into tenants(id,name,slug,created_by) values('b6520000-0000-0000-0000-000000000099','Settings Other','settings-other','b6520000-0000-0000-0000-000000000001');
insert into shops(id,tenant_id,name,is_default,created_by) values('b6520000-0000-0000-0000-000000000098','b6520000-0000-0000-0000-000000000099','Other Tenant Shop',true,'b6520000-0000-0000-0000-000000000001');
set role authenticated;
select set_config('request.jwt.claims','{"sub":"b6520000-0000-0000-0000-000000000001","role":"authenticated"}',true);
select throws_ok($$select update_shop_settings('b6520000-0000-0000-0000-000000000098'::uuid,'Cross Tenant','','','','Asia/Kolkata','80mm',1)$$,null,'shop not in tenant','owner of one tenant cannot change another tenant''s shop');

select * from finish();
rollback;
