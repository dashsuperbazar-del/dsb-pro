-- Packet partyarchive (mig 0059): guarded archive of suppliers/customers; customer rewrites need master-data permission.
begin;
create extension if not exists pgtap with schema extensions;
select plan(39);
insert into auth.users(id) values
 ('a9000000-0000-0000-0000-000000000001'),  -- owner
 ('a9000000-0000-0000-0000-000000000002'),  -- manager
 ('a9000000-0000-0000-0000-000000000003'),  -- cashier
 ('a9000000-0000-0000-0000-000000000004');  -- other tenant owner
create function pg_temp.act(p_user text) returns void language sql as
 $$ select set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true) $$;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select current_setting('a9.'||p_key)::uuid $$;
set role authenticated;
select pg_temp.act('a9000000-0000-0000-0000-000000000001');
select create_tenant('A9 Co','a9-co','A9 Shop','a9-tenant');
select set_config('a9.tenant',current_tenant_id()::text,false);
select set_config('a9.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'A9 Item','piece','a9-item');
select set_config('a9.item',(select id::text from items where client_id='a9-item'),false);
insert into parties(tenant_id,name,client_id) values
 (current_tenant_id(),'Unused Supplier','a9-p-unused'),
 (current_tenant_id(),'Billed Supplier','a9-p-billed'),
 (current_tenant_id(),'Opening Supplier','a9-p-open');
insert into customers(tenant_id,name,client_id) values
 (current_tenant_id(),'Unused Customer','a9-c-unused'),
 (current_tenant_id(),'Sold Customer','a9-c-sold'),
 (current_tenant_id(),'Opening Customer','a9-c-open'),
 (current_tenant_id(),'Edit Customer','a9-c-edit');
select set_config('a9.p_unused',(select id::text from parties where client_id='a9-p-unused'),false);
select set_config('a9.p_billed',(select id::text from parties where client_id='a9-p-billed'),false);
select set_config('a9.p_open',(select id::text from parties where client_id='a9-p-open'),false);
select set_config('a9.c_unused',(select id::text from customers where client_id='a9-c-unused'),false);
select set_config('a9.c_sold',(select id::text from customers where client_id='a9-c-sold'),false);
select set_config('a9.c_open',(select id::text from customers where client_id='a9-c-open'),false);
select set_config('a9.c_edit',(select id::text from customers where client_id='a9-c-edit'),false);
reset role;
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id) values
 (pg_temp.id('tenant'),'a9000000-0000-0000-0000-000000000002','manager',array[pg_temp.id('shop')],'active','a9-mgr'),
 (pg_temp.id('tenant'),'a9000000-0000-0000-0000-000000000003','cashier',array[pg_temp.id('shop')],'active','a9-cash');
insert into item_prices(tenant_id,item_id,shop_id,kind,unit_level,price_paise,effective_from,client_id)
 values(pg_temp.id('tenant'),pg_temp.id('item'),pg_temp.id('shop'),'retail',1,500,now()-interval '1 day','a9-price');
set role authenticated;
select pg_temp.act('a9000000-0000-0000-0000-000000000001');
-- History: a posted purchase bill, a sale, and two opening balances.
select lives_ok(format($q$select post_purchase(%L::uuid,%L::uuid,'A9-1','2026-10-14',0,0,'a9-bill',
  jsonb_build_array(jsonb_build_object('item_id',%L,'qty','4','unit_price_paise',100)))$q$,
  pg_temp.id('shop'),pg_temp.id('p_billed'),pg_temp.id('item')),'supplier gets a purchase bill');
select lives_ok(format($q$select post_sale(%L::uuid,%L::uuid,'2026-10-14',0,0,'a9-sale',
  jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',1,'qty',1,'price_kind','retail','discount_paise',0)),
  jsonb_build_array(jsonb_build_object('amount_paise',500,'mode','cash')))$q$,
  pg_temp.id('shop'),pg_temp.id('c_sold'),pg_temp.id('item')),'customer gets a sale');
select lives_ok(format($q$select record_account_opening(%L::uuid,'SUPPLIER',%L::uuid,'2026-09-30',1000,'cutover','a9-so')$q$,
  pg_temp.id('shop'),pg_temp.id('p_open')),'supplier gets an opening balance');
select lives_ok(format($q$select record_account_opening(%L::uuid,'CUSTOMER',%L::uuid,'2026-09-30',1000,'cutover','a9-co')$q$,
  pg_temp.id('shop'),pg_temp.id('c_open')),'customer gets an opening balance');

-- Suppliers.
select throws_like(format($$select archive_party(%L::uuid)$$,pg_temp.id('p_billed')),'DSB_PARTY_HAS_HISTORY%','a supplier with a bill is never archived');
select throws_like(format($$select archive_party(%L::uuid)$$,pg_temp.id('p_open')),'DSB_PARTY_HAS_HISTORY%','a supplier with an opening balance is never archived');
select is(archive_party(pg_temp.id('p_unused')),pg_temp.id('p_unused'),'an unused supplier is archived');
select is((select count(*) from parties where id=pg_temp.id('p_unused')),0::bigint,'archived supplier disappears from the owner''s list');
select is(archive_party(pg_temp.id('p_unused')),pg_temp.id('p_unused'),'archiving again is a harmless replay');
select is((select count(*) from parties where id=pg_temp.id('p_billed')),1::bigint,'the supplier with history is still listed');

-- Customers.
select throws_like(format($$select archive_customer(%L::uuid)$$,pg_temp.id('c_sold')),'DSB_PARTY_HAS_HISTORY%','a customer with a sale is never archived');
select throws_like(format($$select archive_customer(%L::uuid)$$,pg_temp.id('c_open')),'DSB_PARTY_HAS_HISTORY%','a customer with an opening balance is never archived');
select is(archive_customer(pg_temp.id('c_unused')),pg_temp.id('c_unused'),'an unused customer is archived');
select is((select count(*) from customers where id=pg_temp.id('c_unused')),0::bigint,'archived customer disappears from the list');
select is(archive_customer(pg_temp.id('c_unused')),pg_temp.id('c_unused'),'archiving a customer again is a harmless replay');

-- The generic archive cannot bypass the history check, and clients cannot write deleted_at directly.
select throws_like(format($$select archive_master('parties',%L::uuid)$$,pg_temp.id('p_billed')),'DSB_USE_ARCHIVE_PARTY%','archive_master no longer archives suppliers');
select throws_like(format($$update parties set deleted_at=1 where id=%L::uuid$$,pg_temp.id('p_billed')),'%permission denied%','no direct deleted_at write on suppliers');
select throws_like(format($$update customers set deleted_at=1 where id=%L::uuid$$,pg_temp.id('c_sold')),'%permission denied%','no direct deleted_at write on customers');
select lives_ok(format($$update customers set name='Edited Customer',credit_limit_paise=150000 where id=%L::uuid$$,pg_temp.id('c_edit')),'owner can still edit descriptive customer columns');
select is((select credit_limit_paise from customers where id=pg_temp.id('c_edit')),150000::bigint,'the edit is stored');

select throws_like(format($$update parties set deleted_at=null where id=%L::uuid$$,pg_temp.id('p_unused')),'%permission denied%','no direct deleted_at write to revive a supplier either');
-- Manager can edit and archive; cashier can create customers but not rewrite or archive them.
select pg_temp.act('a9000000-0000-0000-0000-000000000002');
select lives_ok(format($$update customers set notes='manager note' where id=%L::uuid$$,pg_temp.id('c_edit')),'manager can edit a customer');
select pg_temp.act('a9000000-0000-0000-0000-000000000003');
select lives_ok($$insert into customers(tenant_id,name,client_id) values(current_tenant_id(),'Till Customer','a9-till')$$,'cashier can still create a customer at the till');
create function pg_temp.try_raise_limit() returns bigint language plpgsql as $$
declare changed bigint;
begin
 update customers set credit_limit_paise=999999999 where id=pg_temp.id('c_edit');
 get diagnostics changed = row_count;
 return changed;
end $$;
select is(pg_temp.try_raise_limit(),0::bigint,'cashier cannot raise a credit limit (no row updates)');
select is((select credit_limit_paise from customers where id=pg_temp.id('c_edit')),150000::bigint,'the credit limit is unchanged');
select throws_like(format($$select archive_customer(%L::uuid)$$,pg_temp.id('c_edit')),'%not permitted%','cashier cannot archive a customer');
select throws_like(format($$select archive_party(%L::uuid)$$,pg_temp.id('p_billed')),'%not permitted%','cashier cannot archive a supplier');

-- A ledger row can never be written for an archived party (guards the archive-vs-posting race).
reset role;
select throws_like(format($$insert into purchase_bills(tenant_id,party_id) values(%L::uuid,%L::uuid)$$,pg_temp.id('tenant'),pg_temp.id('p_unused')),'DSB_PARTY_ARCHIVED%','no bill for an archived supplier');
select throws_like(format($$insert into purchase_returns(tenant_id,party_id) values(%L::uuid,%L::uuid)$$,pg_temp.id('tenant'),pg_temp.id('p_unused')),'DSB_PARTY_ARCHIVED%','no purchase return for an archived supplier');
select throws_like(format($$insert into sale_invoices(tenant_id,customer_id) values(%L::uuid,%L::uuid)$$,pg_temp.id('tenant'),pg_temp.id('c_unused')),'DSB_PARTY_ARCHIVED%','no sale for an archived customer');
select throws_like(format($$insert into sale_returns(tenant_id,customer_id) values(%L::uuid,%L::uuid)$$,pg_temp.id('tenant'),pg_temp.id('c_unused')),'DSB_PARTY_ARCHIVED%','no sale return for an archived customer');
select throws_like(format($$insert into payments(tenant_id,kind,party_id) values(%L::uuid,'party',%L::uuid)$$,pg_temp.id('tenant'),pg_temp.id('p_unused')),'DSB_PARTY_ARCHIVED%','no payment to an archived supplier');
select throws_like(format($$insert into account_openings(tenant_id,account_kind,customer_id) values(%L::uuid,'CUSTOMER',%L::uuid)$$,pg_temp.id('tenant'),pg_temp.id('c_unused')),'DSB_PARTY_ARCHIVED%','no opening for an archived customer');
set role authenticated;
select pg_temp.act('a9000000-0000-0000-0000-000000000001');
select lives_ok($$insert into customers(tenant_id,name,client_id) values(current_tenant_id(),'  UNUSED   customer ','a9-c-again')$$,'an archived customer''s name can be used again');
select throws_like($$insert into customers(tenant_id,name,client_id) values(current_tenant_id(),'unused customer','a9-c-dup')$$,'%duplicate key%','a live duplicate name is still refused');
-- Another tenant's owner cannot reach these rows.
select pg_temp.act('a9000000-0000-0000-0000-000000000004');
select create_tenant('A9 Other','a9-other','A9 Other Shop','a9-other-tenant');
select throws_like(format($$select archive_party(%L::uuid)$$,pg_temp.id('p_billed')),'DSB_PARTY_NOT_FOUND%','another tenant cannot archive this supplier');
select throws_like(format($$select archive_customer(%L::uuid)$$,pg_temp.id('c_edit')),'DSB_PARTY_NOT_FOUND%','another tenant cannot archive this customer');
reset role;
select is((select count(*) from audit_log where table_name='parties' and row_id=pg_temp.id('p_unused') and action='UPDATE'),1::bigint,'the supplier archive is audited');
select is((select count(*) from audit_log where table_name='customers' and row_id=pg_temp.id('c_unused') and action='UPDATE'),1::bigint,'the customer archive is audited');
select * from finish();
rollback;
