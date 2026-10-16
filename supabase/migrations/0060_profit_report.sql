-- profit: read-only FIFO profit report (owner, manager, accountant: VIEW_REPORTS; cashiers never).
-- Nothing here writes. FIFO runs per (shop, item) over the WHOLE history up to the period end, because sales
-- before the period use up the oldest cost layers; only lines dated inside the period are reported.
--   Cost layers  = purchase lines of POSTED bills (net of the bill discount, phase65_purchase_line_cap) plus
--                  positive stock adjustments (opening stock, count gains), whose cost is UNKNOWN.
--   Consumption  = sale lines of FINALIZED invoices (COGS) plus negative adjustments and purchase returns
--                  (they use up layers but are not cost of goods sold).
--   A sale unit costed from a purchase layer is KNOWN cost. A unit with no layer left (sold before the
--   purchase was entered, or stock that predates the system) is ESTIMATED at the item's latest purchase unit
--   cost; with no purchase at all it is UNKNOWN and its revenue is reported apart, never as profit.
--   Sale returns back to sellable stock credit the ORIGINAL sale line's cost pro rata; the returned units do
--   not re-enter the queue (so a later sale may be costed from a newer batch). Other dispositions keep the cost.
--   Voided bills/invoices are excluded as if they never happened. Revenue is the invoice allocation used by the
--   item-sales report (after discounts, before extra charges and round-off); GST printed on bills is inside it.
-- Money is returned as text paise. Quantities are base-unit numerics as text.
create function get_profit_report(p_shop_id uuid,p_from date,p_to date) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=phase6_assert_report_access(); v_out jsonb;
begin
 perform phase3_assert_shop(p_shop_id);
 if p_from is null or p_to is null or p_from>p_to then
   raise exception 'DSB_INVALID_PERIOD: choose a start date on or before the end date';
 end if;
 with
 purchase_layers as (
  select pbi.item_id,b.business_date d,pbi.created_at ts,pbi.id oid,pbi.base_qty qty,
         phase65_purchase_line_cap(pbi.id)::numeric cost,true known
  from purchase_bill_items pbi join purchase_bills b on b.tenant_id=pbi.tenant_id and b.id=pbi.purchase_bill_id
  where pbi.tenant_id=v_tenant and pbi.shop_id=p_shop_id and b.status='POSTED' and b.business_date<=p_to and pbi.base_qty>0
 ), adj_in as (
  select sm.item_id,sm.created_at::date d,sm.created_at ts,sm.id oid,sm.qty_base qty,0::numeric cost,false known
  from stock_movements sm
  where sm.tenant_id=v_tenant and sm.shop_id=p_shop_id and sm.source_type='ADJUSTMENT' and sm.qty_base>0 and sm.created_at::date<=p_to
 ), layers as (
  select x.*,sum(x.qty) over (partition by x.item_id order by x.d,x.ts,x.oid) ce
  from (select * from purchase_layers union all select * from adj_in) x
 ), last_unit as (
  select distinct on (item_id) item_id,cost/qty unit from purchase_layers order by item_id,d desc,ts desc,oid desc
 ), sale_out as (
  select sii.item_id,si.business_date d,sii.created_at ts,sii.id oid,sii.base_qty qty,true is_sale
  from sale_invoice_items sii join sale_invoices si on si.tenant_id=sii.tenant_id and si.id=sii.sale_invoice_id
  where sii.tenant_id=v_tenant and sii.shop_id=p_shop_id and si.status='FINALIZED' and si.business_date<=p_to and sii.base_qty>0
 ), other_out as (
  select pri.item_id,pr.business_date d,pri.created_at ts,pri.id oid,pri.base_qty qty,false is_sale
  from purchase_return_items pri join purchase_returns pr on pr.tenant_id=pri.tenant_id and pr.id=pri.purchase_return_id
  where pri.tenant_id=v_tenant and pri.shop_id=p_shop_id and pr.status='POSTED' and pr.business_date<=p_to and pri.base_qty>0
  union all
  select sm.item_id,sm.created_at::date,sm.created_at,sm.id,-sm.qty_base,false
  from stock_movements sm
  where sm.tenant_id=v_tenant and sm.shop_id=p_shop_id and sm.source_type='ADJUSTMENT' and sm.qty_base<0 and sm.created_at::date<=p_to
 ), outs as (
  select x.*,sum(x.qty) over (partition by x.item_id order by x.d,x.ts,x.oid) oe
  from (select * from sale_out union all select * from other_out) x
 ), wanted as (  -- only the lines the report needs costed: in the period, or credited by a return in the period
  select o.* from outs o
  where o.is_sale and (o.d between p_from and p_to or o.oid in (
     select sri.sale_invoice_item_id from sale_return_items sri join sale_returns sr on sr.tenant_id=sri.tenant_id and sr.id=sri.sale_return_id
     where sri.tenant_id=v_tenant and sri.shop_id=p_shop_id and sr.status='POSTED' and sr.business_date between p_from and p_to))
 ), matched as (
  select w.item_id,w.oid,w.d,w.qty,
    coalesce(sum(m.ov*m.cost/m.lqty) filter (where m.known),0) known_raw,
    coalesce(sum(m.ov) filter (where m.known),0) known_qty,
    coalesce(sum(m.ov) filter (where not m.known),0) unk_layer_qty
  from wanted w left join lateral (
    select l.cost,l.qty lqty,l.known,
           greatest(0,least(w.oe,l.ce)-greatest(w.oe-w.qty,l.ce-l.qty)) ov
    from layers l
    where l.item_id=w.item_id and l.ce>w.oe-w.qty and l.ce-l.qty<w.oe
  ) m on true
  group by w.item_id,w.oid,w.d,w.qty
 ), costed as (
  select mt.item_id,mt.oid,mt.d,mt.qty,
    round(mt.known_raw)::bigint known_cost,
    mt.known_qty,
    (mt.unk_layer_qty+greatest(mt.qty-mt.known_qty-mt.unk_layer_qty,0)) est_qty,
    lu.unit last_unit
  from matched mt left join last_unit lu on lu.item_id=mt.item_id
 ), line_cost as (
  select c.*,
    case when c.last_unit is null then 0 else round(c.est_qty*c.last_unit)::bigint end est_cost,
    case when c.last_unit is null then c.est_qty else 0 end unknown_qty
  from costed c
 ), period_lines as (
  select lc.item_id,lc.oid,lc.qty,lc.known_cost,lc.est_cost,lc.unknown_qty,
         phase65_sale_line_cap(lc.oid) rev,
         (select max(sii.item_name_snapshot) from sale_invoice_items sii where sii.id=lc.oid) item_name
  from line_cost lc where lc.d between p_from and p_to
 ), line_rev as (
  select pl.*,
    case when pl.qty>0 then round(pl.rev::numeric*pl.unknown_qty/pl.qty)::bigint else 0 end unknown_rev
  from period_lines pl
 ), item_sales as (
  select lr.item_id,max(lr.item_name) item_name,sum(lr.qty) qty_sold,sum(lr.rev)::bigint revenue,
         sum(lr.known_cost)::bigint known_cost,sum(lr.est_cost)::bigint est_cost,
         sum(lr.unknown_qty) unknown_qty,sum(lr.unknown_rev)::bigint unknown_rev
  from line_rev lr group by lr.item_id
 ), item_returns as (
  select sri.item_id,max(sri.item_name_snapshot) item_name,sum(sri.base_qty) qty_returned,sum(sri.amount_paise)::bigint amount,
    coalesce(sum(case when sri.disposition='RETURN_TO_SELLABLE' and lc.qty>0
        then round(lc.known_cost::numeric*sri.base_qty/lc.qty) else 0 end),0)::bigint known_credit,
    coalesce(sum(case when sri.disposition='RETURN_TO_SELLABLE' and lc.qty>0
        then round(lc.est_cost::numeric*sri.base_qty/lc.qty) else 0 end),0)::bigint est_credit
  from sale_return_items sri join sale_returns sr on sr.tenant_id=sri.tenant_id and sr.id=sri.sale_return_id
  left join line_cost lc on lc.oid=sri.sale_invoice_item_id
  where sri.tenant_id=v_tenant and sri.shop_id=p_shop_id and sr.status='POSTED' and sr.business_date between p_from and p_to
  group by sri.item_id
 ), per_item as (
  select coalesce(s.item_id,r.item_id) item_id,coalesce(s.item_name,r.item_name) item_name,
    coalesce(s.qty_sold,0) qty_sold,coalesce(r.qty_returned,0) qty_returned,
    coalesce(s.revenue,0)-coalesce(r.amount,0) net_revenue,
    coalesce(s.known_cost,0)-coalesce(r.known_credit,0) known_cost,
    coalesce(s.est_cost,0)-coalesce(r.est_credit,0) est_cost,
    coalesce(s.unknown_qty,0) unknown_qty,coalesce(s.unknown_rev,0) unknown_rev
  from item_sales s full outer join item_returns r on r.item_id=s.item_id
 ), rows_out as (
  select p.*,
    (p.net_revenue-p.unknown_rev-p.known_cost-p.est_cost) profit,
    (p.net_revenue-p.unknown_rev) costed_revenue
  from per_item p
 )
 select jsonb_build_object(
   'method','FIFO','shopId',p_shop_id,'from',p_from,'to',p_to,
   'summary',jsonb_build_object(
     'netRevenuePaise',coalesce(sum(r.net_revenue),0)::text,
     'costedRevenuePaise',coalesce(sum(r.costed_revenue),0)::text,
     'unknownCostRevenuePaise',coalesce(sum(r.unknown_rev),0)::text,
     'knownCostPaise',coalesce(sum(r.known_cost),0)::text,
     'estimatedCostPaise',coalesce(sum(r.est_cost),0)::text,
     'costOfGoodsPaise',coalesce(sum(r.known_cost+r.est_cost),0)::text,
     'grossProfitPaise',coalesce(sum(r.profit),0)::text,
     'marginBp',case when coalesce(sum(r.costed_revenue),0)>0
        then round(sum(r.profit)::numeric*10000/sum(r.costed_revenue))::bigint else null end,
     'itemCount',count(*),
     'unknownCostItemCount',count(*) filter (where r.unknown_qty>0),
     'estimatedCostItemCount',count(*) filter (where r.est_cost<>0)),
   'items',coalesce((select jsonb_agg(jsonb_build_object(
        'itemId',x.item_id,'name',x.item_name,'qtySold',x.qty_sold::text,'qtyReturned',x.qty_returned::text,
        'netRevenuePaise',x.net_revenue::text,'costOfGoodsPaise',(x.known_cost+x.est_cost)::text,
        'estimatedCostPaise',x.est_cost::text,'unknownCostQty',x.unknown_qty::text,
        'unknownCostRevenuePaise',x.unknown_rev::text,'grossProfitPaise',x.profit::text,
        'marginBp',case when x.costed_revenue>0 then round(x.profit::numeric*10000/x.costed_revenue)::bigint else null end)
        order by x.net_revenue desc,x.item_name)
      from (select * from rows_out order by net_revenue desc,item_name limit 500) x),'[]'::jsonb),
   'itemsTruncated',count(*)>500)
 into v_out from rows_out r;
 return v_out;
end $$;
revoke all on function get_profit_report(uuid,date,date) from public,anon;
grant execute on function get_profit_report(uuid,date,date) to authenticated;
