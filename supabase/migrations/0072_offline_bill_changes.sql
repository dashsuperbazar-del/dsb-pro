-- offlinebillchange: purchase bill edits and voids saved on a device while offline (owner/manager), applied only
-- if the bill is unchanged since the device read it. Never last-write-wins.
--  * get_purchase_bill_version(bill) -> text: a version token of everything an edit or void depends on: status,
--    replaced_by_id, updated_at, every live allocation (id, amount) and every posted supplier return. The device
--    reads it with the bill and queues it with the request.
--  * edit_purchase_bill_if_unchanged(original, client_id, bill, base_version): an exact replay of an edit already
--    applied under this client id returns the stored answer FIRST (so a resend after a lost answer is never
--    refused as stale); otherwise the bill must still have base_version (else DSB_BILL_CHANGED) and then the
--    normal edit_purchase_bill (0066) runs with all its rules (one transaction, payments carried).
--  * void_purchase_if_unchanged(bill, client_id, reason, base_version): same replay-first rule (financial_requests
--    'purchase.void.offline.v1'); then DSB_BILL_CHANGED on a changed bill; a bill with any live payment allocation
--    is refused (DSB_VOID_HAS_PAYMENTS: release or void the payment first, online); then void_purchase (stock reversed
--    from the immutable lines; returns guard re-checks). The reason is kept in the void movement ids exactly like
--    the online void ('purchase.void.v1:<request>:reason:<reason>').
--  * get_financial_request also answers 'purchase.void.offline.v1' (same permission as posting).
-- Forward-only: 0066 and earlier stay as they are.

alter table financial_requests drop constraint financial_requests_operation_check;
alter table financial_requests add constraint financial_requests_operation_check check(operation in (
  'supplier.record.v1','supplier.allocate.v1','supplier.void.v1','supplier.release.v1',
  'record_customer_payment_v2','allocate_customer_payment_v2','customer.record.legacy-v1',
  'purchase.post.v2','purchase.void_paid.v1','purchase.edit.v1','purchase.void.offline.v1'));

create function obc_bill_version(p_tenant uuid,p_bill uuid) returns text
language sql stable security definer set search_path=public as $$
 select md5(concat_ws('|',b.status,coalesce(b.replaced_by_id::text,'-'),b.updated_at::text,
   coalesce((select string_agg(a.id::text||':'||a.amount_paise::text,',' order by a.id) from payment_allocations a
     where a.tenant_id=p_tenant and a.purchase_bill_id=b.id and a.status='POSTED'),'-'),
   coalesce((select string_agg(r.id::text,',' order by r.id) from purchase_returns r
     where r.tenant_id=p_tenant and r.purchase_bill_id=b.id and r.status='POSTED'),'-')))
 from purchase_bills b where b.tenant_id=p_tenant and b.id=p_bill
$$;
revoke all on function obc_bill_version(uuid,uuid) from public,anon,authenticated;

create function get_purchase_bill_version(p_bill_id uuid) returns text
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_shop uuid;
begin
 if v_tenant is null then raise exception 'not authenticated'; end if;
 if not has_perm('POST_PURCHASES') then raise exception 'not permitted'; end if;
 select shop_id into v_shop from purchase_bills where tenant_id=v_tenant and id=p_bill_id;
 if v_shop is null then raise exception 'purchase not found'; end if;
 perform phase3_assert_shop(v_shop);
 return obc_bill_version(v_tenant,p_bill_id);
end $$;
revoke all on function get_purchase_bill_version(uuid) from public,anon;
grant execute on function get_purchase_bill_version(uuid) to authenticated;

create function edit_purchase_bill_if_unchanged(p_original_id uuid,p_client_id text,p_bill jsonb,p_base_version text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_req uuid; v_shop uuid; v_prev jsonb;
begin
 if v_tenant is null then raise exception 'not authenticated'; end if;
 if coalesce("current_role"(),'') not in ('owner','manager') or not has_perm('POST_PURCHASES') then
   raise exception 'not permitted';
 end if;
 v_req:=c1_assert_request_uuid(p_client_id);
 if p_client_id<>v_req::text then raise exception 'DSB_INVALID_REQUEST_ID: client_id must be a lower-case request UUID'; end if;
 if p_bill is null or jsonb_typeof(p_bill)<>'object' then raise exception 'DSB_INVALID_PURCHASE: bill required'; end if;
 if p_base_version is null or p_base_version !~ '^[0-9a-f]{32}$' then
   raise exception 'DSB_INVALID_REQUEST: base version required';
 end if;
 select shop_id into v_shop from purchase_bills where tenant_id=v_tenant and id=p_original_id;
 if v_shop is null then raise exception 'purchase not found'; end if;
 perform phase3_assert_shop(v_shop);
 perform dsb_lock_shop_finance(v_tenant,v_shop);
 perform dsb_lock_request(v_tenant,'purchase.edit.v1',p_client_id);
 -- Replay first: this exact edit was already applied (the bill is now replaced, which is expected).
 v_prev:=dsb_request_result(v_tenant,v_shop,'purchase.edit.v1',p_client_id,
   jsonb_build_object('originalId',p_original_id,'bill',p_bill));
 if v_prev is not null then return v_prev; end if;
 perform 1 from purchase_bills where tenant_id=v_tenant and id=p_original_id for update;
 if obc_bill_version(v_tenant,p_original_id) is distinct from p_base_version then
   raise exception 'DSB_BILL_CHANGED: this bill changed after this edit was saved on the device (edited, voided, paid or returned); open the bill and redo the edit';
 end if;
 return edit_purchase_bill(p_original_id,p_client_id,p_bill);
end $$;
revoke all on function edit_purchase_bill_if_unchanged(uuid,text,jsonb,text) from public,anon;
grant execute on function edit_purchase_bill_if_unchanged(uuid,text,jsonb,text) to authenticated;

create function void_purchase_if_unchanged(p_purchase_id uuid,p_client_id text,p_reason text,p_base_version text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_req uuid; v_shop uuid; v_prev jsonb; v_reason text; v_request jsonb;
 v_result jsonb;
begin
 if v_tenant is null then raise exception 'not authenticated'; end if;
 if coalesce("current_role"(),'') not in ('owner','manager') or not has_perm('POST_PURCHASES') then
   raise exception 'not permitted';
 end if;
 v_req:=c1_assert_request_uuid(p_client_id);
 if p_client_id<>v_req::text then raise exception 'DSB_INVALID_REQUEST_ID: client_id must be a lower-case request UUID'; end if;
 v_reason:=regexp_replace(btrim(coalesce(p_reason,'')),'\s+',' ','g');
 if char_length(v_reason) not between 1 and 200 or position(':' in v_reason)>0 then
   raise exception 'DSB_INVALID_REASON: reason required (1-200 characters, no colon)';
 end if;
 if p_base_version is null or p_base_version !~ '^[0-9a-f]{32}$' then
   raise exception 'DSB_INVALID_REQUEST: base version required';
 end if;
 select shop_id into v_shop from purchase_bills where tenant_id=v_tenant and id=p_purchase_id;
 if v_shop is null then raise exception 'purchase not found'; end if;
 perform phase3_assert_shop(v_shop);
 v_request:=jsonb_build_object('purchaseId',p_purchase_id,'reason',v_reason);
 perform dsb_lock_shop_finance(v_tenant,v_shop);
 perform dsb_lock_request(v_tenant,'purchase.void.offline.v1',p_client_id);
 v_prev:=dsb_request_result(v_tenant,v_shop,'purchase.void.offline.v1',p_client_id,v_request);
 if v_prev is not null then return v_prev; end if;
 perform 1 from purchase_bills where tenant_id=v_tenant and id=p_purchase_id for update;
 if obc_bill_version(v_tenant,p_purchase_id) is distinct from p_base_version then
   raise exception 'DSB_BILL_CHANGED: this bill changed after this void was saved on the device (edited, voided, paid or returned); open the bill and decide again';
 end if;
 if exists(select 1 from payment_allocations where tenant_id=v_tenant and purchase_bill_id=p_purchase_id and status='POSTED') then
   raise exception 'DSB_VOID_HAS_PAYMENTS: a payment is assigned to this bill; release or void that payment first (online), then void the bill';
 end if;
 perform void_purchase(p_purchase_id,'purchase.void.v1:'||p_client_id||':reason:'||v_reason);
 v_result:=jsonb_build_object('billId',p_purchase_id,'voided',true);
 insert into financial_requests(tenant_id,shop_id,operation,request,result,client_id)
 values(v_tenant,v_shop,'purchase.void.offline.v1',v_request,v_result,p_client_id);
 return v_result;
end $$;
revoke all on function void_purchase_if_unchanged(uuid,text,text,text) from public,anon;
grant execute on function void_purchase_if_unchanged(uuid,text,text,text) to authenticated;

-- Outcome reconciliation also answers offline voids (same permission as posting). Otherwise as in 0066.
create or replace function get_financial_request(p_shop_id uuid,p_operation text,p_client_id text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_row financial_requests%rowtype; v_payment uuid; v_status text;
begin
 v_tenant:=phase3_assert_shop(p_shop_id);
 if p_operation in ('supplier.record.v1','supplier.allocate.v1','supplier.void.v1','supplier.release.v1',
                    'purchase.post.v2','purchase.void_paid.v1','purchase.edit.v1','purchase.void.offline.v1') then
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
