-- Packet C1 (SINGLE_BUILDER_PLAN v2.0 row 4 = COMPLETE_REMAINING_BUILD_PLAN v1.1 §7):
-- supplier payments, allocations, releases, voids, advances; direction-aware allocation validator.
--
-- Silent-corruption risks addressed here:
--  1. Over-allocation of a bill or a payment, including under concurrency. Every writer takes
--     the C0 shop finance lock, then its request lock, then locks the payment and the target
--     bills in UUID order; the allocation validator re-checks the bill balance and the
--     deferred payment-sum trigger re-checks the payment budget at commit.
--  2. Supplier payments voided through generic void_payment (which never knew about suppliers):
--     void_payment now refuses party payments; void_supplier_payment is owner-only.
--  3. Supplier payment/allocation rows leaking to cashiers through direct reads or joins:
--     payments/payment_allocations read policies now hide party rows without POST_PURCHASES
--     or VIEW_REPORTS, and scope rows to the caller's accessible shops.
--  4. A retried request with a changed payload silently accepted: the request ledger stores the
--     normalized request; a different payload under the same key raises DSB_PAYLOAD_MISMATCH.
--  5. "Net owed" overstated by clamping: outstanding reports keep open bills, advances, return
--     credits and the signed ledger balance as separate figures.
-- Not done here (recorded in STATE.md): the "not before cutover date" restriction — no cutover
-- date exists yet; opening balances/credits (F2).

-- ---------------------------------------------------------------------------------------------
-- 1. Request ledger: operation names per v1.1 §7.1 (0046's allowlist used placeholder names
--    that were never written; there are no rows to migrate).
-- ---------------------------------------------------------------------------------------------
alter table financial_requests drop constraint financial_requests_operation_check;
alter table financial_requests add constraint financial_requests_operation_check check(operation in (
  'supplier.record.v1','supplier.allocate.v1','supplier.void.v1','supplier.release.v1',
  'record_customer_payment_v2','allocate_customer_payment_v2'));

create or replace function dsb_request_result(p_tenant uuid,p_shop uuid,p_operation text,p_client_id text,p_request jsonb)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_row financial_requests%rowtype;
begin
 select * into v_row from financial_requests
  where tenant_id=p_tenant and operation=p_operation and client_id=p_client_id;
 if not found then return null; end if;
 if v_row.shop_id<>p_shop or v_row.request<>p_request then
   raise exception 'DSB_PAYLOAD_MISMATCH: client_id already used for a different request';
 end if;
 return v_row.result;
end $$;
revoke all on function dsb_request_result(uuid,uuid,text,text,jsonb) from public,anon,authenticated;

create or replace function get_financial_request(p_shop_id uuid,p_operation text,p_client_id text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_row financial_requests%rowtype; v_payment uuid; v_status text;
begin
 v_tenant:=phase3_assert_shop(p_shop_id);
 if p_operation in ('supplier.record.v1','supplier.allocate.v1','supplier.void.v1','supplier.release.v1') then
   if not has_perm('POST_PURCHASES') then raise exception 'not permitted'; end if;
 elsif p_operation in ('record_customer_payment_v2','allocate_customer_payment_v2') then
   if not has_perm('POST_SALES') then raise exception 'not permitted'; end if;
 else
   raise exception 'unknown financial operation';
 end if;
 if p_client_id is null or char_length(p_client_id) not between 1 and 128 then raise exception 'client_id required'; end if;
 perform dsb_lock_request(v_tenant,p_operation,p_client_id);
 select * into v_row from financial_requests
  where tenant_id=v_tenant and operation=p_operation and client_id=p_client_id;
 if not found or v_row.shop_id<>p_shop_id then return jsonb_build_object('state','NOT_FOUND'); end if;
 if p_operation='supplier.release.v1'
    and coalesce(v_row.result->>'allocationId','') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
   -- A release changes the allocation, not the payment: report the allocation's status.
   select status into v_status from payment_allocations
    where tenant_id=v_tenant and id=(v_row.result->>'allocationId')::uuid;
 elsif coalesce(v_row.result->>'paymentId','') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
   v_payment:=(v_row.result->>'paymentId')::uuid;
   select status into v_status from payments where tenant_id=v_tenant and id=v_payment;
 end if;
 return jsonb_build_object('state','COMMITTED','result',v_row.result,'currentStatus',v_status);
end $$;
revoke all on function get_financial_request(uuid,text,text) from public,anon;
grant execute on function get_financial_request(uuid,text,text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. Direction-aware allocation validator (SALE branch unchanged in substance; it now also
--    requires an inbound payment explicitly, which it always did via the direction check).
-- ---------------------------------------------------------------------------------------------
create or replace function phase4_validate_allocation() returns trigger
language plpgsql security definer set search_path=public as $$
declare v_payment payments%rowtype; v_customer uuid; v_party uuid; v_doc_total bigint; v_allocated bigint;
 v_bill purchase_bills%rowtype; v_returned bigint;
begin
 select * into v_payment from payments where id=new.payment_id and tenant_id=new.tenant_id;
 if not found or v_payment.status<>'POSTED' or v_payment.deleted_at is not null then raise exception 'payment unavailable'; end if;
 if new.doc_type='SALE' then
   if v_payment.direction<>'in' then raise exception 'payment unavailable'; end if;
   select s.customer_id,s.total_paise-coalesce((select sum(sr.total_paise) from sale_returns sr
     where sr.tenant_id=s.tenant_id and sr.sale_invoice_id=s.id and sr.status='POSTED'),0)
     +coalesce((select sum(p.amount_paise) from payments p join sale_returns sr on sr.id=p.source_sale_return_id and sr.tenant_id=p.tenant_id
       where sr.tenant_id=s.tenant_id and sr.sale_invoice_id=s.id and sr.status='POSTED' and p.status='POSTED' and p.direction='out'),0)
     into v_customer,v_doc_total from sale_invoices s
     where s.id=new.sale_invoice_id and s.tenant_id=new.tenant_id and s.status='FINALIZED' for update;
   if not found then raise exception 'sale unavailable'; end if;
   if v_payment.kind<>'customer' or v_customer is distinct from v_payment.customer_id then raise exception 'payment and sale customer mismatch'; end if;
   select coalesce(sum(amount_paise),0) into v_allocated from payment_allocations
     where tenant_id=new.tenant_id and sale_invoice_id=new.sale_invoice_id and status='POSTED';
   if v_allocated+new.amount_paise>greatest(v_doc_total,0) then raise exception 'allocation exceeds document outstanding amount'; end if;
 else
   if v_payment.kind<>'party' or v_payment.direction<>'out' then raise exception 'DSB_PAYMENT_NOT_SUPPLIER_OUT: payment unavailable'; end if;
   select * into v_bill from purchase_bills
     where id=new.purchase_bill_id and tenant_id=new.tenant_id for update;
   if not found or v_bill.status<>'POSTED' or v_bill.deleted_at is not null or v_bill.party_id is null then
     raise exception 'DSB_BILL_UNAVAILABLE: purchase unavailable';
   end if;
   if v_bill.shop_id<>v_payment.shop_id or v_bill.party_id<>v_payment.party_id then
     raise exception 'DSB_BILL_MISMATCH: payment and purchase party/shop mismatch';
   end if;
   select coalesce(sum(r.total_paise),0) into v_returned from purchase_returns r
     where r.tenant_id=new.tenant_id and r.purchase_bill_id=v_bill.id and r.status='POSTED';
   select coalesce(sum(amount_paise),0) into v_allocated from payment_allocations
     where tenant_id=new.tenant_id and purchase_bill_id=v_bill.id and status='POSTED';
   if v_allocated+new.amount_paise>greatest(v_bill.total_paise-v_returned,0) then
     raise exception 'DSB_ALLOCATION_EXCEEDS_BILL: allocation exceeds document outstanding amount';
   end if;
 end if;
 return new;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 3. Bill outstanding view (security invoker: callers see only bills RLS lets them see).
-- ---------------------------------------------------------------------------------------------
create view purchase_bill_outstanding with (security_invoker=true) as
select b.tenant_id,b.shop_id,b.party_id,b.id as purchase_bill_id,b.bill_no,b.business_date,b.total_paise,
  coalesce(r.returned,0)::bigint as returned_paise,
  coalesce(a.allocated,0)::bigint as allocated_paise,
  (b.total_paise-coalesce(r.returned,0)-coalesce(a.allocated,0))::bigint as net_outstanding_paise,
  greatest(b.total_paise-coalesce(r.returned,0)-coalesce(a.allocated,0),0)::bigint as outstanding_paise
from purchase_bills b
left join lateral (select sum(x.total_paise) returned from purchase_returns x
  where x.tenant_id=b.tenant_id and x.purchase_bill_id=b.id and x.status='POSTED') r on true
left join lateral (select sum(x.amount_paise) allocated from payment_allocations x
  where x.tenant_id=b.tenant_id and x.purchase_bill_id=b.id and x.status='POSTED') a on true
where b.status='POSTED' and b.deleted_at is null;
revoke all on purchase_bill_outstanding from public,anon,authenticated;
grant select on purchase_bill_outstanding to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 4. Read visibility (v1.1 §7.4). Side-effect-free predicate, never a throwing assertion.
-- ---------------------------------------------------------------------------------------------
create function c1_shop_visible(p_shop uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select p_shop=any(coalesce(current_shop_ids(),'{}'::uuid[])) or coalesce("current_role"() in ('owner','manager'),false)
$$;
revoke all on function c1_shop_visible(uuid) from public,anon;
grant execute on function c1_shop_visible(uuid) to authenticated;

drop policy payments_read on payments;
create policy payments_read on payments for select using(
 tenant_id=current_tenant_id() and c1_shop_visible(shop_id)
 and (kind<>'party' or has_perm('POST_PURCHASES') or has_perm('VIEW_REPORTS')));
drop policy payment_allocations_read on payment_allocations;
create policy payment_allocations_read on payment_allocations for select using(
 tenant_id=current_tenant_id()
 and exists(select 1 from payments p where p.tenant_id=payment_allocations.tenant_id and p.id=payment_allocations.payment_id));

-- ---------------------------------------------------------------------------------------------
-- 5. Generic void_payment no longer reaches supplier payments.
-- ---------------------------------------------------------------------------------------------
create or replace function void_payment(p_payment_id uuid) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_shop uuid; v_kind text;
begin
 if v_tenant is null then raise exception 'not authenticated'; end if;
 select shop_id,kind into v_shop,v_kind from payments where tenant_id=v_tenant and id=p_payment_id;
 if v_kind='party' then raise exception 'DSB_USE_SUPPLIER_VOID: void supplier payments with void_supplier_payment'; end if;
 if v_shop is not null then perform dsb_lock_shop_finance(v_tenant,v_shop); end if;
 return c0_void_payment_body(p_payment_id);
end $$;

-- ---------------------------------------------------------------------------------------------
-- 6. Supplier payment writers. Lock order: shop finance -> request -> payment -> bills (UUID).
-- ---------------------------------------------------------------------------------------------
create function c1_assert_request_uuid(p_client_id text) returns uuid
language plpgsql immutable set search_path=public as $$
begin
 if p_client_id is null or lower(p_client_id) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
   raise exception 'DSB_INVALID_REQUEST_ID: client_id must be a request UUID';
 end if;
 return lower(p_client_id)::uuid;
end $$;
revoke all on function c1_assert_request_uuid(text) from public,anon,authenticated;

-- Locks and validates the targets, returns the summed amount. p_floor_date is the latest date a
-- bill may carry (payment date for immediate allocation, today for later allocation).
create function c1_check_bill_targets(p_tenant uuid,p_shop uuid,p_party uuid,p_allocations jsonb,p_floor_date date)
returns bigint language plpgsql security definer set search_path=public as $$
declare v_item jsonb; v_bill purchase_bills%rowtype; v_amount bigint; v_total numeric:=0; v_open bigint;
begin
 for v_item in select value from jsonb_array_elements(p_allocations) loop  -- already sorted by UUID
   v_amount:=(v_item->>'amount_paise')::bigint;
   select * into v_bill from purchase_bills where tenant_id=p_tenant and id=(v_item->>'purchase_bill_id')::uuid for update;
   if not found or v_bill.status<>'POSTED' or v_bill.deleted_at is not null or v_bill.party_id is null then
     raise exception 'DSB_BILL_UNAVAILABLE: purchase unavailable';
   end if;
   if v_bill.shop_id<>p_shop or v_bill.party_id<>p_party then raise exception 'DSB_BILL_MISMATCH: payment and purchase party/shop mismatch'; end if;
   if v_bill.business_date>p_floor_date then raise exception 'DSB_FUTURE_BILL: bill is dated after the allocation date'; end if;
   select outstanding_paise into v_open from purchase_bill_outstanding where purchase_bill_id=v_bill.id;
   if v_amount>coalesce(v_open,0) then raise exception 'DSB_ALLOCATION_EXCEEDS_BILL: allocation exceeds document outstanding amount'; end if;
   v_total:=v_total+v_amount;
 end loop;
 if v_total>9007199254740991 then raise exception 'DSB_AMOUNT_OUT_OF_RANGE: amount out of safe range'; end if;
 return v_total::bigint;
end $$;
revoke all on function c1_check_bill_targets(uuid,uuid,uuid,jsonb,date) from public,anon,authenticated;

create function record_supplier_payment(p_shop_id uuid,p_party_id uuid,p_business_date date,
 p_amount_paise bigint,p_mode text,p_reference text,p_allocations jsonb,p_client_id text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_req uuid; v_allocs jsonb; v_request jsonb; v_prev jsonb; v_today date; v_date date;
 v_payment uuid; v_item jsonb; v_alloc uuid; v_ids jsonb:='[]'::jsonb; v_sum bigint;
begin
 v_req:=c1_assert_request_uuid(p_client_id);
 if not has_perm('POST_PURCHASES') then raise exception 'not permitted'; end if;
 v_tenant:=phase3_assert_shop(p_shop_id);
 if p_allocations is null then raise exception 'DSB_INVALID_ALLOCATIONS: allocations required (use [] for an advance)'; end if;
 v_allocs:=dsb_normalize_allocations(p_allocations,'purchase_bill_id');
 if p_amount_paise is null or p_amount_paise<=0 then raise exception 'DSB_INVALID_AMOUNT: amount must be positive'; end if;
 perform dsb_assert_safe_paise(p_amount_paise);
 if p_mode is null or p_mode not in ('cash','upi','card','bank','other') then raise exception 'DSB_INVALID_MODE: invalid payment mode'; end if;
 if p_reference is not null and char_length(p_reference)>200 then raise exception 'DSB_INVALID_REFERENCE: reference too long'; end if;
 v_request:=jsonb_build_object('shopId',p_shop_id,'partyId',p_party_id,'businessDate',p_business_date,
   'amountPaise',p_amount_paise::text,'mode',p_mode,'reference',p_reference,'allocations',v_allocs);

 perform dsb_lock_shop_finance(v_tenant,p_shop_id);
 perform dsb_lock_request(v_tenant,'supplier.record.v1',v_req::text);
 v_prev:=dsb_request_result(v_tenant,p_shop_id,'supplier.record.v1',v_req::text,v_request);
 if v_prev is not null then return (v_prev->>'paymentId')::uuid; end if;

 if not exists(select 1 from parties where tenant_id=v_tenant and id=p_party_id and deleted_at is null) then
   raise exception 'DSB_PARTY_UNAVAILABLE: supplier unavailable';
 end if;
 v_today:=shop_business_date(p_shop_id);
 v_date:=coalesce(p_business_date,v_today);
 if v_date>v_today then raise exception 'DSB_FUTURE_DATE: payment date is after today'; end if;
 v_sum:=c1_check_bill_targets(v_tenant,p_shop_id,p_party_id,v_allocs,v_date);
 if v_sum>p_amount_paise then raise exception 'DSB_ALLOCATION_EXCEEDS_PAYMENT: allocations exceed payment amount'; end if;

 insert into payments(tenant_id,shop_id,kind,party_id,business_date,amount_paise,mode,reference,direction,client_id)
 values(v_tenant,p_shop_id,'party',p_party_id,v_date,p_amount_paise,p_mode,p_reference,'out','supplier.record.v1:'||v_req::text)
 returning id into v_payment;
 for v_item in select value from jsonb_array_elements(v_allocs) loop
   insert into payment_allocations(tenant_id,payment_id,doc_type,purchase_bill_id,amount_paise,client_id)
   values(v_tenant,v_payment,'PURCHASE',(v_item->>'purchase_bill_id')::uuid,(v_item->>'amount_paise')::bigint,
     'supplier.record.v1:'||v_req::text||':bill:'||(v_item->>'purchase_bill_id'))
   returning id into v_alloc;
   v_ids:=v_ids||to_jsonb(v_alloc);
 end loop;
 insert into financial_requests(tenant_id,shop_id,operation,request,result,client_id)
 values(v_tenant,p_shop_id,'supplier.record.v1',v_request,
   jsonb_build_object('paymentId',v_payment,'allocationIds',v_ids,'businessDate',v_date),v_req::text);
 return v_payment;
end $$;

create function allocate_supplier_payment(p_payment_id uuid,p_allocations jsonb,p_client_id text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_req uuid; v_shop uuid; v_allocs jsonb; v_request jsonb; v_prev jsonb;
 v_payment payments%rowtype; v_today date; v_used bigint; v_sum bigint; v_item jsonb; v_alloc uuid; v_ids jsonb:='[]'::jsonb; v_result jsonb;
begin
 v_req:=c1_assert_request_uuid(p_client_id);
 if v_tenant is null then raise exception 'not authenticated'; end if;
 if not has_perm('POST_PURCHASES') then raise exception 'not permitted'; end if;
 select shop_id into v_shop from payments where tenant_id=v_tenant and id=p_payment_id;
 if v_shop is null then raise exception 'DSB_PAYMENT_UNAVAILABLE: payment unavailable'; end if;
 perform phase3_assert_shop(v_shop);
 if p_allocations is null or jsonb_typeof(p_allocations)<>'array' or jsonb_array_length(p_allocations)=0 then
   raise exception 'DSB_INVALID_ALLOCATIONS: at least one allocation required';
 end if;
 v_allocs:=dsb_normalize_allocations(p_allocations,'purchase_bill_id');
 v_request:=jsonb_build_object('paymentId',p_payment_id,'allocations',v_allocs);

 perform dsb_lock_shop_finance(v_tenant,v_shop);
 perform dsb_lock_request(v_tenant,'supplier.allocate.v1',v_req::text);
 v_prev:=dsb_request_result(v_tenant,v_shop,'supplier.allocate.v1',v_req::text,v_request);
 if v_prev is not null then return v_prev; end if;

 select * into v_payment from payments where tenant_id=v_tenant and id=p_payment_id for update;
 if v_payment.status<>'POSTED' or v_payment.deleted_at is not null or v_payment.kind<>'party' or v_payment.direction<>'out' then
   raise exception 'DSB_PAYMENT_UNAVAILABLE: payment unavailable';
 end if;
 v_today:=shop_business_date(v_shop);
 if v_payment.business_date>v_today then raise exception 'DSB_FUTURE_DATE: payment is dated after today'; end if;
 v_sum:=c1_check_bill_targets(v_tenant,v_shop,v_payment.party_id,v_allocs,v_today);
 select coalesce(sum(amount_paise),0) into v_used from payment_allocations
  where tenant_id=v_tenant and payment_id=v_payment.id and status='POSTED';
 if v_used+v_sum>v_payment.amount_paise then raise exception 'DSB_ALLOCATION_EXCEEDS_PAYMENT: allocations exceed payment amount'; end if;
 for v_item in select value from jsonb_array_elements(v_allocs) loop
   insert into payment_allocations(tenant_id,payment_id,doc_type,purchase_bill_id,amount_paise,client_id,effective_date)
   values(v_tenant,v_payment.id,'PURCHASE',(v_item->>'purchase_bill_id')::uuid,(v_item->>'amount_paise')::bigint,
     'supplier.allocate.v1:'||v_req::text||':bill:'||(v_item->>'purchase_bill_id'),v_today)
   returning id into v_alloc;
   v_ids:=v_ids||to_jsonb(v_alloc);
 end loop;
 v_result:=jsonb_build_object('paymentId',v_payment.id,'allocationIds',v_ids,'effectiveDate',v_today);
 insert into financial_requests(tenant_id,shop_id,operation,request,result,client_id)
 values(v_tenant,v_shop,'supplier.allocate.v1',v_request,v_result,v_req::text);
 return v_result;
end $$;

create function void_supplier_payment(p_payment_id uuid,p_reason text,p_client_id text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_req uuid; v_shop uuid; v_request jsonb; v_prev jsonb; v_payment payments%rowtype;
begin
 v_req:=c1_assert_request_uuid(p_client_id);
 if v_tenant is null then raise exception 'not authenticated'; end if;
 if coalesce("current_role"(),'')<>'owner' then raise exception 'not permitted'; end if;
 if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then raise exception 'DSB_INVALID_REASON: reason required (1-500 characters)'; end if;
 select shop_id into v_shop from payments where tenant_id=v_tenant and id=p_payment_id;
 if v_shop is null then raise exception 'DSB_PAYMENT_UNAVAILABLE: payment unavailable'; end if;
 perform phase3_assert_shop(v_shop);
 v_request:=jsonb_build_object('paymentId',p_payment_id,'reason',btrim(p_reason));
 perform dsb_lock_shop_finance(v_tenant,v_shop);
 perform dsb_lock_request(v_tenant,'supplier.void.v1',v_req::text);
 v_prev:=dsb_request_result(v_tenant,v_shop,'supplier.void.v1',v_req::text,v_request);
 if v_prev is not null then return (v_prev->>'paymentId')::uuid; end if;
 select * into v_payment from payments where tenant_id=v_tenant and id=p_payment_id for update;
 if v_payment.kind<>'party' then raise exception 'DSB_PAYMENT_NOT_SUPPLIER: not a supplier payment'; end if;
 if v_payment.status='POSTED' then
   update payment_allocations set status='VOID' where tenant_id=v_tenant and payment_id=v_payment.id and status='POSTED';
   update payments set status='VOID',voided_at=now() where id=v_payment.id;
 end if;
 insert into financial_requests(tenant_id,shop_id,operation,request,result,client_id)
 values(v_tenant,v_shop,'supplier.void.v1',v_request,
   jsonb_build_object('paymentId',v_payment.id,'alreadyVoid',v_payment.status='VOID'),v_req::text);
 return v_payment.id;
end $$;

create function release_supplier_allocation(p_allocation_id uuid,p_reason text,p_client_id text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_req uuid; v_shop uuid; v_request jsonb; v_prev jsonb; v_alloc payment_allocations%rowtype;
begin
 v_req:=c1_assert_request_uuid(p_client_id);
 if v_tenant is null then raise exception 'not authenticated'; end if;
 if coalesce("current_role"(),'')<>'owner' then raise exception 'not permitted'; end if;
 if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then raise exception 'DSB_INVALID_REASON: reason required (1-500 characters)'; end if;
 select p.shop_id into v_shop from payment_allocations a join payments p on p.tenant_id=a.tenant_id and p.id=a.payment_id
  where a.tenant_id=v_tenant and a.id=p_allocation_id;
 if v_shop is null then raise exception 'DSB_ALLOCATION_UNAVAILABLE: allocation unavailable'; end if;
 perform phase3_assert_shop(v_shop);
 v_request:=jsonb_build_object('allocationId',p_allocation_id,'reason',btrim(p_reason));
 perform dsb_lock_shop_finance(v_tenant,v_shop);
 perform dsb_lock_request(v_tenant,'supplier.release.v1',v_req::text);
 v_prev:=dsb_request_result(v_tenant,v_shop,'supplier.release.v1',v_req::text,v_request);
 if v_prev is not null then return (v_prev->>'allocationId')::uuid; end if;
 select * into v_alloc from payment_allocations where tenant_id=v_tenant and id=p_allocation_id for update;
 if v_alloc.doc_type<>'PURCHASE' then raise exception 'DSB_ALLOCATION_NOT_SUPPLIER: not a supplier bill allocation'; end if;
 if v_alloc.status='POSTED' then
   update payment_allocations set status='VOID' where id=v_alloc.id;
 end if;
 insert into financial_requests(tenant_id,shop_id,operation,request,result,client_id)
 values(v_tenant,v_shop,'supplier.release.v1',v_request,
   jsonb_build_object('allocationId',v_alloc.id,'paymentId',v_alloc.payment_id,'alreadyVoid',v_alloc.status='VOID'),v_req::text);
 return v_alloc.id;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 7. Readers. Amounts are integer text (v1.1 §3.3). Positive balance = we owe the supplier.
-- ---------------------------------------------------------------------------------------------
create function c1_assert_supplier_read(p_shop_id uuid) returns uuid
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=phase3_assert_shop(p_shop_id);
begin
 if not (has_perm('POST_PURCHASES') or has_perm('VIEW_REPORTS')) then raise exception 'not permitted'; end if;
 return v_tenant;
end $$;
revoke all on function c1_assert_supplier_read(uuid) from public,anon,authenticated;

create function get_supplier_outstanding(p_shop_id uuid) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=c1_assert_supplier_read(p_shop_id); v_rows jsonb;
begin
 with bills as (
   select b.party_id,b.purchase_bill_id,b.net_outstanding_paise net from purchase_bill_outstanding b
   where b.tenant_id=v_tenant and b.shop_id=p_shop_id
 ), advances as (
   select p.party_id,sum(p.amount_paise-coalesce((select sum(a.amount_paise) from payment_allocations a
     where a.tenant_id=p.tenant_id and a.payment_id=p.id and a.status='POSTED'),0)) unallocated
   from payments p where p.tenant_id=v_tenant and p.shop_id=p_shop_id and p.kind='party' and p.direction='out' and p.status='POSTED'
   group by p.party_id
 ), ledger as (
   select party_id,sum(amt) bal from (
     select party_id,total_paise amt from purchase_bills where tenant_id=v_tenant and shop_id=p_shop_id and status='POSTED' and party_id is not null
     union all select party_id,-total_paise from purchase_returns where tenant_id=v_tenant and shop_id=p_shop_id and status='POSTED' and party_id is not null
     union all select party_id,case when direction='out' then -amount_paise else amount_paise end from payments
       where tenant_id=v_tenant and shop_id=p_shop_id and kind='party' and status='POSTED'
   ) e group by party_id
 ), stranded as (
   select p.party_id,count(*) n from payment_allocations a
   join payments p on p.tenant_id=a.tenant_id and p.id=a.payment_id
   join purchase_bills b on b.tenant_id=a.tenant_id and b.id=a.purchase_bill_id
   where a.tenant_id=v_tenant and p.shop_id=p_shop_id and a.status='POSTED' and b.status='VOID'
   group by p.party_id
 ), party_ids as (
   select party_id from bills union select party_id from advances union select party_id from ledger
 )
 select coalesce(jsonb_agg(jsonb_build_object(
   'partyId',pi.party_id,'partyName',pt.name,
   'grossOpenBills',coalesce((select sum(greatest(net,0)) from bills b where b.party_id=pi.party_id),0)::text,
   'remainingPositiveOpenings','0',
   'unallocatedCashAdvances',coalesce(ad.unallocated,0)::text,
   'remainingOpeningCredits','0',
   'returnCredits',coalesce((select sum(-least(net,0)) from bills b where b.party_id=pi.party_id),0)::text,
   'netLedgerBalance',coalesce(l.bal,0)::text,
   'strandedAllocationsOnVoidBills',coalesce(st.n,0)) order by pt.name),'[]'::jsonb)
 into v_rows
 from party_ids pi
 join parties pt on pt.tenant_id=v_tenant and pt.id=pi.party_id
 left join advances ad on ad.party_id=pi.party_id
 left join ledger l on l.party_id=pi.party_id
 left join stranded st on st.party_id=pi.party_id;
 return jsonb_build_object('shopId',p_shop_id,'parties',v_rows);
end $$;

create function get_party_ledger_v2(p_shop_id uuid,p_party_id uuid,p_from date,p_to date) returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare v_tenant uuid:=c1_assert_supplier_read(p_shop_id); v_opening numeric; v_entries jsonb; v_closing numeric;
begin
 if not exists(select 1 from parties where tenant_id=v_tenant and id=p_party_id) then raise exception 'DSB_PARTY_UNAVAILABLE: supplier unavailable'; end if;
 create temp table if not exists _c1_ledger(entry_date date,kind text,document text,amount numeric,created timestamptz,id uuid) on commit drop;
 delete from _c1_ledger;
 insert into _c1_ledger
 select business_date,'PURCHASE',coalesce(bill_no,id::text),total_paise,created_at,id from purchase_bills
  where tenant_id=v_tenant and shop_id=p_shop_id and party_id=p_party_id and status='POSTED'
 union all
 select business_date,'PURCHASE_RETURN',doc_no,-total_paise,created_at,id from purchase_returns
  where tenant_id=v_tenant and shop_id=p_shop_id and party_id=p_party_id and status='POSTED'
 union all
 select business_date,case when direction='out' then 'PAYMENT_MADE' else 'PAYMENT_RECEIVED' end,coalesce(reference,id::text),
   case when direction='out' then -amount_paise else amount_paise end,created_at,id from payments
  where tenant_id=v_tenant and shop_id=p_shop_id and party_id=p_party_id and kind='party' and status='POSTED';
 select coalesce(sum(amount),0) into v_opening from _c1_ledger where p_from is not null and entry_date<p_from;
 select coalesce(jsonb_agg(jsonb_build_object('date',entry_date,'kind',kind,'document',document,'id',id,
   'amountPaise',amount::text,'runningBalancePaise',(v_opening+run)::text) order by entry_date,created,id),'[]'::jsonb)
 into v_entries
 from (select *,sum(amount) over(order by entry_date,created,id) run from _c1_ledger
       where (p_from is null or entry_date>=p_from) and (p_to is null or entry_date<=p_to)) e;
 select v_opening+coalesce(sum(amount),0) into v_closing from _c1_ledger
  where (p_from is null or entry_date>=p_from) and (p_to is null or entry_date<=p_to);
 return jsonb_build_object('shopId',p_shop_id,'partyId',p_party_id,'from',p_from,'to',p_to,
   'openingBalancePaise',v_opening::text,'entries',v_entries,'closingBalancePaise',v_closing::text,
   'signConvention','positive = amount owed to supplier');
end $$;

revoke all on function record_supplier_payment(uuid,uuid,date,bigint,text,text,jsonb,text) from public,anon;
revoke all on function allocate_supplier_payment(uuid,jsonb,text) from public,anon;
revoke all on function void_supplier_payment(uuid,text,text) from public,anon;
revoke all on function release_supplier_allocation(uuid,text,text) from public,anon;
revoke all on function get_supplier_outstanding(uuid) from public,anon;
revoke all on function get_party_ledger_v2(uuid,uuid,date,date) from public,anon;
grant execute on function record_supplier_payment(uuid,uuid,date,bigint,text,text,jsonb,text) to authenticated;
grant execute on function allocate_supplier_payment(uuid,jsonb,text) to authenticated;
grant execute on function void_supplier_payment(uuid,text,text) to authenticated;
grant execute on function release_supplier_allocation(uuid,text,text) to authenticated;
grant execute on function get_supplier_outstanding(uuid) to authenticated;
grant execute on function get_party_ledger_v2(uuid,uuid,date,date) to authenticated;
