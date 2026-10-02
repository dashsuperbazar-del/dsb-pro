-- Packet D2b (mig 0056): shop settings server guards.
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);
insert into auth.users(id) values
 ('0d200000-0000-0000-0000-000000000001'),  -- owner
 ('0d200000-0000-0000-0000-000000000002');  -- manager
create function pg_temp.act(p_user text) returns void language sql as
 $$ select set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true) $$;
create function pg_temp.shop() returns uuid language sql as $$ select current_setting('d2b.shop')::uuid $$;
create function pg_temp.save(p_name text,p_tz text,p_neg boolean,p_month smallint default 4) returns void language sql as
 $$ select update_shop_settings(pg_temp.shop(),p_name,'1 Main Road',null,null,p_tz,'80mm',p_month,p_neg) $$;
set role authenticated;
select pg_temp.act('0d200000-0000-0000-0000-000000000001');
select create_tenant('D2b Co','d2b-co','D2b Shop','d2b-tenant');
select set_config('d2b.tenant',current_tenant_id()::text,false);
select set_config('d2b.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
reset role;
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id) values
 (current_setting('d2b.tenant')::uuid,'0d200000-0000-0000-0000-000000000002','manager',array[pg_temp.shop()],'active','d2b-mgr');
set role authenticated;

select lives_ok($$select pg_temp.save('Owner Name','Asia/Kolkata',false)$$,'owner saves settings');
select throws_like($$select pg_temp.save('X','Mars/Olympus',false)$$,'DSB_INVALID_TIMEZONE%','unknown timezone refused');
select is((select name from shops where id=pg_temp.shop()),'Owner Name','refused save changes nothing');
select throws_like($$select pg_temp.save('X','Asia/Kolkata',false,1::smallint)$$,'DSB_FISCAL_MONTH_FROZEN%','fiscal month frozen');
select lives_ok($$select pg_temp.save('Owner Name','Asia/Kolkata',true)$$,'owner may allow negative stock');

select pg_temp.act('0d200000-0000-0000-0000-000000000002');
select lives_ok($$select pg_temp.save('Manager Rename','Asia/Kolkata',true)$$,'manager edits profile fields');
select is((select name from shops where id=pg_temp.shop()),'Manager Rename','manager rename stored');
select throws_like($$select pg_temp.save('Manager Rename','Asia/Kolkata',false)$$,'DSB_OWNER_ONLY%','manager cannot change negative-stock policy');
select is((select allow_negative_stock from shops where id=pg_temp.shop()),true,'policy unchanged after refusal');
select lives_ok($$select pg_temp.save('Manager Rename',' Asia/Kolkata ',true)$$,'timezone trimmed and accepted');

reset role;
update shops set timezone='Legacy Free Text' where id=pg_temp.shop();
set role authenticated;
select pg_temp.act('0d200000-0000-0000-0000-000000000001');
select lives_ok($$select pg_temp.save('Kept Old TZ','Legacy Free Text',true)$$,'a stored legacy timezone does not block saving other fields');
select is((select name||':'||timezone from shops where id=pg_temp.shop()),'Kept Old TZ:Legacy Free Text','saved with the unchanged timezone');
select * from finish();
rollback;
