-- Packet storefrontupi (mig 0081): the UPI ID is validated, owner/manager only, and shown on the public shop.
begin;
create extension if not exists pgtap with schema extensions;
select plan(7);
insert into auth.users(id) values ('e8100000-0000-0000-0000-000000000001'),('e8100000-0000-0000-0000-000000000003');
create function pg_temp.act(p_user text) returns void language sql as
 $$ select set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true) $$;
set role authenticated;
select pg_temp.act('e8100000-0000-0000-0000-000000000001');
select create_tenant('E81 Co','e81-co','E81 Shop','e81-t');
select set_config('e81.tenant',current_tenant_id()::text,false);
select set_config('e81.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
reset role;
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id) values
 (current_setting('e81.tenant')::uuid,'e8100000-0000-0000-0000-000000000003','cashier',array[current_setting('e81.shop')::uuid],'active','e81-cash');
set role authenticated;
select pg_temp.act('e8100000-0000-0000-0000-000000000001');
select throws_like($$ select set_storefront_upi(current_setting('e81.shop')::uuid,'dsb@okaxis','DSB') $$,'%DSB_STOREFRONT_MISSING%','needs online shop settings first');
select set_storefront_settings(current_setting('e81.shop')::uuid,'{"slug":"e81-shop","displayName":"E81","enabled":true}','e81-s');
select throws_like($$ select set_storefront_upi(current_setting('e81.shop')::uuid,'not a upi','x') $$,'%DSB_INVALID_UPI%','a bad UPI ID is refused');
select lives_ok($$ select set_storefront_upi(current_setting('e81.shop')::uuid,' dsb.store@okaxis ','Dash Super Bazar') $$,'owner saves the UPI ID');
select pg_temp.act('e8100000-0000-0000-0000-000000000003');
select throws_like($$ select set_storefront_upi(current_setting('e81.shop')::uuid,'x@ybl','x') $$,'%not permitted%','a cashier cannot change it');
reset role;
set role anon;
select is(public_storefront('e81-shop')->>'upiId','dsb.store@okaxis','the public shop shows the trimmed UPI ID');
select is(public_storefront('e81-shop')->>'upiName','Dash Super Bazar','and the payee name');
reset role;
set role authenticated;
select pg_temp.act('e8100000-0000-0000-0000-000000000001');
select set_storefront_upi(current_setting('e81.shop')::uuid,'','');
reset role;
select ok((select upi_id is null and upi_name is null from storefront_settings where shop_id=current_setting('e81.shop')::uuid),'blank clears it');
select * from finish();
rollback;
