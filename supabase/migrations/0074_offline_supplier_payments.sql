-- offlinesupplierpay: supplier payments saved on a device while offline (owner/manager), applied only if what the
-- device read is still true. Never last-write-wins, never silently re-pointed.
--  * get_supplier_pay_context(shop): what the device keeps for offline "Pay supplier": every live supplier with what
--    is owed (net ledger balance, text paise), a supplier version token and its open bills (outstanding, version
--    token). Owner/manager only.
--  * pay_supplier_if_unchanged(...): an exact replay of a payment already applied under this client id returns the
--    stored answer FIRST (a resend after a lost answer is never refused as stale). Otherwise, in one transaction
--    under the shop finance lock: the supplier must be live and not merged (DSB_SUPPLIER_ARCHIVED /
--    DSB_SUPPLIER_MERGED -- unlike the online path, a merged supplier is REFUSED, never redirected), keep its version
--    (DSB_SUPPLIER_CHANGED), every allocated bill must still be posted with the version the device saw
--    (DSB_BILL_CHANGED: voided, edited, replaced, returned or moved), not already paid (DSB_BILL_ALREADY_PAID) and
--    not over-allocated (DSB_ALLOCATION_EXCEEDS_BILL), and the amount may not exceed what is owed to the supplier
--    right now (DSB_PAYMENT_EXCEEDS_OWED, so a second queued payment sees the first). Then the normal
--    record_supplier_payment (0062) runs unchanged. A bill's version does NOT include its allocations: two queued
--    payments to one bill are ordered by the outstanding check, not refused as "changed".
--  * get_financial_request also answers 'supplier.pay.offline.v1' (same permission as posting).
-- Forward-only: 0047 and 0062 stay as they are.

alter table financial_requests drop constraint financial_requests_operation_check;
alter table financial_requests add constraint financial_requests_operation_check check(operation in (
  'supplier.record.v1','supplier.allocate.v1','supplier.void.v1','supplier.release.v1',
  'record_customer_payment_v2','allocate_customer_payment_v2','customer.record.legacy-v1',
  'purchase.post.v2','purchase.void_paid.v1','purchase.edit.v1','purchase.void.offline.v1',
  'supplier.pay.offline.v1'));

create function obp_supplier_version(p_tenant uuid,p_party uuid) returns text
language sql stable security definer set search_path=public as $$
 select md5(concat_ws('|',coalesce(p.deleted_at::text,'-'),
   coalesce((select m.target_party_id::text from party_merges m where m.tenant_id=p_tenant and m.source_party_id=p.id),'-')))
 from parties p where p.tenant_id=p_tenant and p.id=p_party
$$;
revoke all on function obp_supplier_version(uuid,uuid) from public,anon,authenticated;

create function obp_bill_version(p_tenant uuid,p_bill uuid) returns text
language sql stable security definer set search_path=public as $$
 select md5(concat_ws('|',b.status,coalesce(b.party_id::text,'-'),b.total_paise::text,
   coalesce(b.replaced_by_id::text,'-'),b.updated_at::text,coalesce(b.deleted_at::text,'-'),
   coalesce((select string_agg(r.id::text,',' order by r.id) from purchase_returns r
     where r.tenant_id=p_tenant and r.purchase_bill_id=b.id and r.status='POSTED'),'-')))
 from purchase_bills b where b.tenant_id=p_tenant and b.id=p_bill
$$;
revoke all on function obp_bill_version(uuid,uuid) from public,anon,authenticated;

create function obp_owed(p_shop uuid,p_party uuid) returns bigint
language sql stable security definer set search_path=public as $$
 select coalesce((select (x->>'netLedgerBalance')::bigint
   from jsonb_array_elements(get_supplier_outstanding(p_shop)->'parties') x where x->>'partyId'=p_party::text),0)
$$;
revoke all on function obp_owed(uuid,uuid) from public,anon,authenticated;

create function get_supplier_pay_context(p_shop_id uuid) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid; v_owed jsonb;
begin
 v_tenant:=phase3_assert_shop(p_shop_id);
 if coalesce("current_role"(),'') not in ('owner','manager') or not has_perm('POST_PURCHASES') then
   raise exception 'not permitted';
 end if;
 -- The supplier report is computed once (not per supplier): {partyId: net ledger balance}.
 select coalesce(jsonb_object_agg(x->>'partyId',x->>'netLedgerBalance'),'{}'::jsonb) into v_owed
   from jsonb_array_elements(get_supplier_outstanding(p_shop_id)->'parties') x;
 return jsonb_build_object('shopId',p_shop_id,'businessDate',shop_business_date(p_shop_id),
  'suppliers',coalesce((
   select jsonb_agg(jsonb_build_object('partyId',pt.id,'name',pt.name,'owedPaise',coalesce(v_owed->>pt.id::text,'0'),
     'version',obp_supplier_version(v_tenant,pt.id),
     'bills',coalesce((select jsonb_agg(jsonb_build_object('billId',b.purchase_bill_id,'billNo',b.bill_no,
        'businessDate',b.business_date,'outstandingPaise',b.outstanding_paise::text,
        'version',obp_bill_version(v_tenant,b.purchase_bill_id)) order by b.business_date,b.purchase_bill_id)
       from purchase_bill_outstanding b where b.tenant_id=v_tenant and b.shop_id=p_shop_id and b.party_id=pt.id
        and b.outstanding_paise>0),'[]'::jsonb)) order by pt.name,pt.id)
   from parties pt where pt.tenant_id=v_tenant and pt.deleted_at is null
    and not exists(select 1 from party_merges m where m.tenant_id=v_tenant and m.source_party_id=pt.id)),'[]'::jsonb));
end $$;
revoke all on function get_supplier_pay_context(uuid) from public,anon;
grant execute on function get_supplier_pay_context(uuid) to authenticated;

create function pay_supplier_if_unchanged(p_shop_id uuid,p_party_id uuid,p_business_date date,p_amount_paise bigint,
 p_mode text,p_reference text,p_allocations jsonb,p_client_id text,p_base_versions jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_req uuid; v_allocs jsonb; v_request jsonb; v_prev jsonb; v_today date; v_date date;
 v_party parties%rowtype; v_item jsonb; v_bill purchase_bills%rowtype; v_amount bigint; v_open bigint; v_given text;
 v_sum bigint:=0; v_payment uuid; v_result jsonb;
begin
 v_tenant:=current_tenant_id();
 if v_tenant is null then raise exception 'not authenticated'; end if;
 if coalesce("current_role"(),'') not in ('owner','manager') or not has_perm('POST_PURCHASES') then
   raise exception 'not permitted';
 end if;
 v_req:=c1_assert_request_uuid(p_client_id);
 if p_client_id<>v_req::text then raise exception 'DSB_INVALID_REQUEST_ID: client_id must be a lower-case request UUID'; end if;
 v_tenant:=phase3_assert_shop(p_shop_id);
 if p_amount_paise is null or p_amount_paise<=0 then raise exception 'DSB_INVALID_AMOUNT: amount must be positive'; end if;
 perform dsb_assert_safe_paise(p_amount_paise);
 if p_mode is null or p_mode not in ('cash','upi','card','bank','other') then raise exception 'DSB_INVALID_MODE: invalid payment mode'; end if;
 if p_reference is not null and char_length(p_reference)>200 then raise exception 'DSB_INVALID_REFERENCE: reference too long'; end if;
 if p_allocations is null then raise exception 'DSB_INVALID_ALLOCATIONS: allocations required (use [] for none)'; end if;
 v_allocs:=dsb_normalize_allocations(p_allocations,'purchase_bill_id');
 if p_base_versions is null or jsonb_typeof(p_base_versions)<>'object'
    or coalesce(p_base_versions->>'supplier','') !~ '^[0-9a-f]{32}$'
    or jsonb_typeof(coalesce(p_base_versions->'bills','{}'::jsonb))<>'object' then
   raise exception 'DSB_INVALID_REQUEST: base versions required';
 end if;
 v_request:=jsonb_build_object('shopId',p_shop_id,'partyId',p_party_id,'businessDate',p_business_date,
   'amountPaise',p_amount_paise::text,'mode',p_mode,'reference',p_reference,'allocations',v_allocs);

 perform dsb_lock_shop_finance(v_tenant,p_shop_id);
 perform dsb_lock_request(v_tenant,'supplier.pay.offline.v1',v_req::text);
 -- Replay first: this exact payment was already applied (its bills are now partly paid, which is expected).
 v_prev:=dsb_request_result(v_tenant,p_shop_id,'supplier.pay.offline.v1',v_req::text,v_request);
 if v_prev is not null then return v_prev; end if;

 select * into v_party from parties where tenant_id=v_tenant and id=p_party_id for key share;
 if not found then raise exception 'DSB_SUPPLIER_UNAVAILABLE: supplier unavailable'; end if;
 if exists(select 1 from party_merges where tenant_id=v_tenant and source_party_id=p_party_id) then
   raise exception 'DSB_SUPPLIER_MERGED: this supplier was merged into another after the payment was saved on the device; nothing was recorded. Pay the kept supplier instead';
 end if;
 if v_party.deleted_at is not null then
   raise exception 'DSB_SUPPLIER_ARCHIVED: this supplier was archived after the payment was saved on the device; nothing was recorded';
 end if;
 if obp_supplier_version(v_tenant,p_party_id) is distinct from p_base_versions->>'supplier' then
   raise exception 'DSB_SUPPLIER_CHANGED: this supplier changed after the payment was saved on the device; nothing was recorded';
 end if;
 v_today:=shop_business_date(p_shop_id);
 v_date:=coalesce(p_business_date,v_today);
 if v_date>v_today then raise exception 'DSB_FUTURE_DATE: payment date is after today'; end if;

 for v_item in select value from jsonb_array_elements(v_allocs) loop  -- sorted by bill id: stable lock order
   v_amount:=(v_item->>'amount_paise')::bigint;
   select * into v_bill from purchase_bills where tenant_id=v_tenant and id=(v_item->>'purchase_bill_id')::uuid for update;
   if not found then raise exception 'DSB_BILL_UNAVAILABLE: a bill this payment is assigned to no longer exists'; end if;
   if v_bill.shop_id<>p_shop_id or v_bill.party_id is distinct from p_party_id then
     raise exception 'DSB_BILL_CHANGED: a bill this payment is assigned to no longer belongs to this supplier; nothing was recorded';
   end if;
   v_given:=p_base_versions->'bills'->>(v_item->>'purchase_bill_id');
   if v_given is null or v_given !~ '^[0-9a-f]{32}$' then
     raise exception 'DSB_INVALID_REQUEST: base version missing for an assigned bill';
   end if;
   if v_bill.status<>'POSTED' or v_bill.deleted_at is not null
      or obp_bill_version(v_tenant,v_bill.id) is distinct from v_given then
     raise exception 'DSB_BILL_CHANGED: a bill this payment is assigned to changed after the payment was saved on the device (voided, edited, replaced or returned); nothing was recorded';
   end if;
   select outstanding_paise into v_open from purchase_bill_outstanding where purchase_bill_id=v_bill.id;
   if coalesce(v_open,0)=0 then
     raise exception 'DSB_BILL_ALREADY_PAID: a bill this payment is assigned to is already fully paid; nothing was recorded';
   end if;
   if v_amount>v_open then
     raise exception 'DSB_ALLOCATION_EXCEEDS_BILL: the amount assigned to a bill is more than is still owed on it; nothing was recorded';
   end if;
   v_sum:=v_sum+v_amount;
 end loop;
 if v_sum>p_amount_paise then raise exception 'DSB_ALLOCATION_EXCEEDS_PAYMENT: allocations exceed payment amount'; end if;
 if p_amount_paise>greatest(obp_owed(p_shop_id,p_party_id),0) then
   raise exception 'DSB_PAYMENT_EXCEEDS_OWED: this payment is more than is owed to the supplier now (an earlier payment or a return may have reduced it); nothing was recorded';
 end if;

 v_payment:=record_supplier_payment(p_shop_id,p_party_id,v_date,p_amount_paise,p_mode,p_reference,v_allocs,v_req::text);
 select result into v_result from financial_requests
  where tenant_id=v_tenant and operation='supplier.record.v1' and client_id=v_req::text;
 if v_result is null or (v_result->>'paymentId')::uuid is distinct from v_payment then
   raise exception 'DSB_INTERNAL: the payment answer could not be read back';
 end if;
 insert into financial_requests(tenant_id,shop_id,operation,request,result,client_id)
 values(v_tenant,p_shop_id,'supplier.pay.offline.v1',v_request,v_result,v_req::text);
 return v_result;
end $$;
revoke all on function pay_supplier_if_unchanged(uuid,uuid,date,bigint,text,text,jsonb,text,jsonb) from public,anon;
grant execute on function pay_supplier_if_unchanged(uuid,uuid,date,bigint,text,text,jsonb,text,jsonb) to authenticated;

-- Outcome reconciliation also answers offline supplier payments (same permission as posting). Otherwise as in 0072.
create or replace function get_financial_request(p_shop_id uuid,p_operation text,p_client_id text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_row financial_requests%rowtype; v_payment uuid; v_status text;
begin
 v_tenant:=phase3_assert_shop(p_shop_id);
 if p_operation in ('supplier.record.v1','supplier.allocate.v1','supplier.void.v1','supplier.release.v1',
                    'purchase.post.v2','purchase.void_paid.v1','purchase.edit.v1','purchase.void.offline.v1',
                    'supplier.pay.offline.v1') then
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
