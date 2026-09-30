-- P2 (COMPLETE_REMAINING_BUILD_PLAN §5a): item-wise net sales correction.
--
-- Bug: 0040's get_item_sales_report computed net_sales_paise from the sold
-- side's line_total_paise, which is after line discounts but before the
-- invoice-level (header) discount is allocated across lines. Returns, by
-- contrast, store an amount already capped by phase65_sale_line_cap (0036).
-- So a fully-returned invoice with a header discount reported a positive
-- net equal to that discount instead of 0.
--
-- Fix: the sold side's net uses phase65_sale_line_cap(sii.id) -- the same
-- allocation post_return uses, including the last-line rounding residual --
-- so sold and returned are on the same basis. Extra charges are excluded by
-- construction (the cap allocates subtotal minus discounts only).
--
-- gross_sales_paise keeps its 0040 meaning: after line discounts, BEFORE the
-- remaining invoice-level allocation. It is not pre-all-discounts gross.
-- Returns are attributed to the return's own business_date, not the
-- original sale's (unchanged from 0040): a return-only period reports a
-- negative net for that item.
--
-- Signature and return type are unchanged, so create or replace is safe and
-- client code needs no change.
create or replace function get_item_sales_report(p_shop_id uuid,p_from date,p_to date)
returns table(item_id uuid,item_name text,qty_sold numeric,qty_returned numeric,net_qty numeric,gross_sales_paise bigint,net_sales_paise bigint)
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=phase6_assert_report_access();
begin
 perform phase3_assert_shop(p_shop_id);
 return query
 with sold as (
  select sii.item_id,max(sii.item_name_snapshot) item_name,sum(sii.base_qty) qty,
   sum(sii.line_total_paise)::bigint gross,sum(phase65_sale_line_cap(sii.id))::bigint net
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
  (coalesce(sold.net,0)-coalesce(returned.amt,0))::bigint net_sales_paise
 from sold full outer join returned on returned.item_id=sold.item_id
 order by 7 desc,2;
end $$;
revoke all on function get_item_sales_report(uuid,date,date) from public,anon;
grant execute on function get_item_sales_report(uuid,date,date) to authenticated;

-- phase65_sale_line_cap (0036) filters sale_invoice_items by sale_invoice_id
-- alone, three times per call; the existing (tenant_id,sale_invoice_id)
-- index cannot serve that on Postgres 17. This report now calls the cap once
-- per sold line, so without this index a long-period report is quadratic.
create index if not exists sale_invoice_items_sale_invoice_idx on sale_invoice_items(sale_invoice_id);
