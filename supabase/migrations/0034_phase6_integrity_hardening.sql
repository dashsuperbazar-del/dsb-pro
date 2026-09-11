-- Phase 6 audit hardening: report authorization, idempotent expenses,
-- serialized stock counts, stronger invariants and a complete portable export.
set local search_path = public, pg_temp;

create or replace function phase6_assert_report_access()
returns uuid language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id();
begin
 if v_tenant is null or not has_perm('VIEW_REPORTS') then raise exception 'not permitted'; end if;
 return v_tenant;
end $$;
revoke all on function phase6_assert_report_access() from public,anon,authenticated;

-- Cashiers need sell prices, but supplier history, costs, expenses and counts
-- are financial/reporting data. Enforce this below the UI as well as in RPCs.
drop policy if exists parties_read on parties;
create policy parties_read on parties for select using(
 tenant_id=current_tenant_id() and deleted_at is null
 and (has_perm('MANAGE_MASTER_DATA') or has_perm('POST_PURCHASES') or has_perm('VIEW_REPORTS'))
);
drop policy if exists item_prices_read on item_prices;
create policy item_prices_read on item_prices for select using(
 tenant_id=current_tenant_id() and deleted_at is null
 and (kind<>'cost_last' or has_perm('POST_PURCHASES') or has_perm('VIEW_REPORTS'))
);
drop policy if exists purchase_bills_read on purchase_bills;
create policy purchase_bills_read on purchase_bills for select using(
 tenant_id=current_tenant_id() and (has_perm('POST_PURCHASES') or has_perm('VIEW_REPORTS'))
);
drop policy if exists purchase_bill_items_read on purchase_bill_items;
create policy purchase_bill_items_read on purchase_bill_items for select using(
 tenant_id=current_tenant_id() and (has_perm('POST_PURCHASES') or has_perm('VIEW_REPORTS'))
);
drop policy if exists expenses_read on expenses;
create policy expenses_read on expenses for select using(
 tenant_id=current_tenant_id() and (has_perm('POST_EXPENSES') or has_perm('VIEW_REPORTS'))
);
drop policy if exists stock_counts_read on stock_counts;
create policy stock_counts_read on stock_counts for select using(
 tenant_id=current_tenant_id() and (has_perm('COUNT_STOCK') or has_perm('VIEW_REPORTS'))
);
drop policy if exists stock_count_lines_read on stock_count_lines;
create policy stock_count_lines_read on stock_count_lines for select using(
 tenant_id=current_tenant_id() and (has_perm('COUNT_STOCK') or has_perm('VIEW_REPORTS'))
);

create or replace function post_expense(p_shop_id uuid,p_business_date date,p_category text,p_description text,p_amount_paise bigint,p_mode text,p_reference text,p_client_id text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_existing expenses%rowtype; v_id uuid; v_date date:=coalesce(p_business_date,current_date);
begin
 if not has_perm('POST_EXPENSES') then raise exception 'not permitted'; end if;
 v_tenant:=phase3_assert_shop(p_shop_id);
 if p_client_id is null or btrim(p_client_id)='' then raise exception 'client_id required'; end if;
 if p_amount_paise<=0 or p_mode not in ('cash','upi','card','bank','other') or btrim(coalesce(p_category,''))='' or btrim(coalesce(p_description,''))='' then raise exception 'invalid expense'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_tenant::text||':expense:'||p_client_id,0));
 select * into v_existing from expenses where tenant_id=v_tenant and client_id=p_client_id for update;
 if found then
   if v_existing.shop_id<>p_shop_id or v_existing.business_date<>v_date
      or v_existing.category<>btrim(p_category) or v_existing.description<>btrim(p_description)
      or v_existing.amount_paise<>p_amount_paise or v_existing.mode<>p_mode
      or v_existing.reference is distinct from p_reference then
     raise exception 'client_id already used with different expense payload';
   end if;
   return v_existing.id;
 end if;
 insert into expenses(tenant_id,shop_id,business_date,category,description,amount_paise,mode,reference,client_id)
 values(v_tenant,p_shop_id,v_date,btrim(p_category),btrim(p_description),p_amount_paise,p_mode,p_reference,p_client_id)
 returning id into v_id;
 return v_id;
end $$;

create or replace function post_stock_count(p_stock_count_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_count stock_counts%rowtype; v_line stock_count_lines%rowtype; v_now numeric;
begin
 if not has_perm('COUNT_STOCK') then raise exception 'not permitted'; end if;
 select * into v_count from stock_counts where id=p_stock_count_id and tenant_id=v_tenant for update;
 if not found or v_count.status<>'DRAFT' then raise exception 'stock count unavailable'; end if;
 for v_line in select * from stock_count_lines where stock_count_id=v_count.id order by item_id loop
   -- Sales use the same projection row lock. Creating a missing zero row first
   -- closes the no-row race and makes count-vs-sale serialization deterministic.
   insert into stock_current(tenant_id,shop_id,item_id,on_hand,reserved)
   values(v_tenant,v_count.shop_id,v_line.item_id,0,0) on conflict do nothing;
   select qty_base into v_now from stock_current
   where tenant_id=v_tenant and shop_id=v_count.shop_id and item_id=v_line.item_id for update;
   if v_now<>v_line.expected_qty then raise exception 'stock changed since count was captured; recount required'; end if;
   if v_line.variance_qty<>0 then
     insert into stock_movements(tenant_id,shop_id,item_id,source_type,source_id,qty_base,client_id)
     values(v_tenant,v_count.shop_id,v_line.item_id,'ADJUSTMENT',v_count.id,v_line.variance_qty,'stock-count:'||v_line.id::text);
   end if;
 end loop;
 update stock_counts set status='POSTED',posted_at=clock_timestamp() where id=v_count.id;
end $$;

create or replace function get_party_ledger(p_party_id uuid,p_from date default null,p_to date default null)
returns table(business_date date,entry_type text,document text,debit_paise bigint,credit_paise bigint,running_balance_paise bigint)
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=phase6_assert_report_access();
begin
 return query
 with entries(entry_date,entry_kind,entry_document,debit,credit,entry_created,entry_id) as (
  select pb.business_date,'PURCHASE'::text,coalesce(pb.bill_no,pb.id::text),pb.total_paise::bigint,0::bigint,pb.created_at,pb.id
  from purchase_bills pb where pb.tenant_id=v_tenant and pb.party_id=p_party_id and pb.status='POSTED'
    and (p_to is null or pb.business_date<=p_to)
  union all
  select p.business_date,'PAYMENT'::text,coalesce(p.reference,p.id::text),0::bigint,p.amount_paise::bigint,p.created_at,p.id
  from payments p where p.tenant_id=v_tenant and p.party_id=p_party_id and p.status='POSTED'
    and (p_to is null or p.business_date<=p_to)
 ), balances as (
  select *,sum(debit-credit) over(order by entry_date,entry_created,entry_id) balance from entries
 )
 select entry_date,entry_kind,entry_document,debit,credit,balance::bigint from balances
 where p_from is null or entry_date>=p_from order by entry_date,entry_created,entry_id;
end $$;

create or replace function get_day_book(p_shop_id uuid,p_from date,p_to date)
returns table(business_date date,sales_paise bigint,purchases_paise bigint,receipts_paise bigint,payments_paise bigint,expenses_paise bigint,net_cashflow_paise bigint)
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=phase6_assert_report_access();
begin
 perform phase3_assert_shop(p_shop_id);
 return query
 with d as (select generate_series(p_from,p_to,'1 day'::interval)::date entry_date)
 select d.entry_date,
  coalesce((select sum(total_paise) from sale_invoices s where s.tenant_id=v_tenant and s.shop_id=p_shop_id and s.status='FINALIZED' and s.business_date=d.entry_date),0)::bigint,
  coalesce((select sum(total_paise) from purchase_bills b where b.tenant_id=v_tenant and b.shop_id=p_shop_id and b.status='POSTED' and b.business_date=d.entry_date),0)::bigint,
  coalesce((select sum(amount_paise) from payments p where p.tenant_id=v_tenant and p.shop_id=p_shop_id and p.kind='customer' and p.status='POSTED' and p.business_date=d.entry_date),0)::bigint,
  coalesce((select sum(amount_paise) from payments p where p.tenant_id=v_tenant and p.shop_id=p_shop_id and p.kind='party' and p.status='POSTED' and p.business_date=d.entry_date),0)::bigint,
  coalesce((select sum(amount_paise) from expenses e where e.tenant_id=v_tenant and e.shop_id=p_shop_id and e.status='POSTED' and e.business_date=d.entry_date),0)::bigint,
  (coalesce((select sum(amount_paise) from payments p where p.tenant_id=v_tenant and p.shop_id=p_shop_id and p.kind='customer' and p.status='POSTED' and p.business_date=d.entry_date),0)
   -coalesce((select sum(amount_paise) from payments p where p.tenant_id=v_tenant and p.shop_id=p_shop_id and p.kind='party' and p.status='POSTED' and p.business_date=d.entry_date),0)
   -coalesce((select sum(amount_paise) from expenses e where e.tenant_id=v_tenant and e.shop_id=p_shop_id and e.status='POSTED' and e.business_date=d.entry_date),0))::bigint
 from d order by d.entry_date;
end $$;

create or replace function get_stock_valuation(p_shop_id uuid)
returns table(item_id uuid,item_name text,qty_base numeric,cost_paise bigint,value_paise bigint)
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=phase6_assert_report_access();
begin
 perform phase3_assert_shop(p_shop_id);
 return query
 with latest_purchase as (
  select distinct on (pbi.item_id) pbi.item_id,
   case when pbi.base_qty>0 then round(pbi.line_total_paise::numeric/pbi.base_qty)::bigint else 0::bigint end unit_cost
  from purchase_bill_items pbi join purchase_bills pb on pb.tenant_id=pbi.tenant_id and pb.id=pbi.purchase_bill_id
  where pbi.tenant_id=v_tenant and pbi.shop_id=p_shop_id and pb.status='POSTED'
  order by pbi.item_id,pb.business_date desc,pb.created_at desc,pbi.created_at desc
 ), latest_price as (
  select distinct on (ip.item_id) ip.item_id,
   round(ip.price_paise::numeric/case ip.unit_level when 1 then coalesce(i.conv1,1)*coalesce(i.conv2,1) when 2 then coalesce(i.conv2,1) else 1 end)::bigint unit_cost
  from item_prices ip join items i on i.tenant_id=ip.tenant_id and i.id=ip.item_id
  where ip.tenant_id=v_tenant and ip.kind='cost_last'
    and ip.deleted_at is null and ip.effective_from<=clock_timestamp()
    and (ip.effective_to is null or ip.effective_to>clock_timestamp())
    and (ip.shop_id=p_shop_id or ip.shop_id is null)
  order by ip.item_id,(ip.shop_id=p_shop_id) desc,ip.effective_from desc,ip.id desc
 ), valued as (
  select i.id,i.name,coalesce(sc.qty_base,0) qty,coalesce(lp.unit_cost,lpr.unit_cost,0)::bigint cost
  from items i left join stock_current sc on sc.tenant_id=i.tenant_id and sc.shop_id=p_shop_id and sc.item_id=i.id
  left join latest_purchase lp on lp.item_id=i.id left join latest_price lpr on lpr.item_id=i.id
  where i.tenant_id=v_tenant and i.deleted_at is null
 )
 select id,name,qty,cost,round(qty*cost)::bigint from valued order by name;
end $$;

create or replace function get_gst_summary(p_shop_id uuid,p_from date,p_to date)
returns table(tax_rate_bp integer,taxable_sales_paise bigint,gross_sales_paise bigint,taxable_purchases_paise bigint,gross_purchases_paise bigint)
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=phase6_assert_report_access();
begin
 perform phase3_assert_shop(p_shop_id);
 return query
 with sale_base as (
  select sii.tax_rate_bp_snapshot rate,sii.line_total_paise,si.id invoice_id,
   greatest(si.subtotal_paise-si.discount_paise,0)::bigint after_all_discounts,
   sum(sii.line_total_paise) over(partition by si.id)::bigint after_line_discounts
  from sale_invoice_items sii join sale_invoices si on si.tenant_id=sii.tenant_id and si.id=sii.sale_invoice_id
  where sii.tenant_id=v_tenant and sii.shop_id=p_shop_id and si.status='FINALIZED' and si.business_date between p_from and p_to
 ), sale_lines as (
  select rate,case when after_line_discounts>0 then round(line_total_paise::numeric*after_all_discounts/after_line_discounts)::bigint else 0::bigint end adjusted from sale_base
 ), purchase_lines as (
  select pbi.tax_rate_bp_snapshot rate,
   case when pb.subtotal_paise>0 then round(pbi.line_total_paise::numeric*greatest(pb.subtotal_paise-pb.discount_paise,0)/pb.subtotal_paise)::bigint else 0::bigint end adjusted
  from purchase_bill_items pbi join purchase_bills pb on pb.tenant_id=pbi.tenant_id and pb.id=pbi.purchase_bill_id
  where pbi.tenant_id=v_tenant and pbi.shop_id=p_shop_id and pb.status='POSTED' and pb.business_date between p_from and p_to
 ), s as (select rate,sum(adjusted)::bigint gross from sale_lines group by rate),
 p as (select rate,sum(adjusted)::bigint gross from purchase_lines group by rate),rates as (select rate from s union select rate from p)
 select r.rate,round(coalesce(s.gross,0)*10000.0/(10000+r.rate))::bigint,coalesce(s.gross,0)::bigint,
  round(coalesce(p.gross,0)*10000.0/(10000+r.rate))::bigint,coalesce(p.gross,0)::bigint
 from rates r left join s using(rate) left join p using(rate) order by r.rate;
end $$;

create or replace function phase6_export_tenant(p_shop_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid;
begin
 if not has_perm('EXPORT_DATA') then raise exception 'not permitted'; end if;
 v_tenant:=phase3_assert_shop(p_shop_id);
 return jsonb_build_object(
  'schemaVersion',3,'exportKind','portable-business-data','exportedAt',clock_timestamp(),'tenantId',v_tenant,'shopId',p_shop_id,
  'tenant',coalesce((select to_jsonb(x) from (select * from tenants where id=v_tenant) x),'{}'::jsonb),
  'shops',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from shops where tenant_id=v_tenant) x),'[]'::jsonb),
  'tenantUsers',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from tenant_users where tenant_id=v_tenant) x),'[]'::jsonb),
  'devices',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from devices where tenant_id=v_tenant) x),'[]'::jsonb),
  'categories',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from categories where tenant_id=v_tenant) x),'[]'::jsonb),
  'items',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from items where tenant_id=v_tenant) x),'[]'::jsonb),
  'itemBarcodes',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from item_barcodes where tenant_id=v_tenant) x),'[]'::jsonb),
  'itemPrices',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from item_prices where tenant_id=v_tenant) x),'[]'::jsonb),
  'parties',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from parties where tenant_id=v_tenant) x),'[]'::jsonb),
  'customers',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from customers where tenant_id=v_tenant) x),'[]'::jsonb),
  'purchases',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from purchase_bills where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'purchaseLines',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from purchase_bill_items where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'sales',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from sale_invoices where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'saleLines',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from sale_invoice_items where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'payments',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from payments where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'allocations',coalesce((select jsonb_agg(to_jsonb(x)) from (select pa.* from payment_allocations pa join payments p on p.tenant_id=pa.tenant_id and p.id=pa.payment_id where pa.tenant_id=v_tenant and p.shop_id=p_shop_id) x),'[]'::jsonb),
  'stockMovements',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from stock_movements where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'stockCurrent',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from stock_current where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'expenses',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from expenses where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'stockCounts',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from stock_counts where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'stockCountLines',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from stock_count_lines where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'documentSequences',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from doc_sequences where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'auditLog',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from audit_log where tenant_id=v_tenant) x),'[]'::jsonb),
  'syncConflicts',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from sync_conflicts where tenant_id=v_tenant) x),'[]'::jsonb),
  'legacyImportRuns',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from legacy_import_runs where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb)
 );
end $$;

create or replace function check_invariants()
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=phase6_assert_report_access(); bad_sales bigint; bad_purchases bigint; bad_stock bigint; bad_alloc bigint; bad_projection bigint; bad_voids bigint;
begin
 select count(*) into bad_sales from sale_invoices s where s.tenant_id=v_tenant and s.status='FINALIZED' and
  (s.subtotal_paise<>(select coalesce(sum(li.line_total_paise+li.discount_paise),0) from sale_invoice_items li where li.sale_invoice_id=s.id)
   or s.total_paise<>s.subtotal_paise-s.discount_paise+s.extra_charges_paise);
 select count(*) into bad_purchases from purchase_bills b where b.tenant_id=v_tenant and b.status='POSTED' and
  (b.subtotal_paise<>(select coalesce(sum(li.line_total_paise),0) from purchase_bill_items li where li.purchase_bill_id=b.id)
   or b.total_paise<>b.subtotal_paise-b.discount_paise+b.extra_charges_paise);
 select count(*) into bad_stock from stock_current where tenant_id=v_tenant and qty_base<0;
 select count(*) into bad_alloc from payments p where p.tenant_id=v_tenant and
  (select coalesce(sum(amount_paise),0) from payment_allocations a where a.payment_id=p.id and a.status='POSTED')>p.amount_paise;
 select count(*) into bad_projection from (
  select coalesce(sc.shop_id,m.shop_id) shop_id,coalesce(sc.item_id,m.item_id) item_id,
   coalesce(sc.qty_base,0) projected,coalesce(m.moved,0) moved
  from stock_current sc full join (
   select tenant_id,shop_id,item_id,sum(qty_base) moved from stock_movements where tenant_id=v_tenant group by tenant_id,shop_id,item_id
  ) m on m.tenant_id=sc.tenant_id and m.shop_id=sc.shop_id and m.item_id=sc.item_id
  where coalesce(sc.tenant_id,m.tenant_id)=v_tenant
 ) q where q.projected<>q.moved;
 -- A void document must have an exact, item-by-item movement reversal.
 select count(*) into bad_voids from (
  select s.id,m.item_id,sum(m.qty_base) net from sale_invoices s join stock_movements m on m.tenant_id=s.tenant_id and m.source_id=s.id
  where s.tenant_id=v_tenant and s.status='VOID' and m.source_type in ('SALE','SALE_VOID') group by s.id,m.item_id having sum(m.qty_base)<>0
  union all
  select p.id,m.item_id,sum(m.qty_base) net from purchase_bills p join stock_movements m on m.tenant_id=p.tenant_id and m.source_id=p.id
  where p.tenant_id=v_tenant and p.status='VOID' and m.source_type in ('PURCHASE','PURCHASE_VOID') group by p.id,m.item_id having sum(m.qty_base)<>0
 ) violations;
 return jsonb_build_object('ok',bad_sales=0 and bad_purchases=0 and bad_stock=0 and bad_alloc=0 and bad_projection=0 and bad_voids=0,
  'saleTotalViolations',bad_sales,'purchaseTotalViolations',bad_purchases,'negativeStock',bad_stock,
  'allocationViolations',bad_alloc,'stockProjectionViolations',bad_projection,'voidReversalViolations',bad_voids);
end $$;

revoke all on function post_expense(uuid,date,text,text,bigint,text,text,text),post_stock_count(uuid),get_party_ledger(uuid,date,date),get_day_book(uuid,date,date),get_stock_valuation(uuid),get_gst_summary(uuid,date,date),phase6_export_tenant(uuid),check_invariants() from public,anon;
grant execute on function post_expense(uuid,date,text,text,bigint,text,text,text),post_stock_count(uuid),get_party_ledger(uuid,date,date),get_day_book(uuid,date,date),get_stock_valuation(uuid),get_gst_summary(uuid,date,date),phase6_export_tenant(uuid),check_invariants() to authenticated;
