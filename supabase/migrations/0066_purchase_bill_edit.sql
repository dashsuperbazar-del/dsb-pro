-- billedit: correct a posted purchase bill in ONE server transaction (owner/manager).
--  * edit_purchase_bill(original, client_id, bill) posts the corrected bill through post_purchase_v2 (same
--    validation, totals, GST/discount, charges, half-up round-off and replay record) and voids the original
--    through void_purchase (stock reversed from the original's immutable lines). Both happen under the
--    per-shop finance lock or neither happens.
--  * Links are server-set and immutable: the new bill's edited_from_id and the original's replaced_by_id.
--    Nothing is deleted.
--  * Payments are CARRIED, never voided (decision 2026-10-21, safest): every live allocation on the original
--    (the automatic cash/UPI payment or any supplier payment assigned to it) is released from the original and
--    re-assigned to the new bill, oldest first, up to the new total. The payments themselves (cash actually
--    paid) are untouched; a part that no longer fits stays on the payment as unassigned supplier credit, so
--    the supplier balance stays exact. Carried allocations keep their effective date (never backdated).
--    When something is carried, the supplier must stay the same and the new bill cannot be dated after today.
--    An edit never creates or voids a payment: the payment type stays as posted, except that a cash/UPI bill
--    whose payment was released or voided is corrected as Credit. void_paid_purchase follows edited_from_id
--    to find a corrected paid bill's carried payment.
--  * Refused with distinct codes: DSB_EDIT_BILL_VOID (already void/replaced), DSB_EDIT_BILL_HAS_RETURNS
--    (posted supplier returns), DSB_EDIT_STOCK_CONSUMED (removing the original's stock would take an item
--    below what is available, i.e. it was already sold or used), DSB_EDIT_STOCK_NEGATIVE (the item was
--    already below zero), DSB_EDIT_SUPPLIER_HAS_PAYMENTS, DSB_EDIT_PAYMENT_TYPE_CHANGED,
--    DSB_EDIT_PAYMENT_GONE, DSB_FUTURE_DATE.
--  * Idempotent: financial_requests 'purchase.edit.v1' keyed by the request UUID (also the new bill's
--    client_id); a retry with the same payload returns the same answer (same new bill id).
--  * Bill images stay on the original (storage paths are unique per tenant); the new bill may add its own.

alter table purchase_bills
 add column edited_from_id uuid,
 add column replaced_by_id uuid,
 add constraint purchase_bills_edited_from_fk foreign key(tenant_id,edited_from_id) references purchase_bills(tenant_id,id),
 add constraint purchase_bills_replaced_by_fk foreign key(tenant_id,replaced_by_id) references purchase_bills(tenant_id,id),
 add constraint purchase_bills_edit_not_self_check check(edited_from_id is distinct from id and replaced_by_id is distinct from id),
 add constraint purchase_bills_replaced_void_check check(replaced_by_id is null or status='VOID');
create unique index purchase_bills_edited_from_key on purchase_bills(tenant_id,edited_from_id) where edited_from_id is not null;
create unique index purchase_bills_replaced_by_key on purchase_bills(tenant_id,replaced_by_id) where replaced_by_id is not null;

-- Links (and the carried payment type) are written only by edit_purchase_bill, once, for the bill it names.
create function be_purchase_link_guard() returns trigger language plpgsql set search_path=public as $$
begin
 if tg_op='INSERT' then
   if new.edited_from_id is not null or new.replaced_by_id is not null then
     raise exception 'DSB_EDIT_LINK_IMMUTABLE: bill edit links are set by the server only';
   end if;
   return new;
 end if;
 -- An invalid payment type is left to the table's own check constraint (its error names it).
 if new.payment_type not in ('credit','cash','upi') then return new; end if;
 if new.edited_from_id is distinct from old.edited_from_id or new.replaced_by_id is distinct from old.replaced_by_id
    or new.payment_type is distinct from old.payment_type then
   if coalesce(current_setting('dsb.bill_edit',true),'')<>new.id::text
      or (new.edited_from_id is distinct from old.edited_from_id and old.edited_from_id is not null)
      or (new.replaced_by_id is distinct from old.replaced_by_id and old.replaced_by_id is not null)
      or (new.payment_type is distinct from old.payment_type
          and not (old.edited_from_id is null and new.edited_from_id is not null)) then
     raise exception 'DSB_EDIT_LINK_IMMUTABLE: bill edit links are set by the server only';
   end if;
 end if;
 return new;
end $$;
revoke all on function be_purchase_link_guard() from public,anon,authenticated;
create trigger purchase_bills_edit_link_guard before insert or update on purchase_bills
 for each row execute function be_purchase_link_guard();

alter table financial_requests drop constraint financial_requests_operation_check;
alter table financial_requests add constraint financial_requests_operation_check check(operation in (
  'supplier.record.v1','supplier.allocate.v1','supplier.void.v1','supplier.release.v1',
  'record_customer_payment_v2','allocate_customer_payment_v2','customer.record.legacy-v1',
  'purchase.post.v2','purchase.void_paid.v1','purchase.edit.v1'));

create function edit_purchase_bill(p_original_id uuid,p_client_id text,p_bill jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
 v_tenant uuid:=current_tenant_id(); v_req uuid; v_client text; v_shop uuid; v_request jsonb; v_prev jsonb;
 v_orig purchase_bills%rowtype; v_new purchase_bills%rowtype; v_post jsonb; v_bill jsonb; v_type text; v_party uuid;
 v_live bigint; v_left bigint; v_take bigint; v_carried bigint:=0; v_alloc payment_allocations%rowtype; v_n int:=0;
 v_item record; v_result jsonb; v_given_date date; v_on numeric; v_res numeric;
begin
 if v_tenant is null then raise exception 'not authenticated'; end if;
 if coalesce("current_role"(),'') not in ('owner','manager') or not has_perm('POST_PURCHASES') then
   raise exception 'not permitted';
 end if;
 v_req:=c1_assert_request_uuid(p_client_id);
 if p_client_id<>v_req::text then raise exception 'DSB_INVALID_REQUEST_ID: client_id must be a lower-case request UUID'; end if;
 v_client:=v_req::text;
 if p_bill is null or jsonb_typeof(p_bill)<>'object' then raise exception 'DSB_INVALID_PURCHASE: bill required'; end if;
 select shop_id into v_shop from purchase_bills where tenant_id=v_tenant and id=p_original_id;
 if v_shop is null then raise exception 'purchase not found'; end if;
 perform phase3_assert_shop(v_shop);
 v_request:=jsonb_build_object('originalId',p_original_id,'bill',p_bill);

 perform dsb_lock_shop_finance(v_tenant,v_shop);
 perform dsb_lock_request(v_tenant,'purchase.edit.v1',v_client);
 v_prev:=dsb_request_result(v_tenant,v_shop,'purchase.edit.v1',v_client,v_request);
 if v_prev is not null then return v_prev; end if;
 if exists(select 1 from purchase_bills where tenant_id=v_tenant and client_id=v_client)
    or exists(select 1 from financial_requests where tenant_id=v_tenant and client_id=v_client
              and operation in ('purchase.post.v2','purchase.edit.v1')) then
   raise exception 'DSB_PAYLOAD_MISMATCH: client_id already used for a different purchase';
 end if;

 select * into v_orig from purchase_bills where tenant_id=v_tenant and id=p_original_id for update;
 if v_orig.status<>'POSTED' or v_orig.replaced_by_id is not null then
   raise exception 'DSB_EDIT_BILL_VOID: this bill is void or was already edited; open the current bill';
 end if;
 if exists(select 1 from purchase_returns where tenant_id=v_tenant and purchase_bill_id=v_orig.id and status='POSTED') then
   raise exception 'DSB_EDIT_BILL_HAS_RETURNS: this bill has supplier returns; void those returns first';
 end if;

 v_type:=coalesce(p_bill->>'payment_type','credit');
 v_party:=nullif(p_bill->>'party_id','')::uuid;
 v_given_date:=nullif(p_bill->>'business_date','')::date;
 select coalesce(sum(amount_paise),0) into v_live from payment_allocations
  where tenant_id=v_tenant and purchase_bill_id=v_orig.id and status='POSTED';
 -- An edit never creates or voids a payment. A paid (cash/UPI) bill whose payment is no longer assigned to it
 -- (released or voided) is corrected as Credit; otherwise the payment type stays as posted.
 if v_orig.payment_type<>'credit' and v_live=0 then
   if v_type<>'credit' then
     raise exception 'DSB_EDIT_PAYMENT_GONE: this bill''s payment was released or voided; save the corrected bill as Credit and record any payment separately';
   end if;
 elsif v_type<>v_orig.payment_type then
   raise exception 'DSB_EDIT_PAYMENT_TYPE_CHANGED: an edit keeps the payment type (%); record or void supplier payments separately',v_orig.payment_type;
 end if;
 if v_live>0 then
   if v_party is distinct from v_orig.party_id then
     raise exception 'DSB_EDIT_SUPPLIER_HAS_PAYMENTS: a payment is assigned to this bill, so its supplier cannot change; void the bill and enter it again';
   end if;
   if coalesce(v_given_date,shop_business_date(v_shop))>shop_business_date(v_shop) then
     raise exception 'DSB_FUTURE_DATE: a bill with a payment cannot be dated after today';
   end if;
 end if;
 -- Posted as credit (no new payment); a carried payment settles it and its type is restored below.
 v_bill:=jsonb_set(p_bill,'{payment_type}','"credit"');

 -- 1. The corrected bill, through the normal v2 path (validation, totals, round-off, stock in).
 v_post:=post_purchase_v2(v_shop,v_client,v_bill);
 select * into v_new from purchase_bills where tenant_id=v_tenant and id=(v_post->>'billId')::uuid for update;
 if v_new.client_id<>v_client or v_new.shop_id<>v_shop then
   raise exception 'DSB_PAYLOAD_MISMATCH: client_id already used for a different purchase';
 end if;
 perform set_config('dsb.bill_edit',v_new.id::text,true);
 update purchase_bills set edited_from_id=v_orig.id,payment_type=v_type where id=v_new.id;

 -- 2. Carry live allocations (oldest first) from the original to the new bill.
 v_left:=v_new.total_paise;
 for v_alloc in select * from payment_allocations where tenant_id=v_tenant and purchase_bill_id=v_orig.id and status='POSTED'
                order by created_at,id for update loop
   update payment_allocations set status='VOID' where id=v_alloc.id;
   v_take:=least(v_alloc.amount_paise,v_left);
   if v_take>0 then
     v_n:=v_n+1;
     -- Never backdated: as-of reports keep the day the payment was first assigned (or the new bill's date).
     insert into payment_allocations(tenant_id,payment_id,doc_type,purchase_bill_id,amount_paise,client_id,effective_date)
     values(v_tenant,v_alloc.payment_id,'PURCHASE',v_new.id,v_take,'purchase.edit.v1:'||v_client||':alloc:'||v_n::text,
       greatest(v_alloc.effective_date,v_new.business_date));
     v_left:=v_left-v_take;
     v_carried:=v_carried+v_take;
   end if;
 end loop;

 -- 3. Stock: removing the original's quantities must not take any item below what is available.
 -- (The stock trigger refuses any reversal that leaves an item below what is available.) An item that was
 -- already below zero before the edit gets its own code: its stock must be counted first.
 for v_item in select l.item_id,max(l.item_name_snapshot) as name,sum(l.base_qty) as qty,
                 coalesce((select sum(n.base_qty) from purchase_bill_items n where n.tenant_id=v_tenant
                   and n.purchase_bill_id=v_new.id and n.item_id=l.item_id),0) as new_qty
               from purchase_bill_items l
               where l.tenant_id=v_tenant and l.purchase_bill_id=v_orig.id and l.deleted_at is null group by l.item_id loop
   select on_hand,reserved into v_on,v_res from stock_current where tenant_id=v_tenant and shop_id=v_shop and item_id=v_item.item_id;
   if found and v_on-v_item.qty<v_res then
     if v_on-v_item.new_qty<v_res then
       raise exception 'DSB_EDIT_STOCK_NEGATIVE: % stock is already below zero; count its stock, then edit the bill',v_item.name;
     end if;
     raise exception 'DSB_EDIT_STOCK_CONSUMED: % was already sold or used, so the original quantity cannot be taken back',v_item.name;
   end if;
 end loop;

 -- 4. Void the original (stock reversal from its immutable lines; returns guard re-checks).
 perform void_purchase(v_orig.id,'purchase.edit.v1:'||v_client);
 perform set_config('dsb.bill_edit',v_orig.id::text,true);
 update purchase_bills set replaced_by_id=v_new.id where id=v_orig.id;
 perform set_config('dsb.bill_edit','',true);

 v_result:=jsonb_build_object('billId',v_new.id,'originalBillId',v_orig.id,'paymentId',v_post->'paymentId',
   'carriedPaise',v_carried::text,'totalPaise',v_post->>'totalPaise','roundOffPaise',v_post->>'roundOffPaise',
   'businessDate',v_post->>'businessDate');
 insert into financial_requests(tenant_id,shop_id,operation,request,result,client_id)
 values(v_tenant,v_shop,'purchase.edit.v1',v_request,v_result,v_client);
 return v_result;
end $$;
revoke all on function edit_purchase_bill(uuid,text,jsonb) from public,anon;
grant execute on function edit_purchase_bill(uuid,text,jsonb) to authenticated;

-- void_paid_purchase (0064) found a bill's payment only in its own 'purchase.post.v2' answer. A corrected cash/UPI
-- bill was posted without a payment (the original's payment is carried), so its payment is found by following
-- edited_from_id back to the bill that created it, and used only while it is still assigned to THIS bill.
-- Otherwise unchanged (owner only, same request record, same refusals).
create or replace function void_paid_purchase(p_purchase_id uuid,p_reason text,p_client_id text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_req uuid; v_shop uuid; v_request jsonb; v_prev jsonb; v_bill purchase_bills%rowtype;
 v_payment uuid; v_status text; v_result jsonb; v_voided boolean:=false; v_cur purchase_bills%rowtype; v_hops int:=0;
begin
 v_req:=c1_assert_request_uuid(p_client_id);
 if v_tenant is null then raise exception 'not authenticated'; end if;
 if coalesce("current_role"(),'')<>'owner' then raise exception 'not permitted'; end if;
 if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
   raise exception 'DSB_INVALID_REASON: reason required (1-500 characters)';
 end if;
 select shop_id into v_shop from purchase_bills where tenant_id=v_tenant and id=p_purchase_id;
 if v_shop is null then raise exception 'purchase not found'; end if;
 perform phase3_assert_shop(v_shop);
 v_request:=jsonb_build_object('purchaseId',p_purchase_id,'reason',btrim(p_reason));
 perform dsb_lock_shop_finance(v_tenant,v_shop);
 perform dsb_lock_request(v_tenant,'purchase.void_paid.v1',v_req::text);
 v_prev:=dsb_request_result(v_tenant,v_shop,'purchase.void_paid.v1',v_req::text,v_request);
 if v_prev is not null then return v_prev; end if;
 select * into v_bill from purchase_bills where tenant_id=v_tenant and id=p_purchase_id for update;
 if v_bill.payment_type='credit' then
   raise exception 'DSB_NOT_PAID_BILL: this is a credit bill; void it with the normal void';
 end if;
 v_cur:=v_bill;
 loop
   select (result->>'paymentId')::uuid into v_payment from financial_requests
    where tenant_id=v_tenant and operation='purchase.post.v2' and client_id=v_cur.client_id;
   exit when v_payment is not null or v_cur.edited_from_id is null or v_hops>=1000;
   v_hops:=v_hops+1;
   select * into v_cur from purchase_bills where tenant_id=v_tenant and id=v_cur.edited_from_id;
 end loop;
 if v_payment is not null and v_cur.id<>v_bill.id
    and not exists(select 1 from payment_allocations where tenant_id=v_tenant and payment_id=v_payment
                   and purchase_bill_id=v_bill.id and status='POSTED') then
   v_payment:=null;
 end if;
 if v_payment is not null then
   select status into v_status from payments where tenant_id=v_tenant and id=v_payment for update;
   if v_status='POSTED' then
     if exists(select 1 from payment_allocations where tenant_id=v_tenant and payment_id=v_payment and status='POSTED'
                 and purchase_bill_id is distinct from v_bill.id) then
       raise exception 'DSB_PAYMENT_REASSIGNED: the bill''s payment is also assigned elsewhere; release that first';
     end if;
     perform void_supplier_payment(v_payment,p_reason,md5('dsb.purchase.v2.void-payment:'||v_req::text)::uuid::text);
     v_voided:=true;
   end if;
 end if;
 perform void_purchase(v_bill.id,'purchase.void_paid.v1:'||v_req::text);
 v_result:=jsonb_build_object('billId',v_bill.id,'paymentId',v_payment,'paymentVoided',v_voided);
 insert into financial_requests(tenant_id,shop_id,operation,request,result,client_id)
 values(v_tenant,v_shop,'purchase.void_paid.v1',v_request,v_result,v_req::text);
 return v_result;
end $$;

-- Outcome reconciliation also answers bill edits (same permission as posting).
create or replace function get_financial_request(p_shop_id uuid,p_operation text,p_client_id text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_row financial_requests%rowtype; v_payment uuid; v_status text;
begin
 v_tenant:=phase3_assert_shop(p_shop_id);
 if p_operation in ('supplier.record.v1','supplier.allocate.v1','supplier.void.v1','supplier.release.v1',
                    'purchase.post.v2','purchase.void_paid.v1','purchase.edit.v1') then
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
