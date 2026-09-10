\set ON_ERROR_STOP on

-- Variables required from psql -v:
-- perf_user, perf_tenant, perf_shop
-- All data is synthetic and this script is intended ONLY for a disposable local Supabase database.

set session_replication_role = replica;

-- Keep the single Auth user/tenant created through the real API. Bulk synthetic
-- rows use fixed provenance and skip audit/projection triggers during fixture
-- generation so setup time is not mistaken for application performance.

insert into public.items(
  tenant_id,name,sku,unit1,tax_rate_bp,min_stock,created_by,client_id,updated_at
)
select
  :'perf_tenant'::uuid,
  'Performance Item '||lpad(g::text,5,'0'),
  'PERF-'||lpad(g::text,5,'0'),
  'piece',500,0,:'perf_user'::uuid,
  'perf-item-'||g,
  1000000+g
from generate_series(1,10000) g;

insert into public.item_barcodes(
  tenant_id,item_id,barcode,unit_level,created_by,client_id,updated_at
)
select
  :'perf_tenant'::uuid,i.id,'890'||lpad(row_number() over(order by i.sku)::text,10,'0'),1,
  :'perf_user'::uuid,'perf-barcode-'||row_number() over(order by i.sku),2000000+row_number() over(order by i.sku)
from public.items i
where i.tenant_id=:'perf_tenant'::uuid and i.sku like 'PERF-%';

insert into public.item_prices(
  tenant_id,item_id,shop_id,kind,unit_level,price_paise,effective_from,
  created_by,client_id,updated_at
)
select
  :'perf_tenant'::uuid,i.id,:'perf_shop'::uuid,'retail',1,
  1000+(row_number() over(order by i.sku)%5000),
  '2026-01-01 00:00:00+00'::timestamptz,
  :'perf_user'::uuid,'perf-price-'||row_number() over(order by i.sku),
  3000000+row_number() over(order by i.sku)
from public.items i
where i.tenant_id=:'perf_tenant'::uuid and i.sku like 'PERF-%';

insert into public.stock_current(tenant_id,shop_id,item_id,on_hand,reserved,updated_at)
select :'perf_tenant'::uuid,:'perf_shop'::uuid,i.id,100,0,
       4000000+row_number() over(order by i.sku)
from public.items i
where i.tenant_id=:'perf_tenant'::uuid and i.sku like 'PERF-%';

insert into public.sale_invoices(
  tenant_id,shop_id,doc_no,doc_seq,business_date,status,
  subtotal_paise,discount_paise,extra_charges_paise,total_paise,finalized_at,
  created_by,client_id,updated_at
)
select
  :'perf_tenant'::uuid,:'perf_shop'::uuid,
  'PERF-'||lpad(g::text,6,'0'),g,
  date '2025-01-01'+((g-1)%365),
  'FINALIZED',1000,0,0,1000,
  timestamptz '2025-01-01 00:00:00+00'+((g-1)%365)*interval '1 day',
  :'perf_user'::uuid,'perf-sale-'||g,5000000+g
from generate_series(1,100000) g;

set session_replication_role = origin;

analyze public.items;
analyze public.item_barcodes;
analyze public.item_prices;
analyze public.stock_current;
analyze public.sale_invoices;

select 'items='||count(*) from public.items where tenant_id=:'perf_tenant'::uuid;
select 'barcodes='||count(*) from public.item_barcodes where tenant_id=:'perf_tenant'::uuid;
select 'prices='||count(*) from public.item_prices where tenant_id=:'perf_tenant'::uuid;
select 'stock='||count(*) from public.stock_current where tenant_id=:'perf_tenant'::uuid and shop_id=:'perf_shop'::uuid;
select 'invoices='||count(*) from public.sale_invoices where tenant_id=:'perf_tenant'::uuid;
