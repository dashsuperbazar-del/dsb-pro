-- Phase 4 allocation integrity.
-- Serialize allocations on the target document and prevent cumulative over-allocation
-- across multiple payments, not merely within one payment.
create or replace function phase4_validate_allocation() returns trigger
language plpgsql security definer set search_path=public as $$
declare
  v_payment payments%rowtype;
  v_customer uuid;
  v_party uuid;
  v_doc_total bigint;
  v_allocated bigint;
begin
  select * into v_payment
  from payments
  where id=new.payment_id and tenant_id=new.tenant_id;
  if not found or v_payment.status<>'POSTED' then raise exception 'payment unavailable'; end if;

  if new.doc_type='SALE' then
    -- Lock the invoice so two simultaneous payments cannot both observe the same
    -- outstanding amount and over-allocate it.
    select customer_id,total_paise into v_customer,v_doc_total
    from sale_invoices
    where id=new.sale_invoice_id and tenant_id=new.tenant_id and status='FINALIZED'
    for update;
    if not found then raise exception 'sale unavailable'; end if;
    if v_payment.kind<>'customer' or v_customer is distinct from v_payment.customer_id then
      raise exception 'payment and sale customer mismatch';
    end if;
    select coalesce(sum(amount_paise),0) into v_allocated
    from payment_allocations
    where tenant_id=new.tenant_id and sale_invoice_id=new.sale_invoice_id and status='POSTED';
  else
    select party_id,total_paise into v_party,v_doc_total
    from purchase_bills
    where id=new.purchase_bill_id and tenant_id=new.tenant_id and status='POSTED'
    for update;
    if not found then raise exception 'purchase unavailable'; end if;
    if v_payment.kind<>'party' or v_party is distinct from v_payment.party_id then
      raise exception 'payment and purchase party mismatch';
    end if;
    select coalesce(sum(amount_paise),0) into v_allocated
    from payment_allocations
    where tenant_id=new.tenant_id and purchase_bill_id=new.purchase_bill_id and status='POSTED';
  end if;

  if v_allocated + new.amount_paise > v_doc_total then
    raise exception 'allocation exceeds document outstanding amount';
  end if;
  return new;
end $$;

-- Customer-facing projection for allocation UI. Overall customer balance remains
-- independent of allocations; this view only tracks per-invoice settlement.
create view customer_invoice_outstanding with(security_invoker=true) as
select
  s.tenant_id,
  s.customer_id,
  s.id sale_invoice_id,
  s.doc_no,
  s.business_date,
  s.total_paise,
  coalesce(sum(a.amount_paise) filter(where a.status='POSTED'),0)::bigint allocated_paise,
  (s.total_paise-coalesce(sum(a.amount_paise) filter(where a.status='POSTED'),0))::bigint outstanding_paise
from sale_invoices s
left join payment_allocations a on a.tenant_id=s.tenant_id and a.sale_invoice_id=s.id
where s.customer_id is not null and s.status='FINALIZED' and s.deleted_at is null
group by s.tenant_id,s.customer_id,s.id,s.doc_no,s.business_date,s.total_paise
having s.total_paise-coalesce(sum(a.amount_paise) filter(where a.status='POSTED'),0)>0;

grant select on customer_invoice_outstanding to authenticated;
