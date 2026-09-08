-- Phase 4 shop-day reconciliation.
-- Server-calculated EOD evidence so the real-shop gate can be compared without
-- hand-added browser totals. Read-only; no financial state is mutated.
create function get_shop_day_reconciliation(p_shop_id uuid,p_business_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path=public
as $$
declare
  v_tenant uuid;
  v_date date;
  v_result jsonb;
begin
  v_tenant:=phase3_assert_shop(p_shop_id);
  v_date:=coalesce(p_business_date,shop_business_date(p_shop_id));

  with
  finalized as (
    select id,total_paise,discount_paise,extra_charges_paise
    from sale_invoices
    where tenant_id=v_tenant and shop_id=p_shop_id and business_date=v_date
      and status='FINALIZED' and deleted_at is null
  ),
  voided as (
    select id,total_paise
    from sale_invoices
    where tenant_id=v_tenant and shop_id=p_shop_id and business_date=v_date
      and status='VOID' and deleted_at is null
  ),
  direct_sale_receipts as (
    select p.id,p.amount_paise,p.mode
    from payments p
    join finalized f on f.id=p.source_sale_invoice_id
    where p.tenant_id=v_tenant and p.shop_id=p_shop_id and p.business_date=v_date
      and p.status='POSTED' and p.deleted_at is null
      and p.kind in ('walkin','customer')
  ),
  standalone_customer_receipts as (
    select p.id,p.amount_paise,p.mode
    from payments p
    where p.tenant_id=v_tenant and p.shop_id=p_shop_id and p.business_date=v_date
      and p.status='POSTED' and p.deleted_at is null
      and p.kind='customer' and p.source_sale_invoice_id is null
  ),
  standalone_allocations as (
    select r.id payment_id,coalesce(sum(pa.amount_paise) filter(where pa.status='POSTED' and pa.deleted_at is null),0)::bigint allocated_paise
    from standalone_customer_receipts r
    left join payment_allocations pa on pa.payment_id=r.id and pa.tenant_id=v_tenant
    group by r.id
  ),
  receipts as (
    select amount_paise,mode from direct_sale_receipts
    union all
    select amount_paise,mode from standalone_customer_receipts
  ),
  balance_events as (
    select customer_id,total_paise::bigint delta
    from sale_invoices
    where tenant_id=v_tenant and shop_id=p_shop_id and customer_id is not null
      and status='FINALIZED' and deleted_at is null
    union all
    select customer_id,-amount_paise::bigint
    from payments
    where tenant_id=v_tenant and shop_id=p_shop_id and kind='customer'
      and customer_id is not null and status='POSTED' and deleted_at is null
  ),
  customer_balances_now as (
    select customer_id,sum(delta)::bigint balance_paise
    from balance_events
    group by customer_id
  ),
  sold as (
    select sii.item_id,
           max(sii.item_name_snapshot) item_name,
           max(case sii.unit_level
                 when 1 then i.unit1
                 when 2 then i.unit2
                 else i.unit3
               end) sold_unit_name,
           sum(sii.base_qty)::numeric sold_qty_smallest,
           count(*)::bigint sale_lines
    from sale_invoice_items sii
    join sale_invoices si on si.id=sii.sale_invoice_id and si.tenant_id=sii.tenant_id
    join items i on i.id=sii.item_id and i.tenant_id=sii.tenant_id
    where sii.tenant_id=v_tenant and sii.shop_id=p_shop_id
      and si.business_date=v_date and si.status='FINALIZED'
      and sii.deleted_at is null and si.deleted_at is null
    group by sii.item_id
  )
  select jsonb_build_object(
    'businessDate',v_date,
    'invoiceCount',(select count(*)::bigint from finalized),
    'salesTotalPaise',coalesce((select sum(total_paise) from finalized),0)::bigint,
    'discountPaise',coalesce((select sum(discount_paise) from finalized),0)::bigint,
    'extraChargesPaise',coalesce((select sum(extra_charges_paise) from finalized),0)::bigint,
    'voidCount',(select count(*)::bigint from voided),
    'voidedTotalPaise',coalesce((select sum(total_paise) from voided),0)::bigint,
    'directSaleReceiptsPaise',coalesce((select sum(amount_paise) from direct_sale_receipts),0)::bigint,
    'creditCreatedPaise',greatest(
      coalesce((select sum(total_paise) from finalized),0)::bigint -
      coalesce((select sum(amount_paise) from direct_sale_receipts),0)::bigint,0
    ),
    'standaloneCustomerReceiptsPaise',coalesce((select sum(amount_paise) from standalone_customer_receipts),0)::bigint,
    'standaloneAllocatedPaise',coalesce((select sum(a.allocated_paise) from standalone_allocations a),0)::bigint,
    'standaloneAdvancePaise',coalesce((
      select sum(greatest(r.amount_paise-a.allocated_paise,0))
      from standalone_customer_receipts r join standalone_allocations a on a.payment_id=r.id
    ),0)::bigint,
    'allCustomerReceiptsPaise',coalesce((select sum(amount_paise) from receipts),0)::bigint,
    'paymentModes',coalesce((
      select jsonb_build_object(
        'cash',coalesce(sum(amount_paise) filter(where mode='cash'),0)::bigint,
        'upi',coalesce(sum(amount_paise) filter(where mode='upi'),0)::bigint,
        'card',coalesce(sum(amount_paise) filter(where mode='card'),0)::bigint,
        'bank',coalesce(sum(amount_paise) filter(where mode='bank'),0)::bigint,
        'other',coalesce(sum(amount_paise) filter(where mode='other'),0)::bigint
      ) from receipts
    ),'{"cash":0,"upi":0,"card":0,"bank":0,"other":0}'::jsonb),
    'currentCustomerOutstandingPaise',coalesce((
      select sum(greatest(balance_paise,0)) from customer_balances_now
    ),0)::bigint,
    'currentCustomerAdvancePaise',coalesce((
      select sum(greatest(-balance_paise,0)) from customer_balances_now
    ),0)::bigint,
    'soldItems',coalesce((
      select jsonb_agg(jsonb_build_object(
        'itemId',s.item_id,
        'name',s.item_name,
        'soldQtySmallest',s.sold_qty_smallest,
        'saleLines',s.sale_lines,
        'smallestUnit',coalesce(i.unit3,i.unit2,i.unit1),
        'currentStockSmallest',coalesce(sc.qty_base,0)
      ) order by s.item_name)
      from sold s
      join items i on i.id=s.item_id and i.tenant_id=v_tenant
      left join stock_current sc on sc.tenant_id=v_tenant and sc.shop_id=p_shop_id and sc.item_id=s.item_id
    ),'[]'::jsonb)
  ) into v_result;

  return v_result;
end $$;

revoke all on function get_shop_day_reconciliation(uuid,date) from public;
grant execute on function get_shop_day_reconciliation(uuid,date) to authenticated;
