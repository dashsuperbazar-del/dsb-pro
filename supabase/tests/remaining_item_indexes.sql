-- Packet itemindex (mig 0063): per-item history read indexes. Columns and order must match the adapter reads
-- (shop + item, newest first; RLS adds tenant_id), so each index is asserted by its exact definition.
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);
select has_index('public','purchase_bill_items','purchase_bill_items_item_history_idx',
 array['tenant_id','shop_id','item_id','created_at'],'purchase_bill_items history index columns');
select has_index('public','sale_invoice_items','sale_invoice_items_item_history_idx',
 array['tenant_id','shop_id','item_id','created_at'],'sale_invoice_items history index columns');
select has_index('public','sale_return_items','sale_return_items_item_history_idx',
 array['tenant_id','shop_id','item_id','created_at'],'sale_return_items history index columns');
select is((select indexdef from pg_indexes where schemaname='public' and indexname='purchase_bill_items_item_history_idx'),
 'CREATE INDEX purchase_bill_items_item_history_idx ON public.purchase_bill_items USING btree (tenant_id, shop_id, item_id, created_at DESC)',
 'purchase_bill_items history index: exact definition, created_at descending');
select is((select indexdef from pg_indexes where schemaname='public' and indexname='sale_invoice_items_item_history_idx'),
 'CREATE INDEX sale_invoice_items_item_history_idx ON public.sale_invoice_items USING btree (tenant_id, shop_id, item_id, created_at DESC)',
 'sale_invoice_items history index: exact definition, created_at descending');
select is((select indexdef from pg_indexes where schemaname='public' and indexname='sale_return_items_item_history_idx'),
 'CREATE INDEX sale_return_items_item_history_idx ON public.sale_return_items USING btree (tenant_id, shop_id, item_id, created_at DESC)',
 'sale_return_items history index: exact definition, created_at descending');
-- Plain (non-unique, non-partial) and valid: CONCURRENTLY was not used, so no INVALID leftover is possible.
select is((select count(*)::int from pg_index i join pg_class c on c.oid=i.indexrelid
  where c.relname in ('purchase_bill_items_item_history_idx','sale_invoice_items_item_history_idx','sale_return_items_item_history_idx')
    and i.indisvalid and i.indisready and not i.indisunique and i.indpred is null),3,
 'all three history indexes are valid, ready, non-unique and non-partial');
select is((select indoption[3] & 1 from pg_index where indexrelid='public.purchase_bill_items_item_history_idx'::regclass)::int,1,
 'purchase_bill_items history index stores created_at descending');
select is((select array_agg((indoption[k] & 1)::int order by k) from pg_index, generate_series(0,2) k
  where indexrelid='public.purchase_bill_items_item_history_idx'::regclass),array[0,0,0],
 'purchase_bill_items history index leading columns are ascending');
select * from finish();
rollback;
