-- Packet D3a (mig 0057): every public base table is either in the business export or excluded here
-- with a reason. A new table fails this test until it is classified.
begin;
create extension if not exists pgtap with schema extensions;
select plan(5);
create temp table export_map(tbl text primary key, export_key text, reason text) on commit drop;
insert into export_map values
 ('account_openings','accountOpenings',null),('audit_log','auditLog',null),('categories','categories',null),
 ('customers','customers',null),('devices','devices',null),('doc_sequences','documentSequences',null),
 ('expenses','expenses',null),('financial_requests','financialRequests',null),('invites','invites',null),
 ('item_barcodes','itemBarcodes',null),('item_prices','itemPrices',null),('items','items',null),
 ('legacy_import_runs','legacyImportRuns',null),('opening_settlements','openingSettlements',null),
 ('parties','parties',null),('payment_allocations','allocations',null),('payments','payments',null),
 ('permissions','permissions',null),('purchase_bill_items','purchaseLines',null),('purchase_bills','purchases',null),
 ('purchase_return_items','purchaseReturnLines',null),('purchase_returns','purchaseReturns',null),
 ('role_permissions','rolePermissions',null),('sale_invoice_items','saleLines',null),('sale_invoices','sales',null),
 ('sale_return_items','saleReturnLines',null),('sale_returns','saleReturns',null),('schema_meta','schemaMeta',null),
 ('shop_financial_history','shopFinancialHistory',null),('shops','shops',null),('stock_count_lines','stockCountLines',null),
 ('stock_counts','stockCounts',null),('stock_current','stockCurrent',null),('stock_movements','stockMovements',null),
 ('sync_conflicts','syncConflicts',null),('sync_idempotency_keys','syncIdempotencyKeys',null),
 ('tenant_users','tenantUsers',null),('tenants','tenant',null),
 ('app_migration_receipts',null,'operator control table: rebuilt by the upgrade scripts, not business data'),
 ('backup_runs',null,'operator control table: backup job evidence, kept in the operator DR dump');

select is((select string_agg(table_name,',' order by table_name) from information_schema.tables
  where table_schema='public' and table_type='BASE TABLE' and table_name not in (select tbl from export_map)),
  null,'every public base table is classified (exported or excluded with a reason)');
select is((select count(*) from export_map where (export_key is null)=(reason is null)),0::bigint,
  'each table has exactly one of export key or exclusion reason');

insert into auth.users(id) values ('0e000000-0000-0000-0000-000000000001');
set role authenticated;
select set_config('request.jwt.claims','{"sub":"0e000000-0000-0000-0000-000000000001","role":"authenticated"}',true);
select create_tenant('D3a Co','d3a-co','D3a Shop','d3a-t');
select set_config('d3a.keys',(select string_agg(k,',') from jsonb_object_keys(
  phase6_export_tenant((select id from shops where tenant_id=current_tenant_id() limit 1))) k),false);
reset role;
select is((select string_agg(export_key,',' order by export_key) from export_map
  where export_key is not null and export_key<>all(string_to_array(current_setting('d3a.keys'),','))),
  null,'every mapped export key is present in the business export');
select ok(position('financialRequests' in current_setting('d3a.keys'))>0,'request ledger exported');
select ok(position('shopFinancialHistory' in current_setting('d3a.keys'))>0,'allocation-date trust marker exported');

select * from finish();
rollback;
