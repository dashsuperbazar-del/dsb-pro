-- Plan §19.1 missing reports: low stock/reorder (the min_stock column has
-- existed since Phase 3 and synced to every device since Phase 5, but no
-- report has ever read it server-side), item-wise sales, purchase register
-- and customer aging. All four are read-only and follow the same access
-- pattern as every existing report RPC (get_day_book, get_stock_valuation,
-- get_gst_summary, get_party_ledger, all in 0030/0034/0036): a
-- phase6_assert_report_access() check (VIEW_REPORTS; owner/manager/
-- accountant, not cashier) plus phase3_assert_shop() where a shop is scoped.
--
-- Every ORDER BY below uses an ordinal position, not a column-name alias.
-- A `returns table(...)` function's OUT parameter names are visible as
-- plpgsql variables inside its own body; an ORDER BY (or a bare/USING-joined
-- column reference) that happens to share a name with one of them raises
-- "column reference is ambiguous" -- caught from the real CI failure on
-- get_item_sales_report's `using(item_id)` (item_id is also an OUT
-- parameter), then applied everywhere else in this file rather than only
-- at the one confirmed failure, since it's the same shadowing rule either
-- way and cannot be re-verified locally this session (Docker unavailable).

create function get_low_stock_report(p_shop_id uuid)
returns table(item_id uuid,item_name text,unit_name text,on_hand numeric,min_stock numeric,shortfall numeric)
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=phase6_assert_report_access();
begin
 perform phase3_assert_shop(p_shop_id);
 return query
 select i.id,i.name,coalesce(i.unit3,i.unit2,i.unit1),coalesce(sc.on_hand,0),i.min_stock,
   greatest(i.min_stock-coalesce(sc.on_hand,0),0) shortfall
 from items i left join stock_current sc on sc.tenant_id=i.tenant_id and sc.shop_id=p_shop_id and sc.item_id=i.id
 where i.tenant_id=v_tenant and i.deleted_at is null and i.is_active and coalesce(sc.on_hand,0)<=i.min_stock
 order by 6 desc,i.name;
end $$;
revoke all on function get_low_stock_report(uuid) from public,anon;
grant execute on function get_low_stock_report(uuid) to authenticated;

-- Sold and returned quantities/value are joined by item, not driven from
-- `items`, and both come from the invoice/return line snapshots -- not a
-- live items join -- so a renamed or deleted item still reports correctly
-- for the period it was actually sold in. Same FULL OUTER JOIN shape as
-- get_shop_day_reconciliation's sold/returned union (0036), for the same
-- reason: an item returned in the period with no sale in the same period
-- (or vice versa) must not be silently dropped by an inner join.
create function get_item_sales_report(p_shop_id uuid,p_from date,p_to date)
returns table(item_id uuid,item_name text,qty_sold numeric,qty_returned numeric,net_qty numeric,gross_sales_paise bigint,net_sales_paise bigint)
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=phase6_assert_report_access();
begin
 perform phase3_assert_shop(p_shop_id);
 return query
 with sold as (
  select sii.item_id,max(sii.item_name_snapshot) item_name,sum(sii.base_qty) qty,sum(sii.line_total_paise)::bigint gross
  from sale_invoice_items sii join sale_invoices si on si.tenant_id=sii.tenant_id and si.id=sii.sale_invoice_id
  where sii.tenant_id=v_tenant and sii.shop_id=p_shop_id and si.status='FINALIZED' and si.business_date between p_from and p_to
  group by sii.item_id
 ), returned as (
  select sri.item_id,max(sri.item_name_snapshot) item_name,sum(sri.base_qty) qty,sum(sri.amount_paise)::bigint amt
  from sale_return_items sri join sale_returns sr on sr.tenant_id=sri.tenant_id and sr.id=sri.sale_return_id
  where sri.tenant_id=v_tenant and sri.shop_id=p_shop_id and sr.status='POSTED' and sr.business_date between p_from and p_to
  group by sri.item_id
 )
 select coalesce(sold.item_id,returned.item_id) item_id,coalesce(sold.item_name,returned.item_name) item_name,
  coalesce(sold.qty,0),coalesce(returned.qty,0),coalesce(sold.qty,0)-coalesce(returned.qty,0),coalesce(sold.gross,0)::bigint,
  (coalesce(sold.gross,0)-coalesce(returned.amt,0))::bigint net_sales_paise
 from sold full outer join returned on returned.item_id=sold.item_id
 order by 7 desc,2;
end $$;
revoke all on function get_item_sales_report(uuid,date,date) from public,anon;
grant execute on function get_item_sales_report(uuid,date,date) to authenticated;

-- A register, not a ledger view: every bill in the period including VOID
-- ones, so a voided purchase stays visible for audit rather than
-- disappearing from the record.
create function get_purchase_register(p_shop_id uuid,p_from date,p_to date)
returns table(bill_id uuid,doc_no text,business_date date,party_name text,subtotal_paise bigint,discount_paise bigint,extra_charges_paise bigint,total_paise bigint,status text)
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=phase6_assert_report_access();
begin
 perform phase3_assert_shop(p_shop_id);
 return query
 select b.id,coalesce(nullif(b.bill_no,''),b.id::text),b.business_date,p.name,
   b.subtotal_paise,b.discount_paise,b.extra_charges_paise,b.total_paise,b.status
 from purchase_bills b left join parties p on p.tenant_id=b.tenant_id and p.id=b.party_id
 where b.tenant_id=v_tenant and b.shop_id=p_shop_id and b.deleted_at is null and b.business_date between p_from and p_to
 order by b.business_date,b.created_at;
end $$;
revoke all on function get_purchase_register(uuid,date,date) from public,anon;
grant execute on function get_purchase_register(uuid,date,date) to authenticated;

-- Built on customer_invoice_outstanding (0036), which already nets returns,
-- allocations and refunds correctly per invoice -- this only buckets that
-- already-correct outstanding figure by age, it does not recompute it.
create function get_customer_aging_report(p_shop_id uuid,p_as_of date)
returns table(customer_id uuid,customer_name text,not_due_paise bigint,days_1_30_paise bigint,days_31_60_paise bigint,days_61_90_paise bigint,days_90_plus_paise bigint,total_outstanding_paise bigint)
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=phase6_assert_report_access();
begin
 perform phase3_assert_shop(p_shop_id);
 return query
 with buckets as (
  select cio.customer_id,(p_as_of-cio.business_date) age_days,cio.outstanding_paise
  from customer_invoice_outstanding cio join sale_invoices si on si.tenant_id=cio.tenant_id and si.id=cio.sale_invoice_id
  where cio.tenant_id=v_tenant and si.shop_id=p_shop_id
 )
 select c.id,c.name,
  coalesce(sum(b.outstanding_paise) filter(where b.age_days<=0),0)::bigint,
  coalesce(sum(b.outstanding_paise) filter(where b.age_days between 1 and 30),0)::bigint,
  coalesce(sum(b.outstanding_paise) filter(where b.age_days between 31 and 60),0)::bigint,
  coalesce(sum(b.outstanding_paise) filter(where b.age_days between 61 and 90),0)::bigint,
  coalesce(sum(b.outstanding_paise) filter(where b.age_days>90),0)::bigint,
  coalesce(sum(b.outstanding_paise),0)::bigint total_outstanding_paise
 from customers c join buckets b on b.customer_id=c.id
 where c.tenant_id=v_tenant
 group by c.id,c.name
 order by 8 desc,c.name;
end $$;
revoke all on function get_customer_aging_report(uuid,date) from public,anon;
grant execute on function get_customer_aging_report(uuid,date) to authenticated;
