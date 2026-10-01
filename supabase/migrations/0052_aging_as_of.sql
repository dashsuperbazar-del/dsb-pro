-- Packet D1-lite (group d1): as-of outstanding and aging for customers and suppliers
-- (COMPLETE_REMAINING_BUILD_PLAN v1.1 §9.2). Read-only; no table changes.
-- As of date D, within one shop:
--   documents with business_date<=D; returns and linked refunds with business_date<=D;
--   allocations only when the allocation effective_date<=D and the payment business_date<=D;
--   VOID rows are excluded at every D (history is restated, labelled VOIDS_RESTATED).
-- Signed due per document can be negative (returned after payment); it is reported as a credit,
-- never hidden in a clamped bucket. Unallocated cash is reported separately. Bridge (asserted in tests):
--   customer: netLedgerBalance = sum(signedDue) - unallocatedReceipts + unlinkedRefunds
--   supplier: netLedgerBalance = sum(signedDue) - unallocatedPayments + unassignedReceipts
-- Buckets age the source document from its business_date: 0 days, 1-30, 31-60, 61-90, over 90.

create index if not exists d1_alloc_sale_eff_idx on payment_allocations(tenant_id,sale_invoice_id,effective_date) where status='POSTED';
create index if not exists d1_alloc_bill_eff_idx on payment_allocations(tenant_id,purchase_bill_id,effective_date) where status='POSTED';
create index if not exists d1_alloc_payment_eff_idx on payment_allocations(tenant_id,payment_id,effective_date) where status='POSTED';

create function d1_assert_as_of(p_shop_id uuid,p_as_of date) returns void
language plpgsql stable security definer set search_path=public as $$
begin
 if p_as_of is null then raise exception 'DSB_INVALID_DATE: as-of date required'; end if;
 if p_as_of>shop_business_date(p_shop_id) then raise exception 'DSB_FUTURE_DATE: as-of date is after today'; end if;
end $$;
revoke all on function d1_assert_as_of(uuid,date) from public,anon,authenticated;

-- Shared report shape from per-document dues and per-account cash/ledger figures.
create function d1_aging_json(p_shop uuid,p_as_of date,p_docs jsonb,p_accounts jsonb) returns jsonb
language sql immutable set search_path=public as $$
 with d as (
  select (x->>'accountId')::uuid account_id,x->>'documentId' document_id,x->>'documentNo' document_no,
    (x->>'businessDate')::date business_date,(x->>'signedDue')::numeric due,coalesce((x->>'legacyInferred')::boolean,false) legacy
  from jsonb_array_elements(p_docs) x
 ), a as (
  select (x->>'accountId')::uuid account_id,x->>'name' name,(x->>'unassignedOut')::numeric unassigned_out,
    (x->>'unassignedIn')::numeric unassigned_in,(x->>'net')::numeric net
  from jsonb_array_elements(p_accounts) x
 ), rows as (
  select a.account_id,a.name,a.unassigned_out,a.unassigned_in,a.net,
   coalesce(sum(greatest(d.due,0)) filter(where p_as_of-d.business_date<=0),0) b0,
   coalesce(sum(greatest(d.due,0)) filter(where p_as_of-d.business_date between 1 and 30),0) b30,
   coalesce(sum(greatest(d.due,0)) filter(where p_as_of-d.business_date between 31 and 60),0) b60,
   coalesce(sum(greatest(d.due,0)) filter(where p_as_of-d.business_date between 61 and 90),0) b90,
   coalesce(sum(greatest(d.due,0)) filter(where p_as_of-d.business_date>90),0) bover,
   coalesce(sum(greatest(d.due,0)),0) gross,coalesce(sum(-least(d.due,0)),0) credits,
   coalesce(bool_or(d.legacy),false) legacy,
   coalesce(jsonb_agg(jsonb_build_object('documentId',d.document_id,'documentNo',d.document_no,'businessDate',d.business_date,
     'ageDays',p_as_of-d.business_date,'signedDuePaise',d.due::text,'clampedDuePaise',greatest(d.due,0)::text,
     'legacyInferredAllocation',d.legacy) order by d.business_date,d.document_id) filter(where d.due<>0),'[]'::jsonb) details
  from a left join d on d.account_id=a.account_id
  group by a.account_id,a.name,a.unassigned_out,a.unassigned_in,a.net
 ), shown as (
  select * from rows where gross<>0 or credits<>0 or unassigned_out<>0 or unassigned_in<>0 or net<>0
 )
 select jsonb_build_object('shopId',p_shop,'asOf',p_as_of,'historyCompleteness','VOIDS_RESTATED',
  'bucketLabels',jsonb_build_array('0 days','1-30','31-60','61-90','over 90'),
  'accounts',coalesce((select jsonb_agg(jsonb_build_object('accountId',account_id,'name',name,
     'days0Paise',b0::text,'days1to30Paise',b30::text,'days31to60Paise',b60::text,'days61to90Paise',b90::text,'daysOver90Paise',bover::text,
     'grossOpenPaise',gross::text,'documentCreditsPaise',credits::text,
     'unassignedOutPaise',unassigned_out::text,'unassignedInPaise',unassigned_in::text,
     'netLedgerBalancePaise',net::text,'legacyInferredAllocation',legacy,'details',details) order by gross desc,name,account_id) from shown),'[]'::jsonb),
  'totals',jsonb_build_object(
     'grossOpenPaise',coalesce((select sum(gross) from shown),0)::text,
     'documentCreditsPaise',coalesce((select sum(credits) from shown),0)::text,
     'unassignedOutPaise',coalesce((select sum(unassigned_out) from shown),0)::text,
     'unassignedInPaise',coalesce((select sum(unassigned_in) from shown),0)::text,
     'netLedgerBalancePaise',coalesce((select sum(net) from shown),0)::text))
$$;
revoke all on function d1_aging_json(uuid,date,jsonb,jsonb) from public,anon,authenticated;

-- Customers: positive = customer owes the shop. unassignedIn = unallocated receipts,
-- unassignedOut = refunds not linked to an invoice.
create function get_customer_aging_report_v2(p_shop_id uuid,p_as_of date) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=phase6_assert_report_access(); v_docs jsonb; v_accounts jsonb;
begin
 perform phase3_assert_shop(p_shop_id);
 perform d1_assert_as_of(p_shop_id,p_as_of);
 select coalesce(jsonb_agg(jsonb_build_object('accountId',s.customer_id,'documentId',s.id,'documentNo',s.doc_no,'businessDate',s.business_date,
   'signedDue',(s.total_paise-coalesce(r.v,0)-coalesce(a.v,0)+coalesce(f.v,0))::text,'legacyInferred',coalesce(a.legacy,false))),'[]'::jsonb)
 into v_docs
 from sale_invoices s
 left join lateral (select sum(x.total_paise) v from sale_returns x where x.tenant_id=s.tenant_id and x.sale_invoice_id=s.id
   and x.status='POSTED' and x.deleted_at is null and x.business_date<=p_as_of) r on true
 left join lateral (select sum(pa.amount_paise) v,bool_or(pa.effective_date_source='LEGACY_INFERRED') legacy
   from payment_allocations pa join payments p on p.tenant_id=pa.tenant_id and p.id=pa.payment_id
   where pa.tenant_id=s.tenant_id and pa.sale_invoice_id=s.id and pa.status='POSTED' and pa.effective_date<=p_as_of
     and p.status='POSTED' and p.deleted_at is null and p.direction='in' and p.business_date<=p_as_of) a on true
 left join lateral (select sum(x.amount_paise) v from payments x where x.tenant_id=s.tenant_id and x.source_sale_invoice_id=s.id
   and x.status='POSTED' and x.deleted_at is null and x.direction='out' and x.business_date<=p_as_of) f on true
 where s.tenant_id=v_tenant and s.shop_id=p_shop_id and s.customer_id is not null and s.status='FINALIZED'
   and s.deleted_at is null and s.business_date<=p_as_of;

 with cash as (
  select p.customer_id,
   sum(case when p.direction='in' then p.amount_paise-coalesce((select sum(pa.amount_paise) from payment_allocations pa
     where pa.tenant_id=p.tenant_id and pa.payment_id=p.id and pa.status='POSTED' and pa.effective_date<=p_as_of),0) else 0 end) unassigned_in,
   sum(case when p.direction='out' and p.source_sale_invoice_id is null then p.amount_paise else 0 end) unassigned_out
  from payments p where p.tenant_id=v_tenant and p.shop_id=p_shop_id and p.kind='customer' and p.customer_id is not null
   and p.status='POSTED' and p.deleted_at is null and p.business_date<=p_as_of
  group by p.customer_id
 ), ledger as (
  select customer_id,sum(amt) net from (
   select customer_id,total_paise amt from sale_invoices where tenant_id=v_tenant and shop_id=p_shop_id and customer_id is not null
     and status='FINALIZED' and deleted_at is null and business_date<=p_as_of
   union all select customer_id,-total_paise from sale_returns where tenant_id=v_tenant and shop_id=p_shop_id and customer_id is not null
     and status='POSTED' and deleted_at is null and business_date<=p_as_of
   union all select customer_id,case when direction='out' then amount_paise else -amount_paise end from payments
     where tenant_id=v_tenant and shop_id=p_shop_id and kind='customer' and customer_id is not null
     and status='POSTED' and deleted_at is null and business_date<=p_as_of
  ) e group by customer_id
 ), ids as (select customer_id from cash union select customer_id from ledger)
 select coalesce(jsonb_agg(jsonb_build_object('accountId',i.customer_id,'name',c.name,
   'unassignedIn',coalesce(k.unassigned_in,0)::text,'unassignedOut',coalesce(k.unassigned_out,0)::text,'net',coalesce(l.net,0)::text)),'[]'::jsonb)
 into v_accounts
 from ids i join customers c on c.tenant_id=v_tenant and c.id=i.customer_id
 left join cash k on k.customer_id=i.customer_id left join ledger l on l.customer_id=i.customer_id;

 return d1_aging_json(p_shop_id,p_as_of,v_docs,v_accounts)
  || jsonb_build_object('kind','customer','signConvention','positive = customer owes the shop');
end $$;

-- Suppliers: positive = shop owes the supplier. unassignedOut = unallocated payments made,
-- unassignedIn = money received from the supplier (refunds), never allocated to bills.
create function get_supplier_aging_report_v2(p_shop_id uuid,p_as_of date) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=c1_assert_supplier_read(p_shop_id); v_docs jsonb; v_accounts jsonb;
begin
 perform d1_assert_as_of(p_shop_id,p_as_of);
 select coalesce(jsonb_agg(jsonb_build_object('accountId',b.party_id,'documentId',b.id,'documentNo',coalesce(b.bill_no,b.id::text),'businessDate',b.business_date,
   'signedDue',(b.total_paise-coalesce(r.v,0)-coalesce(a.v,0))::text,'legacyInferred',coalesce(a.legacy,false))),'[]'::jsonb)
 into v_docs
 from purchase_bills b
 left join lateral (select sum(x.total_paise) v from purchase_returns x where x.tenant_id=b.tenant_id and x.purchase_bill_id=b.id
   and x.status='POSTED' and x.business_date<=p_as_of) r on true
 left join lateral (select sum(pa.amount_paise) v,bool_or(pa.effective_date_source='LEGACY_INFERRED') legacy
   from payment_allocations pa join payments p on p.tenant_id=pa.tenant_id and p.id=pa.payment_id
   where pa.tenant_id=b.tenant_id and pa.purchase_bill_id=b.id and pa.status='POSTED' and pa.effective_date<=p_as_of
     and p.status='POSTED' and p.deleted_at is null and p.direction='out' and p.business_date<=p_as_of) a on true
 where b.tenant_id=v_tenant and b.shop_id=p_shop_id and b.party_id is not null and b.status='POSTED'
   and b.deleted_at is null and b.business_date<=p_as_of;

 with cash as (
  select p.party_id,
   sum(case when p.direction='out' then p.amount_paise-coalesce((select sum(pa.amount_paise) from payment_allocations pa
     where pa.tenant_id=p.tenant_id and pa.payment_id=p.id and pa.status='POSTED' and pa.effective_date<=p_as_of),0) else 0 end) unassigned_out,
   sum(case when p.direction='in' then p.amount_paise else 0 end) unassigned_in
  from payments p where p.tenant_id=v_tenant and p.shop_id=p_shop_id and p.kind='party' and p.party_id is not null
   and p.status='POSTED' and p.deleted_at is null and p.business_date<=p_as_of
  group by p.party_id
 ), ledger as (
  select party_id,sum(amt) net from (
   select party_id,total_paise amt from purchase_bills where tenant_id=v_tenant and shop_id=p_shop_id and party_id is not null
     and status='POSTED' and deleted_at is null and business_date<=p_as_of
   union all select party_id,-total_paise from purchase_returns where tenant_id=v_tenant and shop_id=p_shop_id and party_id is not null
     and status='POSTED' and business_date<=p_as_of
   union all select party_id,case when direction='out' then -amount_paise else amount_paise end from payments
     where tenant_id=v_tenant and shop_id=p_shop_id and kind='party' and party_id is not null
     and status='POSTED' and deleted_at is null and business_date<=p_as_of
  ) e group by party_id
 ), ids as (select party_id from cash union select party_id from ledger)
 select coalesce(jsonb_agg(jsonb_build_object('accountId',i.party_id,'name',pt.name,
   'unassignedIn',coalesce(k.unassigned_in,0)::text,'unassignedOut',coalesce(k.unassigned_out,0)::text,'net',coalesce(l.net,0)::text)),'[]'::jsonb)
 into v_accounts
 from ids i join parties pt on pt.tenant_id=v_tenant and pt.id=i.party_id
 left join cash k on k.party_id=i.party_id left join ledger l on l.party_id=i.party_id;

 return d1_aging_json(p_shop_id,p_as_of,v_docs,v_accounts)
  || jsonb_build_object('kind','supplier','signConvention','positive = shop owes the supplier');
end $$;

revoke all on function get_customer_aging_report_v2(uuid,date) from public,anon;
revoke all on function get_supplier_aging_report_v2(uuid,date) from public,anon;
grant execute on function get_customer_aging_report_v2(uuid,date) to authenticated;
grant execute on function get_supplier_aging_report_v2(uuid,date) to authenticated;
