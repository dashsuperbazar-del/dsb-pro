-- Packet R0b (group r0b): the return that completes a rounded bill also reverses its round-off
-- (user decision 2026-10-02). Before: returns refunded exact item value only, so a fully returned
-- rounded-down bill credited the customer up to 0.49 they never paid (and a walk-in got a stray
-- "balance credit"), while a rounded-up bill kept up to 0.50. Now all returns of a bill together
-- equal what was billed (extra charges still stay with the shop, unchanged). Partial returns carry
-- item value only; the completing return stores the bill's round-off in sale_returns.round_off_paise.
-- Upper bound only: the adjustment is at most the bill's +50 round-up; downward it is bounded by the
-- non-negative return total (existing total_paise >= 0 check).
alter table sale_returns add column round_off_paise bigint not null default 0
  check (round_off_paise <= 50);

-- The void path must keep round_off_paise unchanged like every other money field.
create or replace function phase65_sale_return_guard() returns trigger language plpgsql as $$
begin
 if old.status='DRAFT' and new.status='POSTED' and new.posted_at is not null then return new; end if;
 if old.status='POSTED' and new.status='VOID'
    and new.tenant_id=old.tenant_id and new.shop_id=old.shop_id
    and new.sale_invoice_id=old.sale_invoice_id and new.customer_id is not distinct from old.customer_id
    and new.doc_no=old.doc_no and new.doc_seq=old.doc_seq and new.business_date=old.business_date
    and new.total_paise=old.total_paise and new.cash_refund_paise=old.cash_refund_paise
    and new.balance_credit_paise=old.balance_credit_paise and new.round_off_paise=old.round_off_paise
    and new.notes is not distinct from old.notes
    and new.request_fingerprint=old.request_fingerprint and new.voided_at is not null then return new;
 end if;
 raise exception 'posted sale return is immutable; use void_return';
end $$;

-- Return body (from 0036 via 0043/0046 renames), unchanged except the R0b block and v_round.
CREATE OR REPLACE FUNCTION public.phase65_post_return_unlocked(p_return_type text, p_source_id uuid, p_business_date date, p_client_id text, p_lines jsonb, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
 v_tenant uuid:=current_tenant_id(); v_type text:=upper(btrim(coalesce(p_return_type,''))); v_date date;
 v_existing_id uuid; v_existing_source uuid; v_existing_fingerprint text; v_fingerprint text;
 v_sale sale_invoices%rowtype; v_sale_line sale_invoice_items%rowtype; v_sale_return uuid;
 v_purchase purchase_bills%rowtype; v_purchase_line purchase_bill_items%rowtype; v_purchase_return uuid;
 v_line jsonb; v_ord bigint; v_qty numeric; v_base numeric; v_prior_base numeric; v_prior_amount bigint;
 v_cap bigint; v_amount bigint; v_total bigint:=0; v_disposition text; v_seq bigint; v_doc text;
 v_received bigint:=0; v_prior_refunds bigint:=0; v_refund bigint:=0; v_round bigint:=0; v_prior_total bigint; v_remaining bigint;
begin
 if v_tenant is null then raise exception 'not authenticated'; end if;
 if v_type not in ('SALE','PURCHASE') then raise exception 'return type must be SALE or PURCHASE'; end if;
 if p_client_id is null or btrim(p_client_id)='' then raise exception 'client_id required'; end if;
 if p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then raise exception 'return requires lines'; end if;

 perform pg_advisory_xact_lock(hashtextextended(v_tenant::text||':return-client:'||p_client_id,0));

 if v_type='SALE' then
   if not has_perm('POST_SALES') then raise exception 'not permitted'; end if;
   select id,sale_invoice_id,request_fingerprint into v_existing_id,v_existing_source,v_existing_fingerprint
   from sale_returns where tenant_id=v_tenant and client_id=p_client_id;
 else
   if not has_perm('POST_PURCHASES') then raise exception 'not permitted'; end if;
   select id,purchase_bill_id,request_fingerprint into v_existing_id,v_existing_source,v_existing_fingerprint
   from purchase_returns where tenant_id=v_tenant and client_id=p_client_id;
 end if;
 if v_existing_id is null then
   if exists(select 1 from sale_returns where tenant_id=v_tenant and client_id=p_client_id)
      or exists(select 1 from purchase_returns where tenant_id=v_tenant and client_id=p_client_id) then
     raise exception 'client_id already used for another return type';
   end if;
 end if;

 if v_type='SALE' then
   select * into v_sale from sale_invoices where id=p_source_id and tenant_id=v_tenant for update;
   if not found or v_sale.status<>'FINALIZED' then raise exception 'sale unavailable for return'; end if;
   perform phase3_assert_shop(v_sale.shop_id);
   v_date:=coalesce(p_business_date,shop_business_date(v_sale.shop_id));
 else
   select * into v_purchase from purchase_bills where id=p_source_id and tenant_id=v_tenant for update;
   if not found or v_purchase.status<>'POSTED' then raise exception 'purchase unavailable for return'; end if;
   perform phase3_assert_shop(v_purchase.shop_id);
   v_date:=coalesce(p_business_date,shop_business_date(v_purchase.shop_id));
 end if;
 v_fingerprint:=md5(jsonb_build_object('type',v_type,'source',p_source_id,'date',v_date,'lines',p_lines,'notes',p_notes)::text);
 if v_existing_id is not null then
   if v_existing_source<>p_source_id or v_existing_fingerprint<>v_fingerprint then
     raise exception 'client_id already used with different return payload';
   end if;
   return v_existing_id;
 end if;

 -- Serialize every return for the same source document. This protects both
 -- cumulative returned quantities and the paid-amount refund ceiling.
 perform pg_advisory_xact_lock(hashtextextended(v_tenant::text||':'||v_type||'-return:'||p_source_id::text,0));

 if v_type='SALE' then
   v_seq:=next_doc_no(v_sale.shop_id,'SALE_RETURN'); v_doc:='SR-'||lpad(v_seq::text,6,'0');
   insert into sale_returns(tenant_id,shop_id,sale_invoice_id,customer_id,doc_no,doc_seq,business_date,notes,request_fingerprint,client_id)
   values(v_tenant,v_sale.shop_id,v_sale.id,v_sale.customer_id,v_doc,v_seq,v_date,p_notes,v_fingerprint,p_client_id)
   returning id into v_sale_return;

   for v_line,v_ord in select value,ordinality from jsonb_array_elements(p_lines) with ordinality loop
     begin
       v_qty:=(v_line->>'qty')::numeric;
     exception when others then raise exception 'invalid return quantity'; end;
     v_disposition:=upper(btrim(coalesce(v_line->>'disposition','')));
     if v_qty<=0 or v_disposition not in ('RETURN_TO_SELLABLE','DAMAGED','EXPIRED','SUPPLIER_RETURN') then
       raise exception 'invalid sale return line';
     end if;
     select * into v_sale_line from sale_invoice_items
       where id=(v_line->>'sale_invoice_item_id')::uuid and tenant_id=v_tenant and sale_invoice_id=v_sale.id
       for update;
     if not found then raise exception 'sale line unavailable for return'; end if;
     v_base:=v_qty*v_sale_line.base_qty/v_sale_line.qty;
     select coalesce(sum(sri.base_qty),0),coalesce(sum(sri.amount_paise),0)
       into v_prior_base,v_prior_amount
     from sale_return_items sri join sale_returns sr on sr.tenant_id=sri.tenant_id and sr.id=sri.sale_return_id
     where sri.tenant_id=v_tenant and sri.sale_invoice_item_id=v_sale_line.id and sr.status in ('DRAFT','POSTED');
     if v_prior_base+v_base>v_sale_line.base_qty then raise exception 'sale return quantity exceeds sold quantity'; end if;
     v_cap:=phase65_sale_line_cap(v_sale_line.id);
     v_amount:=floor(v_cap::numeric*(v_prior_base+v_base)/v_sale_line.base_qty)::bigint-v_prior_amount;
     insert into sale_return_items(tenant_id,shop_id,sale_return_id,sale_invoice_item_id,item_id,line_no,
       item_name_snapshot,hsn_snapshot,tax_rate_bp_snapshot,unit_name_snapshot,unit_level,qty,base_qty,amount_paise,disposition,client_id)
     values(v_tenant,v_sale.shop_id,v_sale_return,v_sale_line.id,v_sale_line.item_id,v_ord,
       v_sale_line.item_name_snapshot,v_sale_line.hsn_snapshot,v_sale_line.tax_rate_bp_snapshot,
       v_sale_line.unit_name_snapshot,v_sale_line.unit_level,v_qty,v_base,v_amount,v_disposition,p_client_id||':line:'||v_ord::text);
     if v_disposition='RETURN_TO_SELLABLE' then
       insert into stock_movements(tenant_id,shop_id,item_id,source_type,source_id,qty_base,client_id)
       values(v_tenant,v_sale.shop_id,v_sale_line.item_id,'SALE_RETURN',v_sale_return,v_base,p_client_id||':stock:'||v_ord::text);
     end if;
     v_total:=v_total+v_amount;
   end loop;

   -- R0b (user decision 2026-10-02), rounded bills only: all returns of a bill together never exceed
   -- what was billed for its items (total - extra charges), and the return that completes the bill
   -- (every line fully returned, this one included) takes exactly what remains, i.e. it reverses the
   -- bill's round-off. A partial return carries item value, capped at what remains (a rounded-down
   -- bill's bigger item returned first cannot exceed the bill). A voided return frees its share.
   -- The adjustment is stored in round_off_paise; the bill's returns are serialized by the lock above.
   if v_sale.round_off_paise<>0 then
     select coalesce(sum(total_paise),0) into v_prior_total from sale_returns
       where tenant_id=v_tenant and sale_invoice_id=v_sale.id and status='POSTED' and id<>v_sale_return;
     v_remaining:=greatest(v_sale.total_paise-v_sale.extra_charges_paise-v_prior_total,0);
     if not exists(
     select 1 from sale_invoice_items li
     where li.tenant_id=v_tenant and li.sale_invoice_id=v_sale.id
       and li.base_qty>coalesce((select sum(sri.base_qty) from sale_return_items sri
         join sale_returns sr on sr.tenant_id=sri.tenant_id and sr.id=sri.sale_return_id
         where sri.tenant_id=v_tenant and sri.sale_invoice_item_id=li.id and sr.status in ('DRAFT','POSTED')),0))
     then
       v_round:=v_remaining-v_total;
     elsif v_total>v_remaining then
       v_round:=v_remaining-v_total;
     end if;
     v_total:=v_total+v_round;
   end if;

   select
     coalesce((select sum(pa.amount_paise) from payment_allocations pa join payments p on p.tenant_id=pa.tenant_id and p.id=pa.payment_id
       where pa.tenant_id=v_tenant and pa.sale_invoice_id=v_sale.id and pa.status='POSTED' and p.status='POSTED' and p.direction='in'),0)
     +coalesce((select sum(p.amount_paise) from payments p where p.tenant_id=v_tenant and p.source_sale_invoice_id=v_sale.id
       and p.kind='walkin' and p.status='POSTED' and p.direction='in'),0),
     coalesce((select sum(p.amount_paise) from payments p where p.tenant_id=v_tenant and p.source_sale_invoice_id=v_sale.id
       and p.status='POSTED' and p.direction='out'),0)
   into v_received,v_prior_refunds;
   v_refund:=least(v_total,greatest(v_received-v_prior_refunds,0));
   update sale_returns set status='POSTED',total_paise=v_total,round_off_paise=v_round,cash_refund_paise=v_refund,
     balance_credit_paise=v_total-v_refund,posted_at=clock_timestamp() where id=v_sale_return;
   if v_refund>0 then
     insert into payments(tenant_id,shop_id,kind,customer_id,party_id,source_sale_invoice_id,source_sale_return_id,
       business_date,amount_paise,direction,mode,reference,status,client_id)
     values(v_tenant,v_sale.shop_id,case when v_sale.customer_id is null then 'walkin' else 'customer' end,
       v_sale.customer_id,null,v_sale.id,v_sale_return,v_date,v_refund,'out','cash','Refund '||v_doc,'POSTED',p_client_id||':refund');
   end if;
   return v_sale_return;
 end if;

 v_seq:=next_doc_no(v_purchase.shop_id,'PURCHASE_RETURN'); v_doc:='PR-'||lpad(v_seq::text,6,'0');
 insert into purchase_returns(tenant_id,shop_id,purchase_bill_id,party_id,doc_no,doc_seq,business_date,notes,request_fingerprint,client_id)
 values(v_tenant,v_purchase.shop_id,v_purchase.id,v_purchase.party_id,v_doc,v_seq,v_date,p_notes,v_fingerprint,p_client_id)
 returning id into v_purchase_return;

 for v_line,v_ord in select value,ordinality from jsonb_array_elements(p_lines) with ordinality loop
   begin
     v_qty:=(v_line->>'qty')::numeric;
   exception when others then raise exception 'invalid return quantity'; end;
   v_disposition:=upper(btrim(coalesce(v_line->>'disposition','')));
   if v_qty<=0 or v_disposition not in ('RETURN_TO_SELLABLE','DAMAGED','EXPIRED','SUPPLIER_RETURN') then
     raise exception 'invalid purchase return line';
   end if;
   select * into v_purchase_line from purchase_bill_items
     where id=(v_line->>'purchase_bill_item_id')::uuid and tenant_id=v_tenant and purchase_bill_id=v_purchase.id
     for update;
   if not found then raise exception 'purchase line unavailable for return'; end if;
   v_base:=v_qty*v_purchase_line.base_qty/v_purchase_line.qty;
   select coalesce(sum(pri.base_qty),0),coalesce(sum(pri.amount_paise),0)
     into v_prior_base,v_prior_amount
   from purchase_return_items pri join purchase_returns pr on pr.tenant_id=pri.tenant_id and pr.id=pri.purchase_return_id
   where pri.tenant_id=v_tenant and pri.purchase_bill_item_id=v_purchase_line.id and pr.status in ('DRAFT','POSTED');
   if v_prior_base+v_base>v_purchase_line.base_qty then raise exception 'purchase return quantity exceeds purchased quantity'; end if;
   v_cap:=phase65_purchase_line_cap(v_purchase_line.id);
   v_amount:=floor(v_cap::numeric*(v_prior_base+v_base)/v_purchase_line.base_qty)::bigint-v_prior_amount;
   insert into purchase_return_items(tenant_id,shop_id,purchase_return_id,purchase_bill_item_id,item_id,line_no,
     item_name_snapshot,hsn_snapshot,tax_rate_bp_snapshot,unit_name_snapshot,unit_level,qty,base_qty,amount_paise,disposition,client_id)
   values(v_tenant,v_purchase.shop_id,v_purchase_return,v_purchase_line.id,v_purchase_line.item_id,v_ord,
     v_purchase_line.item_name_snapshot,v_purchase_line.hsn_snapshot,v_purchase_line.tax_rate_bp_snapshot,
     v_purchase_line.unit_name_snapshot,v_purchase_line.unit_level,v_qty,v_base,v_amount,v_disposition,p_client_id||':line:'||v_ord::text);
   if v_disposition<>'RETURN_TO_SELLABLE' then
     insert into stock_current(tenant_id,shop_id,item_id,on_hand,reserved)
       values(v_tenant,v_purchase.shop_id,v_purchase_line.item_id,0,0) on conflict do nothing;
     perform 1 from stock_current where tenant_id=v_tenant and shop_id=v_purchase.shop_id and item_id=v_purchase_line.item_id for update;
     if not exists(select 1 from stock_current where tenant_id=v_tenant and shop_id=v_purchase.shop_id
       and item_id=v_purchase_line.item_id and available>=v_base) then raise exception 'insufficient stock for purchase return'; end if;
     insert into stock_movements(tenant_id,shop_id,item_id,source_type,source_id,qty_base,client_id)
       values(v_tenant,v_purchase.shop_id,v_purchase_line.item_id,'PURCHASE_RETURN',v_purchase_return,-v_base,p_client_id||':stock:'||v_ord::text);
   end if;
   v_total:=v_total+v_amount;
 end loop;
 update purchase_returns set status='POSTED',total_paise=v_total,posted_at=clock_timestamp() where id=v_purchase_return;
 return v_purchase_return;
end
$function$;

-- check_invariants (from 0051), unchanged except: a return total = its lines + its round-off.
CREATE OR REPLACE FUNCTION public.check_invariants()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_tenant uuid:=phase6_assert_report_access();
 bad_sales bigint; bad_purchases bigint; bad_stock bigint; bad_alloc bigint; bad_projection bigint; bad_voids bigint;
 bad_sale_returns bigint; bad_purchase_returns bigint; bad_return_qty bigint; bad_refunds bigint; bad_payment_direction bigint;
begin
 select count(*) into bad_sales from sale_invoices s where s.tenant_id=v_tenant and s.status='FINALIZED' and
  (s.subtotal_paise<>(select coalesce(sum(li.line_total_paise+li.discount_paise),0) from sale_invoice_items li where li.sale_invoice_id=s.id)
   or s.total_paise<>s.subtotal_paise-s.discount_paise+s.extra_charges_paise+s.round_off_paise);
 select count(*) into bad_purchases from purchase_bills b where b.tenant_id=v_tenant and b.status='POSTED' and
  (b.subtotal_paise<>(select coalesce(sum(li.line_total_paise),0) from purchase_bill_items li where li.purchase_bill_id=b.id)
   or b.total_paise<>b.subtotal_paise-b.discount_paise+b.extra_charges_paise);
 select count(*) into bad_stock from stock_current sc where sc.tenant_id=v_tenant and sc.qty_base<0
  and not coalesce((select allow_negative_stock from shops where id=sc.shop_id),false);
 select count(*) into bad_alloc from payments p where p.tenant_id=v_tenant and
  (select coalesce(sum(amount_paise),0) from payment_allocations a where a.payment_id=p.id and a.status='POSTED')>p.amount_paise;
 select count(*) into bad_payment_direction from payment_allocations a join payments p on p.tenant_id=a.tenant_id and p.id=a.payment_id
  where a.tenant_id=v_tenant and a.status='POSTED' and (p.status<>'POSTED'
   or (a.sale_invoice_id is not null and p.direction<>'in')
   or (a.purchase_bill_id is not null and (p.direction<>'out' or p.party_id is null)));
 select count(*) into bad_projection from (
  select coalesce(sc.shop_id,m.shop_id) shop_id,coalesce(sc.item_id,m.item_id) item_id,coalesce(sc.qty_base,0) projected,coalesce(m.moved,0) moved
  from stock_current sc full join (select tenant_id,shop_id,item_id,sum(qty_base) moved from stock_movements where tenant_id=v_tenant group by tenant_id,shop_id,item_id) m
   on m.tenant_id=sc.tenant_id and m.shop_id=sc.shop_id and m.item_id=sc.item_id where coalesce(sc.tenant_id,m.tenant_id)=v_tenant
 ) q where q.projected<>q.moved;
 select count(*) into bad_voids from (
  select s.id,m.item_id,sum(m.qty_base) net from sale_invoices s join stock_movements m on m.tenant_id=s.tenant_id and m.source_id=s.id
   where s.tenant_id=v_tenant and s.status='VOID' and m.source_type in ('SALE','SALE_VOID') group by s.id,m.item_id having sum(m.qty_base)<>0
  union all
  select p.id,m.item_id,sum(m.qty_base) net from purchase_bills p join stock_movements m on m.tenant_id=p.tenant_id and m.source_id=p.id
   where p.tenant_id=v_tenant and p.status='VOID' and m.source_type in ('PURCHASE','PURCHASE_VOID') group by p.id,m.item_id having sum(m.qty_base)<>0
  union all
  select r.id,m.item_id,sum(m.qty_base) net from sale_returns r join stock_movements m on m.tenant_id=r.tenant_id and m.source_id=r.id
   where r.tenant_id=v_tenant and r.status='VOID' and m.source_type in ('SALE_RETURN','SALE_RETURN_VOID') group by r.id,m.item_id having sum(m.qty_base)<>0
  union all
  select r.id,m.item_id,sum(m.qty_base) net from purchase_returns r join stock_movements m on m.tenant_id=r.tenant_id and m.source_id=r.id
   where r.tenant_id=v_tenant and r.status='VOID' and m.source_type in ('PURCHASE_RETURN','PURCHASE_RETURN_VOID') group by r.id,m.item_id having sum(m.qty_base)<>0
 ) violations;
 select count(*) into bad_sale_returns from sale_returns r where r.tenant_id=v_tenant and r.status in ('POSTED','VOID') and
  (r.total_paise<>(select coalesce(sum(i.amount_paise),0) from sale_return_items i where i.sale_return_id=r.id)+r.round_off_paise
   or r.total_paise<>r.cash_refund_paise+r.balance_credit_paise);
 select count(*) into bad_purchase_returns from purchase_returns r where r.tenant_id=v_tenant and r.status in ('POSTED','VOID') and
  r.total_paise<>(select coalesce(sum(i.amount_paise),0) from purchase_return_items i where i.purchase_return_id=r.id);
 select count(*) into bad_return_qty from (
  select li.id from sale_invoice_items li left join sale_return_items ri on ri.tenant_id=li.tenant_id and ri.sale_invoice_item_id=li.id
   left join sale_returns r on r.tenant_id=ri.tenant_id and r.id=ri.sale_return_id and r.status='POSTED'
   where li.tenant_id=v_tenant group by li.id,li.base_qty having coalesce(sum(ri.base_qty) filter(where r.id is not null),0)>li.base_qty
  union all
  select li.id from purchase_bill_items li left join purchase_return_items ri on ri.tenant_id=li.tenant_id and ri.purchase_bill_item_id=li.id
   left join purchase_returns r on r.tenant_id=ri.tenant_id and r.id=ri.purchase_return_id and r.status='POSTED'
   where li.tenant_id=v_tenant group by li.id,li.base_qty having coalesce(sum(ri.base_qty) filter(where r.id is not null),0)>li.base_qty
 ) excess;
 select count(*) into bad_refunds from sale_returns r where r.tenant_id=v_tenant and (
  (r.status='POSTED' and ((r.cash_refund_paise=0 and exists(select 1 from payments p where p.source_sale_return_id=r.id and p.status='POSTED'))
    or (r.cash_refund_paise>0 and (select count(*) from payments p where p.source_sale_return_id=r.id and p.status='POSTED' and p.direction='out' and p.amount_paise=r.cash_refund_paise)<>1)))
  or (r.status='VOID' and exists(select 1 from payments p where p.source_sale_return_id=r.id and p.status<>'VOID'))
 );
 return jsonb_build_object('ok',bad_sales=0 and bad_purchases=0 and bad_stock=0 and bad_alloc=0 and bad_projection=0 and bad_voids=0
   and bad_sale_returns=0 and bad_purchase_returns=0 and bad_return_qty=0 and bad_refunds=0 and bad_payment_direction=0,
  'saleTotalViolations',bad_sales,'purchaseTotalViolations',bad_purchases,'negativeStock',bad_stock,
  'allocationViolations',bad_alloc,'stockProjectionViolations',bad_projection,'voidReversalViolations',bad_voids,
  'saleReturnViolations',bad_sale_returns,'purchaseReturnViolations',bad_purchase_returns,
  'returnQuantityViolations',bad_return_qty,'refundViolations',bad_refunds,'paymentDirectionViolations',bad_payment_direction);
end
$function$;
