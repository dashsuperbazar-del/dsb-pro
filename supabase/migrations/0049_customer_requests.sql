-- Packet C3 (group c3): customer payments move onto the C0 request ledger.
--  * record_customer_payment_v2 / allocate_customer_payment_v2: request-UUID writers with exact
--    replay, PAYLOAD_MISMATCH on reuse, dated allocations (POST_SALES, same customer/shop, inbound).
--  * record_customer_payment (old signature, still used by older clients): every NEW call is
--    recorded as operation customer.record.legacy-v1 with its normalized payload. A retry of a
--    payment committed before this migration (no request row) is accepted only when every
--    reconstructible field and the allocation set match; anything else raises
--    DSB_LEGACY_REQUEST_UNVERIFIABLE and never creates a second receipt.
-- Lock order (C0): shop finance -> request -> payment -> invoices in UUID order.

alter table financial_requests drop constraint financial_requests_operation_check;
alter table financial_requests add constraint financial_requests_operation_check check(operation in (
  'supplier.record.v1','supplier.allocate.v1','supplier.void.v1','supplier.release.v1',
  'record_customer_payment_v2','allocate_customer_payment_v2','customer.record.legacy-v1'));

create or replace function get_financial_request(p_shop_id uuid,p_operation text,p_client_id text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_row financial_requests%rowtype; v_payment uuid; v_status text;
begin
 v_tenant:=phase3_assert_shop(p_shop_id);
 if p_operation in ('supplier.record.v1','supplier.allocate.v1','supplier.void.v1','supplier.release.v1') then
   if not has_perm('POST_PURCHASES') then raise exception 'not permitted'; end if;
 elsif p_operation in ('record_customer_payment_v2','allocate_customer_payment_v2','customer.record.legacy-v1') then
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

-- Locks the invoices (UUID order, already normalized) and checks identity/date. The outstanding
-- amount is enforced by phase4_validate_allocation on insert, under the same row locks.
-- p_floor_date null = no date rule (legacy endpoint: C0's allocation date trigger already applies).
create function c3_check_invoice_targets(p_tenant uuid,p_shop uuid,p_customer uuid,p_allocations jsonb,p_floor_date date)
returns bigint language plpgsql security definer set search_path=public as $$
declare v_item jsonb; v_inv sale_invoices%rowtype; v_total numeric:=0; v_open bigint;
begin
 for v_item in select value from jsonb_array_elements(p_allocations) loop
   select * into v_inv from sale_invoices where tenant_id=p_tenant and id=(v_item->>'sale_invoice_id')::uuid for update;
   if not found or v_inv.status<>'FINALIZED' then raise exception 'DSB_INVOICE_UNAVAILABLE: sale unavailable'; end if;
   if v_inv.shop_id<>p_shop or v_inv.customer_id is distinct from p_customer then
     raise exception 'DSB_INVOICE_MISMATCH: payment and sale customer/shop mismatch';
   end if;
   if p_floor_date is not null and v_inv.business_date>p_floor_date then
     raise exception 'DSB_FUTURE_INVOICE: sale is dated after the allocation date';
   end if;
   select outstanding_paise into v_open from customer_invoice_outstanding where tenant_id=p_tenant and sale_invoice_id=v_inv.id;
   -- Message kept byte-identical to the pre-C3 endpoint (golden test 0021).
   if (v_item->>'amount_paise')::bigint>coalesce(v_open,0) then raise exception 'allocation exceeds invoice balance'; end if;
   v_total:=v_total+(v_item->>'amount_paise')::numeric;
 end loop;
 if v_total>9007199254740991 then raise exception 'DSB_AMOUNT_OUT_OF_RANGE: amount out of safe range'; end if;
 return v_total::bigint;
end $$;
revoke all on function c3_check_invoice_targets(uuid,uuid,uuid,jsonb,date) from public,anon,authenticated;

-- Shared insert for a validated, locked customer receipt. Returns {paymentId, allocationIds, businessDate}.
-- p_legacy_input: the caller's original allocation array (legacy endpoint). When given, allocation
-- client ids keep the pre-C3 form <client_id>:alloc:<1-based position in the original array>.
create function c3_insert_customer_payment(p_tenant uuid,p_shop uuid,p_customer uuid,p_date date,p_amount bigint,
 p_mode text,p_reference text,p_allocs jsonb,p_payment_client_id text,p_floor_date date,p_legacy_input jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_payment uuid; v_item jsonb; v_alloc uuid; v_ids jsonb:='[]'::jsonb; v_sum bigint; v_suffix text;
begin
 if not exists(select 1 from customers where tenant_id=p_tenant and id=p_customer and deleted_at is null) then
   raise exception 'DSB_CUSTOMER_UNAVAILABLE: customer unavailable';
 end if;
 v_sum:=c3_check_invoice_targets(p_tenant,p_shop,p_customer,p_allocs,p_floor_date);
 if v_sum>p_amount then raise exception 'DSB_ALLOCATION_EXCEEDS_PAYMENT: allocations exceed payment amount'; end if;
 insert into payments(tenant_id,shop_id,kind,customer_id,business_date,amount_paise,mode,reference,direction,status,client_id)
 values(p_tenant,p_shop,'customer',p_customer,p_date,p_amount,p_mode,p_reference,'in','POSTED',p_payment_client_id)
 returning id into v_payment;
 for v_item in select value from jsonb_array_elements(p_allocs) loop
   if p_legacy_input is null then
     v_suffix:=':inv:'||(v_item->>'sale_invoice_id');
   else
     select ':alloc:'||o.ord::text into v_suffix from jsonb_array_elements(p_legacy_input) with ordinality o(e,ord)
      where lower(o.e->>'sale_invoice_id')=v_item->>'sale_invoice_id';
   end if;
   insert into payment_allocations(tenant_id,payment_id,doc_type,sale_invoice_id,amount_paise,client_id)
   values(p_tenant,v_payment,'SALE',(v_item->>'sale_invoice_id')::uuid,(v_item->>'amount_paise')::bigint,
     p_payment_client_id||v_suffix)
   returning id into v_alloc;
   v_ids:=v_ids||to_jsonb(v_alloc);
 end loop;
 return jsonb_build_object('paymentId',v_payment,'allocationIds',v_ids,'businessDate',p_date);
end $$;
revoke all on function c3_insert_customer_payment(uuid,uuid,uuid,date,bigint,text,text,jsonb,text,date,jsonb) from public,anon,authenticated;

create function c3_assert_receipt_input(p_amount bigint,p_mode text,p_reference text) returns void
language plpgsql immutable set search_path=public as $$
begin
 if p_amount is null or p_amount<=0 then raise exception 'DSB_INVALID_AMOUNT: amount must be positive'; end if;
 perform dsb_assert_safe_paise(p_amount);
 if p_mode is null or p_mode not in ('cash','upi','card','bank','other') then raise exception 'DSB_INVALID_MODE: invalid payment mode'; end if;
 if p_reference is not null and char_length(p_reference)>200 then raise exception 'DSB_INVALID_REFERENCE: reference too long'; end if;
end $$;
revoke all on function c3_assert_receipt_input(bigint,text,text) from public,anon,authenticated;

create function record_customer_payment_v2(p_shop_id uuid,p_customer_id uuid,p_business_date date,
 p_amount_paise bigint,p_mode text,p_reference text,p_allocations jsonb,p_client_id text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_req uuid; v_allocs jsonb; v_request jsonb; v_prev jsonb; v_today date; v_date date; v_result jsonb;
begin
 v_req:=c1_assert_request_uuid(p_client_id);
 if not has_perm('POST_SALES') then raise exception 'not permitted'; end if;
 v_tenant:=phase3_assert_shop(p_shop_id);
 if p_allocations is null then raise exception 'DSB_INVALID_ALLOCATIONS: allocations required (use [] for an advance)'; end if;
 v_allocs:=dsb_normalize_allocations(p_allocations,'sale_invoice_id');
 perform c3_assert_receipt_input(p_amount_paise,p_mode,p_reference);
 v_request:=jsonb_build_object('shopId',p_shop_id,'customerId',p_customer_id,'businessDate',p_business_date,
   'amountPaise',p_amount_paise::text,'mode',p_mode,'reference',p_reference,'allocations',v_allocs);

 perform dsb_lock_shop_finance(v_tenant,p_shop_id);
 perform dsb_lock_request(v_tenant,'record_customer_payment_v2',v_req::text);
 v_prev:=dsb_request_result(v_tenant,p_shop_id,'record_customer_payment_v2',v_req::text,v_request);
 if v_prev is not null then return (v_prev->>'paymentId')::uuid; end if;

 v_today:=shop_business_date(p_shop_id);
 v_date:=coalesce(p_business_date,v_today);
 if v_date>v_today then raise exception 'DSB_FUTURE_DATE: payment date is after today'; end if;
 v_result:=c3_insert_customer_payment(v_tenant,p_shop_id,p_customer_id,v_date,p_amount_paise,p_mode,p_reference,
   v_allocs,'record_customer_payment_v2:'||v_req::text,v_date,null);
 insert into financial_requests(tenant_id,shop_id,operation,request,result,client_id)
 values(v_tenant,p_shop_id,'record_customer_payment_v2',v_request,v_result,v_req::text);
 return (v_result->>'paymentId')::uuid;
end $$;

create function allocate_customer_payment_v2(p_payment_id uuid,p_allocations jsonb,p_client_id text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_req uuid; v_shop uuid; v_allocs jsonb; v_request jsonb; v_prev jsonb;
 v_payment payments%rowtype; v_today date; v_used bigint; v_sum bigint; v_item jsonb; v_alloc uuid; v_ids jsonb:='[]'::jsonb; v_result jsonb;
begin
 v_req:=c1_assert_request_uuid(p_client_id);
 if v_tenant is null then raise exception 'not authenticated'; end if;
 if not has_perm('POST_SALES') then raise exception 'not permitted'; end if;
 select shop_id into v_shop from payments where tenant_id=v_tenant and id=p_payment_id;
 if v_shop is null then raise exception 'DSB_PAYMENT_UNAVAILABLE: payment unavailable'; end if;
 perform phase3_assert_shop(v_shop);
 if p_allocations is null or jsonb_typeof(p_allocations)<>'array' or jsonb_array_length(p_allocations)=0 then
   raise exception 'DSB_INVALID_ALLOCATIONS: at least one allocation required';
 end if;
 v_allocs:=dsb_normalize_allocations(p_allocations,'sale_invoice_id');
 v_request:=jsonb_build_object('paymentId',p_payment_id,'allocations',v_allocs);

 perform dsb_lock_shop_finance(v_tenant,v_shop);
 perform dsb_lock_request(v_tenant,'allocate_customer_payment_v2',v_req::text);
 v_prev:=dsb_request_result(v_tenant,v_shop,'allocate_customer_payment_v2',v_req::text,v_request);
 if v_prev is not null then return v_prev; end if;

 select * into v_payment from payments where tenant_id=v_tenant and id=p_payment_id for update;
 if v_payment.status<>'POSTED' or v_payment.deleted_at is not null or v_payment.kind<>'customer' or v_payment.direction<>'in' then
   raise exception 'DSB_PAYMENT_UNAVAILABLE: payment unavailable';
 end if;
 v_today:=shop_business_date(v_shop);
 if v_payment.business_date>v_today then raise exception 'DSB_FUTURE_DATE: payment is dated after today'; end if;
 v_sum:=c3_check_invoice_targets(v_tenant,v_shop,v_payment.customer_id,v_allocs,v_today);
 select coalesce(sum(amount_paise),0) into v_used from payment_allocations
  where tenant_id=v_tenant and payment_id=v_payment.id and status='POSTED';
 if v_used+v_sum>v_payment.amount_paise then raise exception 'DSB_ALLOCATION_EXCEEDS_PAYMENT: allocations exceed payment amount'; end if;
 for v_item in select value from jsonb_array_elements(v_allocs) loop
   insert into payment_allocations(tenant_id,payment_id,doc_type,sale_invoice_id,amount_paise,client_id,effective_date)
   values(v_tenant,v_payment.id,'SALE',(v_item->>'sale_invoice_id')::uuid,(v_item->>'amount_paise')::bigint,
     'allocate_customer_payment_v2:'||v_req::text||':inv:'||(v_item->>'sale_invoice_id'),v_today)
   returning id into v_alloc;
   v_ids:=v_ids||to_jsonb(v_alloc);
 end loop;
 v_result:=jsonb_build_object('paymentId',v_payment.id,'allocationIds',v_ids,'effectiveDate',v_today);
 insert into financial_requests(tenant_id,shop_id,operation,request,result,client_id)
 values(v_tenant,v_shop,'allocate_customer_payment_v2',v_request,v_result,v_req::text);
 return v_result;
end $$;

-- Old signature, rolling compatibility. Same wrapper contract as C0 (shop finance lock first).
-- Retries are resolved BEFORE any input validation: a receipt already on the books must come back
-- even if its original input would fail today's stricter checks, or a cashier may re-enter it.
create or replace function record_customer_payment(p_shop_id uuid,p_customer_id uuid,p_business_date date,
 p_amount_paise bigint,p_mode text,p_reference text,p_allocations jsonb,p_client_id text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_allocs jsonb; v_request jsonb; v_prev jsonb; v_existing payments%rowtype; v_today date; v_date date;
 v_result jsonb; v_stored jsonb; v_raw jsonb;
begin
 if not has_perm('POST_SALES') then raise exception 'not permitted'; end if;
 v_tenant:=phase3_assert_shop(p_shop_id);
 if p_client_id is null or btrim(p_client_id)='' then raise exception 'client_id required'; end if;

 perform dsb_lock_shop_finance(v_tenant,p_shop_id);
 perform dsb_lock_request(v_tenant,'customer.record.legacy-v1',p_client_id);

 -- 1. A post-C3 call: exact replay or PAYLOAD_MISMATCH (only well-formed input can have a row).
 begin
   v_allocs:=dsb_normalize_allocations(p_allocations,'sale_invoice_id');
 exception when others then v_allocs:=null;
 end;
 if v_allocs is not null then
   v_request:=jsonb_build_object('shopId',p_shop_id,'customerId',p_customer_id,'businessDate',p_business_date,
     'amountPaise',p_amount_paise::text,'mode',p_mode,'reference',p_reference,'allocations',v_allocs);
   v_prev:=dsb_request_result(v_tenant,p_shop_id,'customer.record.legacy-v1',p_client_id,v_request);
   if v_prev is not null then return (v_prev->>'paymentId')::uuid; end if;
 end if;

 -- 2. A receipt committed earlier without a request row (pre-C3): compare everything that can be
 --    reconstructed, using only the allocations that call itself created (<client_id>:alloc:<n>).
 select * into v_existing from payments where tenant_id=v_tenant and client_id=p_client_id for update;
 if found then
   select coalesce(jsonb_agg(jsonb_build_array(a.sale_invoice_id::text,a.amount_paise::numeric)
     order by a.sale_invoice_id::text,a.amount_paise),'[]'::jsonb) into v_stored
   from payment_allocations a
   where a.tenant_id=v_tenant and a.payment_id=v_existing.id and a.doc_type='SALE'
     and left(a.client_id,char_length(p_client_id)+7)=p_client_id||':alloc:';
   begin
     select coalesce(jsonb_agg(jsonb_build_array(lower(e->>'sale_invoice_id'),(e->>'amount_paise')::numeric)
       order by lower(e->>'sale_invoice_id'),(e->>'amount_paise')::numeric),'[]'::jsonb) into v_raw
     from jsonb_array_elements(coalesce(p_allocations,'[]'::jsonb)) e;
   exception when others then v_raw:=null;
   end;
   if v_raw is not null and v_existing.shop_id=p_shop_id and v_existing.kind='customer' and v_existing.direction='in'
      and v_existing.customer_id=p_customer_id and v_existing.amount_paise=p_amount_paise and v_existing.mode=p_mode
      and v_existing.reference is not distinct from p_reference
      and (p_business_date is null or v_existing.business_date=p_business_date)
      and v_stored=v_raw then
     return v_existing.id;
   end if;
   raise exception 'DSB_LEGACY_REQUEST_UNVERIFIABLE: an earlier receipt uses this client_id and does not match; reconcile it read-only';
 end if;

 -- 3. A new receipt: full validation, then insert and record the request.
 if char_length(p_client_id)>128 then raise exception 'client_id too long'; end if;
 if p_allocations is null then raise exception 'allocations must be an array'; end if;
 if v_allocs is null then v_allocs:=dsb_normalize_allocations(p_allocations,'sale_invoice_id'); end if; -- raises the real error
 perform c3_assert_receipt_input(p_amount_paise,p_mode,p_reference);
 v_today:=shop_business_date(p_shop_id);
 v_date:=coalesce(p_business_date,v_today);
 if v_date>v_today then raise exception 'DSB_FUTURE_DATE: payment date is after today'; end if;
 v_result:=c3_insert_customer_payment(v_tenant,p_shop_id,p_customer_id,v_date,p_amount_paise,p_mode,p_reference,
   v_allocs,p_client_id,null,p_allocations);
 insert into financial_requests(tenant_id,shop_id,operation,request,result,client_id)
 values(v_tenant,p_shop_id,'customer.record.legacy-v1',v_request,v_result,p_client_id);
 return (v_result->>'paymentId')::uuid;
end $$;

revoke all on function record_customer_payment_v2(uuid,uuid,date,bigint,text,text,jsonb,text) from public,anon;
revoke all on function allocate_customer_payment_v2(uuid,jsonb,text) from public,anon;
grant execute on function record_customer_payment_v2(uuid,uuid,date,bigint,text,text,jsonb,text) to authenticated;
grant execute on function allocate_customer_payment_v2(uuid,jsonb,text) to authenticated;
