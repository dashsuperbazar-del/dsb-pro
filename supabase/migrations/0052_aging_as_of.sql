-- Packet D1-lite (group d1): as-of outstanding and aging for customers and suppliers
-- (COMPLETE_REMAINING_BUILD_PLAN v1.1 §9.2). Read-only; no table changes.
-- As of date D, within one shop:
--   documents with business_date<=D; returns and linked refunds with business_date<=D;
--   allocations only when the allocation effective_date<=D and the payment business_date<=D;
--   VOID rows are excluded at every D (history is restated, labelled VOIDS_RESTATED).
-- Cash is assigned only when it is allocated to (or linked to) a document in the same as-of set,
-- so a stranded allocation on a VOID or other-shop document shows as unassigned cash, not lost cash.
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

-- Customers: positive = customer owes the shop. unassignedIn = receipts not applied to a live
-- invoice as of D; unassignedOut = refunds not linked to a live invoice as of D.
-- Every figure is derived from one qualifying-invoice set and one qualifying-receipt set, and returns
-- and linked refunds are attributed through the invoice's customer, so the bridge holds by construction.
create function get_customer_aging_report_v2(p_shop_id uuid,p_as_of date) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=phase6_assert_report_access(); v_docs jsonb; v_accounts jsonb;
begin
 perform phase3_assert_shop(p_shop_id);
 perform d1_assert_as_of(p_shop_id,p_as_of);
 with inv as (
  select s.id,s.customer_id,s.doc_no,s.business_date,s.total_paise from sale_invoices s
  where s.tenant_id=v_tenant and s.shop_id=p_shop_id and s.customer_id is not null and s.status='FINALIZED'
    and s.deleted_at is null and s.business_date<=p_as_of
 ), rcpt as (
  select p.id,p.customer_id,p.amount_paise from payments p
  where p.tenant_id=v_tenant and p.shop_id=p_shop_id and p.kind='customer' and p.customer_id is not null and p.direction='in'
    and p.status='POSTED' and p.deleted_at is null and p.business_date<=p_as_of
 ), alloc as (
  select pa.sale_invoice_id,pa.payment_id,pa.amount_paise,pa.effective_date_source from payment_allocations pa
  join rcpt r on r.id=pa.payment_id join inv i on i.id=pa.sale_invoice_id
  where pa.tenant_id=v_tenant and pa.status='POSTED' and pa.effective_date<=p_as_of
 ), ret as (
  select x.sale_invoice_id,sum(x.total_paise) v from sale_returns x join inv i on i.id=x.sale_invoice_id
  where x.tenant_id=v_tenant and x.status='POSTED' and x.deleted_at is null and x.business_date<=p_as_of group by x.sale_invoice_id
 ), outp as (
  select p.id,p.customer_id,p.amount_paise,p.source_sale_invoice_id,i.id linked_inv,i.customer_id inv_customer from payments p
  left join inv i on i.id=p.source_sale_invoice_id
  where p.tenant_id=v_tenant and p.shop_id=p_shop_id and p.direction='out' and p.status='POSTED' and p.deleted_at is null
    and p.business_date<=p_as_of and (i.id is not null or (p.kind='customer' and p.customer_id is not null))
 ), alloc_doc as (
  -- Aggregated once (no per-row rescans): allocations per invoice and per receipt, linked refunds per invoice.
  select sale_invoice_id,sum(amount_paise) v,bool_or(effective_date_source='LEGACY_INFERRED') legacy from alloc group by sale_invoice_id
 ), alloc_pay as (
  select payment_id,sum(amount_paise) v from alloc group by payment_id
 ), linked as (
  select linked_inv,sum(amount_paise) v from outp where linked_inv is not null group by linked_inv
 ), docs as (
  select i.customer_id account_id,i.id,i.doc_no,i.business_date,i.total_paise,coalesce(r.v,0) returned,coalesce(l.v,0) refunded,
   i.total_paise-coalesce(r.v,0)-coalesce(a.v,0)+coalesce(l.v,0) due,coalesce(a.legacy,false) legacy
  from inv i left join ret r on r.sale_invoice_id=i.id left join alloc_doc a on a.sale_invoice_id=i.id
  left join linked l on l.linked_inv=i.id
 ), cash as (
  select customer_id,sum(ua_in) ua_in,sum(ua_out) ua_out,sum(rcpt_total) rcpt_total from (
   select r.customer_id,r.amount_paise-coalesce(ap.v,0) ua_in,0 ua_out,r.amount_paise rcpt_total
   from rcpt r left join alloc_pay ap on ap.payment_id=r.id
   union all select o.customer_id,0,o.amount_paise,0 from outp o where o.linked_inv is null
  ) c group by customer_id
 ), docsum as (
  select account_id,sum(total_paise-returned+refunded) v from docs group by account_id
 ), ids as (select account_id customer_id from docs union select customer_id from cash)
 select
  coalesce((select jsonb_agg(jsonb_build_object('accountId',d.account_id,'documentId',d.id,'documentNo',d.doc_no,
    'businessDate',d.business_date,'signedDue',d.due::text,'legacyInferred',d.legacy)) from docs d),'[]'::jsonb),
  coalesce((select jsonb_agg(jsonb_build_object('accountId',x.customer_id,'name',c.name,
    'unassignedIn',coalesce(k.ua_in,0)::text,'unassignedOut',coalesce(k.ua_out,0)::text,
    -- Net ledger balance from the source rows: invoices - returns + linked refunds - receipts + unlinked refunds.
    'net',(coalesce(ds.v,0)-coalesce(k.rcpt_total,0)+coalesce(k.ua_out,0))::text))
   from ids x join customers c on c.tenant_id=v_tenant and c.id=x.customer_id left join cash k on k.customer_id=x.customer_id
   left join docsum ds on ds.account_id=x.customer_id),'[]'::jsonb)
 into v_docs,v_accounts;

 return d1_aging_json(p_shop_id,p_as_of,v_docs,v_accounts)
  || jsonb_build_object('kind','customer','signConvention','positive = customer owes the shop');
end $$;

-- Suppliers: positive = shop owes the supplier. unassignedOut = payments made but not applied to a
-- live bill as of D; unassignedIn = money received from the supplier. Purchase returns are credit
-- only (they create no cash row) and are attributed through the bill's supplier.
create function get_supplier_aging_report_v2(p_shop_id uuid,p_as_of date) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=c1_assert_supplier_read(p_shop_id); v_docs jsonb; v_accounts jsonb;
begin
 perform d1_assert_as_of(p_shop_id,p_as_of);
 with bill as (
  select b.id,b.party_id,coalesce(b.bill_no,b.id::text) doc_no,b.business_date,b.total_paise from purchase_bills b
  where b.tenant_id=v_tenant and b.shop_id=p_shop_id and b.party_id is not null and b.status='POSTED'
    and b.deleted_at is null and b.business_date<=p_as_of
 ), paid as (
  select p.id,p.party_id,p.amount_paise from payments p
  where p.tenant_id=v_tenant and p.shop_id=p_shop_id and p.kind='party' and p.party_id is not null and p.direction='out'
    and p.status='POSTED' and p.deleted_at is null and p.business_date<=p_as_of
 ), recv as (
  select p.party_id,sum(p.amount_paise) v from payments p
  where p.tenant_id=v_tenant and p.shop_id=p_shop_id and p.kind='party' and p.party_id is not null and p.direction='in'
    and p.status='POSTED' and p.deleted_at is null and p.business_date<=p_as_of group by p.party_id
 ), alloc as (
  select pa.purchase_bill_id,pa.payment_id,pa.amount_paise,pa.effective_date_source from payment_allocations pa
  join paid q on q.id=pa.payment_id join bill b on b.id=pa.purchase_bill_id
  where pa.tenant_id=v_tenant and pa.status='POSTED' and pa.effective_date<=p_as_of
 ), ret as (
  select x.purchase_bill_id,sum(x.total_paise) v from purchase_returns x join bill b on b.id=x.purchase_bill_id
  where x.tenant_id=v_tenant and x.status='POSTED' and x.business_date<=p_as_of group by x.purchase_bill_id
 ), alloc_doc as (
  select purchase_bill_id,sum(amount_paise) v,bool_or(effective_date_source='LEGACY_INFERRED') legacy from alloc group by purchase_bill_id
 ), alloc_pay as (
  select payment_id,sum(amount_paise) v from alloc group by payment_id
 ), docs as (
  select b.party_id account_id,b.id,b.doc_no,b.business_date,b.total_paise-coalesce(r.v,0) net_of_returns,
   b.total_paise-coalesce(r.v,0)-coalesce(a.v,0) due,coalesce(a.legacy,false) legacy
  from bill b left join ret r on r.purchase_bill_id=b.id left join alloc_doc a on a.purchase_bill_id=b.id
 ), cash as (
  select party_id,sum(ua_out) ua_out,sum(ua_in) ua_in,sum(paid_total) paid_total from (
   select q.party_id,q.amount_paise-coalesce(ap.v,0) ua_out,0 ua_in,q.amount_paise paid_total
   from paid q left join alloc_pay ap on ap.payment_id=q.id
   union all select party_id,0,v,0 from recv
  ) c group by party_id
 ), docsum as (
  select account_id,sum(net_of_returns) v from docs group by account_id
 ), ids as (select account_id party_id from docs union select party_id from cash)
 select
  coalesce((select jsonb_agg(jsonb_build_object('accountId',d.account_id,'documentId',d.id,'documentNo',d.doc_no,
    'businessDate',d.business_date,'signedDue',d.due::text,'legacyInferred',d.legacy)) from docs d),'[]'::jsonb),
  coalesce((select jsonb_agg(jsonb_build_object('accountId',x.party_id,'name',pt.name,
    'unassignedIn',coalesce(k.ua_in,0)::text,'unassignedOut',coalesce(k.ua_out,0)::text,
    -- Net ledger balance from the source rows: bills - returns - payments made + money received.
    'net',(coalesce(ds.v,0)-coalesce(k.paid_total,0)+coalesce(k.ua_in,0))::text))
   from ids x join parties pt on pt.tenant_id=v_tenant and pt.id=x.party_id left join cash k on k.party_id=x.party_id
   left join docsum ds on ds.account_id=x.party_id),'[]'::jsonb)
 into v_docs,v_accounts;

 return d1_aging_json(p_shop_id,p_as_of,v_docs,v_accounts)
  || jsonb_build_object('kind','supplier','signConvention','positive = shop owes the supplier');
end $$;

revoke all on function get_customer_aging_report_v2(uuid,date) from public,anon;
revoke all on function get_supplier_aging_report_v2(uuid,date) from public,anon;
grant execute on function get_customer_aging_report_v2(uuid,date) to authenticated;
grant execute on function get_supplier_aging_report_v2(uuid,date) to authenticated;
