-- itemindex: read indexes for per-item history. No data, money, RLS or function change.
-- purchase_bill_items: item purchase price history (adapters/src/priceHistory.ts) filters shop_id + item_id
-- and orders by created_at desc; RLS adds the tenant_id filter.
-- sale_invoice_items / sale_return_items: the demand chart (adapters/src/demand.ts) filters shop_id + item_id,
-- created_at >= since, ordered by created_at desc, so both get the matching index.
-- Plain CREATE INDEX (not CONCURRENTLY): scripts/apply-migrations-with-receipts.mjs applies every group inside
-- one transaction, and CREATE INDEX CONCURRENTLY cannot run in a transaction block. The build briefly blocks
-- writes to these three tables; at one-shop row counts that is well under a second.
create index if not exists purchase_bill_items_item_history_idx
 on purchase_bill_items(tenant_id,shop_id,item_id,created_at desc);
create index if not exists sale_invoice_items_item_history_idx
 on sale_invoice_items(tenant_id,shop_id,item_id,created_at desc);
create index if not exists sale_return_items_item_history_idx
 on sale_return_items(tenant_id,shop_id,item_id,created_at desc);
