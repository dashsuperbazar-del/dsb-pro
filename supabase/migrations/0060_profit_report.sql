-- profit: read-only FIFO profit report (owner, manager, accountant: VIEW_REPORTS; cashiers never).
-- Nothing here writes. FIFO is simulated per (shop, item) in TIME ORDER over the whole history up to the period
-- end, because earlier sales use up the oldest cost layers; only lines dated inside the period are reported.
--   Cost layers  = purchase lines of POSTED bills, at their net cost (bill discount allocated by the same rule
--                  as phase65_purchase_line_cap, plus the bill's extra charges / freight allocated the same way),
--                  and positive stock adjustments (opening stock, count gains), whose cost is UNKNOWN.
--   Consumption  = sale lines of FINALIZED invoices (cost of goods sold), plus negative adjustments and posted
--                  purchase returns (they use up layers but are not cost of goods sold).
--   A sale takes the oldest layers dated on or before the sale (a layer dated later cannot supply an earlier
--   sale). Units covered by a purchase layer are KNOWN cost. Units with no layer available at that time (sold
--   before the purchase, or stock that predates the system) are ESTIMATED at the latest purchase unit cost seen
--   before the sale, else the item's first purchase cost; with no purchase at all they are UNKNOWN: that revenue
--   is reported apart and is never counted as profit.
--   Sale returns back to sellable stock credit the ORIGINAL sale line's cost pro rata; the returned units do not
--   re-enter the queue (a later sale may be costed from a newer batch). Other dispositions keep the cost (a
--   loss). The refund of the unknown-cost share of a line reduces the unknown-cost revenue, never profit.
--   Returns against an invoice that was later voided are ignored with it. Voided bills/invoices are excluded as
--   if they never happened. Revenue is the invoice allocation the item-sales report uses (after discounts,
--   before extra charges and round-off); GST printed on bills is inside it.
-- Money is returned as text paise. Quantities are base-unit numerics as text.

-- Internal: cost of every wanted sale line from a time-ordered FIFO simulation. Not callable by clients.
create function profit_line_costs(p_tenant uuid,p_shop_id uuid,p_from date,p_to date)
returns table(line_id uuid,item_id uuid,d date,qty numeric,known_cost bigint,est_qty numeric,est_cost bigint,unknown_qty numeric)
language plpgsql stable security definer set search_path=public as $$
#variable_conflict use_column
declare
 v_tz text:=coalesce((select s.timezone from shops s where s.id=p_shop_id and s.tenant_id=p_tenant),'Asia/Kolkata');
 e record; v_item uuid:=null;
 q_qty numeric[]:='{}'; q_unit numeric[]:='{}'; q_known boolean[]:='{}'; v_head int:=1;
 v_cum numeric:=0; v_booked bigint:=0; v_line_known bigint; v_last_unit numeric; v_need numeric; v_take numeric; v_known_raw numeric; v_unk_q numeric; v_est_unit numeric; v_est_q numeric;
begin
 for e in
  with pl0 as (
   select pbi.id,pbi.item_id,pbi.purchase_bill_id,pbi.line_no,pbi.line_total_paise,pbi.base_qty,pbi.created_at,
          b.business_date,b.extra_charges_paise,greatest(b.subtotal_paise-b.discount_paise,0) net,
          sum(pbi.line_total_paise) over (partition by pbi.purchase_bill_id) lt_sum,
          row_number() over (partition by pbi.purchase_bill_id order by pbi.line_no desc) rn_last
   from purchase_bill_items pbi join purchase_bills b on b.tenant_id=pbi.tenant_id and b.id=pbi.purchase_bill_id
   where pbi.tenant_id=p_tenant and pbi.shop_id=p_shop_id and b.status='POSTED' and b.business_date<=p_to and pbi.base_qty>0
  ), pl1 as (  -- bill discount and extra charges are spread over the lines by line total: floor, remainder on the last line
   select pl0.*,
     case when lt_sum>0 then floor(line_total_paise::numeric*net/lt_sum) else 0 end dshare,
     case when lt_sum>0 then floor(line_total_paise::numeric*extra_charges_paise/lt_sum) else 0 end eshare
   from pl0
  ), purchase_layers as (
   select pl1.item_id,pl1.business_date d,pl1.created_at ts,pl1.line_no,pl1.id oid,pl1.base_qty qty,
     ((case when pl1.lt_sum=0 then 0
            when pl1.rn_last=1 then pl1.net-(sum(pl1.dshare) over (partition by pl1.purchase_bill_id)-pl1.dshare)
            else pl1.dshare end)
      +(case when pl1.rn_last=1 then pl1.extra_charges_paise-(sum(pl1.eshare) over (partition by pl1.purchase_bill_id)-pl1.eshare)
             else pl1.eshare end))::numeric/pl1.base_qty unit,
     true known
   from pl1
  ), first_unit as (
   select distinct on (item_id) item_id,unit from purchase_layers order by item_id,d,ts,line_no,oid
  ), returned_lines as (
   select sri.sale_invoice_item_id line_id
   from sale_return_items sri join sale_returns sr on sr.tenant_id=sri.tenant_id and sr.id=sri.sale_return_id
   where sri.tenant_id=p_tenant and sri.shop_id=p_shop_id and sr.status='POSTED' and sr.business_date between p_from and p_to
  ), ev as (
   select item_id,d,0 ko,ts,line_no,oid,'L' kind,qty,unit,known,false wanted from purchase_layers
   union all
   select sm.item_id,(sm.created_at at time zone v_tz)::date,0,sm.created_at,0,sm.id,'L',sm.qty_base,0::numeric,false,false
   from stock_movements sm
   where sm.tenant_id=p_tenant and sm.shop_id=p_shop_id and sm.source_type='ADJUSTMENT' and sm.qty_base>0
     and (sm.created_at at time zone v_tz)::date<=p_to
   union all
   select sii.item_id,si.business_date,1,sii.created_at,sii.line_no,sii.id,'S',sii.base_qty,0::numeric,true,
          (si.business_date between p_from and p_to or sii.id in (select line_id from returned_lines))
   from sale_invoice_items sii join sale_invoices si on si.tenant_id=sii.tenant_id and si.id=sii.sale_invoice_id
   where sii.tenant_id=p_tenant and sii.shop_id=p_shop_id and si.status='FINALIZED' and si.business_date<=p_to and sii.base_qty>0
   union all
   select pri.item_id,pr.business_date,1,pri.created_at,0,pri.id,'O',pri.base_qty,0::numeric,true,false
   from purchase_return_items pri join purchase_returns pr on pr.tenant_id=pri.tenant_id and pr.id=pri.purchase_return_id
   where pri.tenant_id=p_tenant and pri.shop_id=p_shop_id and pr.status='POSTED' and pr.business_date<=p_to and pri.base_qty>0
   union all
   select sm.item_id,(sm.created_at at time zone v_tz)::date,1,sm.created_at,0,sm.id,'O',-sm.qty_base,0::numeric,true,false
   from stock_movements sm
   where sm.tenant_id=p_tenant and sm.shop_id=p_shop_id and sm.source_type='ADJUSTMENT' and sm.qty_base<0
     and (sm.created_at at time zone v_tz)::date<=p_to
  )
  select ev.*,fu.unit first_unit
  from ev left join first_unit fu on fu.item_id=ev.item_id
  order by ev.item_id,ev.d,ev.ko,ev.ts,ev.line_no,ev.oid
 loop
  if e.item_id is distinct from v_item then
   v_item:=e.item_id; q_qty:='{}'; q_unit:='{}'; q_known:='{}'; v_head:=1; v_last_unit:=null; v_cum:=0; v_booked:=0;
  end if;
  if e.kind='L' then
   q_qty:=q_qty||e.qty; q_unit:=q_unit||e.unit; q_known:=q_known||e.known;
   if e.known then v_last_unit:=e.unit; end if;
  else
   v_need:=e.qty; v_known_raw:=0; v_unk_q:=0;
   while v_need>0 and v_head<=coalesce(array_length(q_qty,1),0) loop
    v_take:=least(v_need,q_qty[v_head]);
    if q_known[v_head] then v_known_raw:=v_known_raw+v_take*q_unit[v_head]; else v_unk_q:=v_unk_q+v_take; end if;
    q_qty[v_head]:=q_qty[v_head]-v_take;
    if q_qty[v_head]=0 then v_head:=v_head+1; end if;
    v_need:=v_need-v_take;
   end loop;
   if e.kind='S' then
    -- Round the RUNNING exact cost, not each line: lines then add up to the exact cost within half a paisa
    -- instead of losing up to half a paisa on every line (3 pieces costing 10.03 sold one by one: 3.34+3.34+3.35).
    v_cum:=v_cum+v_known_raw; v_line_known:=round(v_cum)::bigint-v_booked; v_booked:=v_booked+v_line_known;
   end if;
   if e.kind='S' and e.wanted then
    v_est_q:=v_unk_q+v_need;
    v_est_unit:=coalesce(v_last_unit,e.first_unit);
    line_id:=e.oid; item_id:=e.item_id; d:=e.d; qty:=e.qty; known_cost:=v_line_known;
    if v_est_unit is null then est_qty:=0; est_cost:=0; unknown_qty:=v_est_q;
    else est_qty:=v_est_q; est_cost:=round(v_est_q*v_est_unit)::bigint; unknown_qty:=0; end if;
    return next;
   end if;
  end if;
 end loop;
end $$;
revoke all on function profit_line_costs(uuid,uuid,date,date) from public,anon,authenticated,service_role;

create function get_profit_report(p_shop_id uuid,p_from date,p_to date) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=phase6_assert_report_access(); v_out jsonb;
begin
 perform phase3_assert_shop(p_shop_id);
 if p_from is null or p_to is null or p_from>p_to then
   raise exception 'DSB_INVALID_PERIOD: choose a start date on or before the end date';
 end if;
 with line_cost as (
  select * from profit_line_costs(v_tenant,p_shop_id,p_from,p_to)
 ), sale_caps0 as (  -- the item-sales report's net allocation: header discount spread by line total, remainder on the last line
  select sii.id,sii.sale_invoice_id,sii.line_no,sii.item_name_snapshot item_name,sii.line_total_paise,
         greatest(si.subtotal_paise-si.discount_paise,0) net,
         sum(sii.line_total_paise) over (partition by sii.sale_invoice_id) line_sum,
         max(sii.line_no) over (partition by sii.sale_invoice_id) last_line
  from sale_invoice_items sii join sale_invoices si on si.tenant_id=sii.tenant_id and si.id=sii.sale_invoice_id
  where sii.tenant_id=v_tenant and sii.shop_id=p_shop_id and si.status='FINALIZED' and si.business_date between p_from and p_to
 ), sale_caps1 as (
  select c.*,case when c.line_sum>0 then floor(c.line_total_paise::numeric*c.net/c.line_sum)::bigint else 0 end share from sale_caps0 c
 ), sale_caps as (
  select c.id,c.item_name,
    case when c.line_sum=0 then 0
         when c.line_no=c.last_line then c.net-(sum(c.share) over (partition by c.sale_invoice_id)-c.share)
         else c.share end cap
  from sale_caps1 c
 ), period_lines as (
  select lc.item_id,lc.line_id,lc.qty,lc.known_cost,lc.est_cost,lc.unknown_qty,
         sc.cap rev,sc.item_name
  from line_cost lc join sale_caps sc on sc.id=lc.line_id
  where lc.d between p_from and p_to
 ), line_rev as (
  select pl.*,case when pl.qty>0 then round(pl.rev::numeric*pl.unknown_qty/pl.qty)::bigint else 0 end unknown_rev
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
        then round(lc.est_cost::numeric*sri.base_qty/lc.qty) else 0 end),0)::bigint est_credit,
    coalesce(sum(case when lc.qty>0 then round(sri.amount_paise::numeric*lc.unknown_qty/lc.qty) else 0 end),0)::bigint unknown_rev_credit,
    coalesce(sum(case when lc.qty>0 then lc.unknown_qty*sri.base_qty/lc.qty else 0 end),0) unknown_qty_credit
  from sale_return_items sri join sale_returns sr on sr.tenant_id=sri.tenant_id and sr.id=sri.sale_return_id
  join sale_invoice_items sii on sii.tenant_id=sri.tenant_id and sii.id=sri.sale_invoice_item_id
  join sale_invoices si on si.tenant_id=sii.tenant_id and si.id=sii.sale_invoice_id and si.status='FINALIZED'
  left join line_cost lc on lc.line_id=sri.sale_invoice_item_id
  where sri.tenant_id=v_tenant and sri.shop_id=p_shop_id and sr.status='POSTED' and sr.business_date between p_from and p_to
  group by sri.item_id
 ), per_item as (
  select coalesce(s.item_id,r.item_id) item_id,coalesce(s.item_name,r.item_name) item_name,
    coalesce(s.qty_sold,0) qty_sold,coalesce(r.qty_returned,0) qty_returned,
    coalesce(s.revenue,0)-coalesce(r.amount,0) net_revenue,
    coalesce(s.known_cost,0)-coalesce(r.known_credit,0) known_cost,
    coalesce(s.est_cost,0)-coalesce(r.est_credit,0) est_cost,
    coalesce(s.unknown_qty,0)-coalesce(r.unknown_qty_credit,0) unknown_qty,
    coalesce(s.unknown_rev,0)-coalesce(r.unknown_rev_credit,0) unknown_rev
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
