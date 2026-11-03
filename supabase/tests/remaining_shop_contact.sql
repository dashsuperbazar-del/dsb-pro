-- Packet shopcontact (mig 0076): update_shop_contact sets/clears the shop phone and receipt footer for an owner or
-- manager of THIS tenant only; it refuses a cashier, anon, another tenant's shop, a bad phone and a long footer.
begin;
create extension if not exists pgtap with schema extensions;
select plan(11);
insert into auth.users(id) values
 ('e7600000-0000-0000-0000-000000000001'),  -- owner
 ('e7600000-0000-0000-0000-000000000003'),  -- cashier
 ('e7600000-0000-0000-0000-000000000004');  -- owner of another tenant
create function pg_temp.act(p_user text) returns void language sql as
 $$ select set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true) $$;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select current_setting('e76.'||p_key)::uuid $$;

set role authenticated;
select pg_temp.act('e7600000-0000-0000-0000-000000000004');
select create_tenant('E76 Other','e76-other','E76 Other Shop','e76-other-tenant');
select set_config('e76.othershop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
select pg_temp.act('e7600000-0000-0000-0000-000000000001');
select create_tenant('E76 Co','e76-co','E76 Shop','e76-tenant');
select set_config('e76.tenant',current_tenant_id()::text,false);
select set_config('e76.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
reset role;
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id) values
 (pg_temp.id('tenant'),'e7600000-0000-0000-0000-000000000003','cashier',array[pg_temp.id('shop')],'active','e76-cash');

select ok(not has_function_privilege('anon','update_shop_contact(uuid,text,text)','execute')
  and has_function_privilege('authenticated','update_shop_contact(uuid,text,text)','execute'),'anon has no access');

set role authenticated;
select pg_temp.act('e7600000-0000-0000-0000-000000000001');
select lives_ok($$ select update_shop_contact(pg_temp.id('shop'),' +91 98765-43210 ','  Thank you, visit again ') $$,'owner saves');
select is((select phone from shops where id=pg_temp.id('shop')),'+91 98765-43210','phone is trimmed and stored');
select is((select receipt_footer from shops where id=pg_temp.id('shop')),'Thank you, visit again','footer is trimmed and stored');
select throws_like($$ select update_shop_contact(pg_temp.id('shop'),'call me','x') $$,'%DSB_INVALID_PHONE%','letters in the phone are refused');
select throws_like($$ select update_shop_contact(pg_temp.id('shop'),'1',repeat('a',201)) $$,'%DSB_FOOTER_TOO_LONG%','a 201-character footer is refused');
select throws_ok($$ select update_shop_contact(pg_temp.id('othershop'),'1','x') $$,null,'another tenant''s shop is refused');
select is((select phone from shops where id=pg_temp.id('shop')),'+91 98765-43210','a refused call changed nothing');
select lives_ok($$ select update_shop_contact(pg_temp.id('shop'),'  ','') $$,'blank clears');
select ok((select phone is null and receipt_footer is null from shops where id=pg_temp.id('shop')),'both are cleared');
select pg_temp.act('e7600000-0000-0000-0000-000000000003');
select throws_like($$ select update_shop_contact(pg_temp.id('shop'),'1','x') $$,'%not permitted%','a cashier is refused');
reset role;
select * from finish();
rollback;
