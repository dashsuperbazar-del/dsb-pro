-- Packet R0 (group r0): bill round-off (user decision B1, 2026-10-01).
-- Item values stay in exact paise; the BILL total of a new sale is rounded to the nearest rupee,
-- half up (₹10.49 -> ₹10, ₹10.50 -> ₹11), and the difference is stored in round_off_paise.
-- Opt-in per request: only r0_sync_post_sale rounds. Sales already queued by older clients keep
-- their exact total (rounding them would reject fully paid walk-in sales). Returns refund item
-- values only (subtotal minus header discount), so the round-off stays with the bill exactly like
-- extra charges. Existing invoices are never re-rounded (column defaults to 0).

alter table sale_invoices add column round_off_paise bigint not null default 0
  check (round_off_paise between -49 and 50);

-- Nearest rupee, half up, for a non-negative paise amount: the signed adjustment to add.
create function r0_round_off(p_total bigint) returns bigint
language sql immutable set search_path=public as $$
  -- A negative total is impossible (discount <= subtotal); null makes any such insert fail loudly.
  select case when p_total < 0 then null when p_total % 100 >= 50 then 100 - p_total % 100 else -(p_total % 100) end
$$;
revoke all on function r0_round_off(bigint) from public,anon;
grant execute on function r0_round_off(bigint) to authenticated;

create function r0_round_off_immutable() returns trigger language plpgsql set search_path=public as $$
begin
  if new.round_off_paise is distinct from old.round_off_paise then raise exception 'round-off is immutable'; end if;
  return new;
end $$;
create trigger r0_round_off_immutable before update on sale_invoices for each row execute function r0_round_off_immutable();

create or replace function phase4_post_sale_unlocked(
 p_shop_id uuid,p_customer_id uuid,p_business_date date,p_discount_paise bigint,p_extra_charges_paise bigint,
 p_client_id text,p_lines jsonb,p_payments jsonb default '[]'::jsonb,p_notes text default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare
 v_tenant uuid; v_existing uuid; v_sale uuid; v_seq bigint; v_prefix text; v_doc text;
 v_line jsonb; v_pay jsonb; v_ord bigint; v_item items%rowtype;
 v_level int; v_qty numeric; v_base numeric; v_kind text; v_price bigint; v_gross bigint; v_line_discount bigint; v_line_total bigint;
 v_subtotal bigint:=0; v_line_discounts bigint:=0; v_total_discount bigint; v_total bigint; v_round_off bigint:=0; v_payment_total bigint:=0;
 v_item_ids uuid[]:='{}'; v_required numeric[]:='{}'; v_pos int; v_i int; v_payment_id uuid; v_amount bigint; v_mode text;
 v_allow_negative boolean;
begin
 if not has_perm('POST_SALES') then raise exception 'not permitted'; end if;
 v_tenant:=phase3_assert_shop(p_shop_id);
 if p_client_id is null or btrim(p_client_id)='' then raise exception 'client_id required'; end if;
 select id into v_existing from sale_invoices where tenant_id=v_tenant and client_id=p_client_id;
 if v_existing is not null then return v_existing; end if;
 if p_customer_id is not null and not exists(select 1 from customers where id=p_customer_id and tenant_id=v_tenant and deleted_at is null) then raise exception 'customer not in tenant'; end if;
 if coalesce(p_discount_paise,0)<0 or coalesce(p_extra_charges_paise,0)<0 then raise exception 'negative adjustment'; end if;
 if p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then raise exception 'sale requires lines'; end if;
 if p_payments is null or jsonb_typeof(p_payments)<>'array' then raise exception 'payments must be an array'; end if;

 for v_line,v_ord in select value,ordinality from jsonb_array_elements(p_lines) with ordinality loop
   select * into v_item from items where id=(v_line->>'item_id')::uuid and tenant_id=v_tenant and deleted_at is null and is_active for share;
   if not found then raise exception 'item not in tenant'; end if;
   v_level:=coalesce((v_line->>'unit_level')::int,1); v_qty:=(v_line->>'qty')::numeric;
   v_kind:=coalesce(nullif(v_line->>'price_kind',''),'retail');
   if v_qty<=0 or v_level not between 1 and 3 or v_kind not in ('retail','wholesale') then raise exception 'invalid sale line'; end if;
   if v_level=1 then v_base:=v_qty*coalesce(v_item.conv1,1)*coalesce(v_item.conv2,1);
   elsif v_level=2 and v_item.unit2 is not null then v_base:=v_qty*coalesce(v_item.conv2,1);
   elsif v_level=3 and v_item.unit3 is not null then v_base:=v_qty;
   else raise exception 'unit tier unavailable'; end if;
   v_price:=phase4_current_price(v_tenant,p_shop_id,v_item.id,v_kind,v_level);
   v_gross:=round(v_qty*v_price)::bigint;
   v_line_discount:=coalesce((v_line->>'discount_paise')::bigint,0);
   if v_line_discount<0 or v_line_discount>v_gross then raise exception 'invalid line discount'; end if;
   v_subtotal:=v_subtotal+v_gross; v_line_discounts:=v_line_discounts+v_line_discount;
   v_pos:=array_position(v_item_ids,v_item.id);
   if v_pos is null then v_item_ids:=array_append(v_item_ids,v_item.id); v_required:=array_append(v_required,v_base);
   else v_required[v_pos]:=v_required[v_pos]+v_base; end if;
 end loop;
 v_total_discount:=v_line_discounts+coalesce(p_discount_paise,0);
 if v_total_discount>v_subtotal then raise exception 'discount exceeds subtotal'; end if;
 v_total:=v_subtotal-v_total_discount+coalesce(p_extra_charges_paise,0);
 -- R0 (user decision B1): only callers that opted in (r0_sync_post_sale sets dsb.round_bill for this
 -- transaction) round the BILL total to the nearest rupee, half up. Line values stay exact paise.
 if coalesce(current_setting('dsb.round_bill',true),'')='on' then
   v_round_off:=r0_round_off(v_total);
   v_total:=v_total+v_round_off;
 end if;

 for v_pay in select value from jsonb_array_elements(p_payments) loop
   v_amount:=(v_pay->>'amount_paise')::bigint; v_mode:=v_pay->>'mode';
   if v_amount<=0 or v_mode not in ('cash','upi','card','bank','other') then raise exception 'invalid payment'; end if;
   v_payment_total:=v_payment_total+v_amount;
 end loop;
 if v_payment_total>v_total then raise exception 'payments exceed sale total'; end if;
 if p_customer_id is null and v_payment_total<>v_total then raise exception 'walk-in sale must be fully paid'; end if;

 -- Ensure every projection row exists, then lock all items in deterministic order.
 for v_i in 1..coalesce(array_length(v_item_ids,1),0) loop
   insert into stock_current(tenant_id,shop_id,item_id,on_hand,reserved)
   values(v_tenant,p_shop_id,v_item_ids[v_i],0,0) on conflict do nothing;
 end loop;
 perform 1 from stock_current where tenant_id=v_tenant and shop_id=p_shop_id and item_id=any(v_item_ids) order by item_id for update;
 select allow_negative_stock into v_allow_negative from shops where id=p_shop_id and tenant_id=v_tenant;
 if not coalesce(v_allow_negative,false) then
   for v_i in 1..coalesce(array_length(v_item_ids,1),0) loop
     if not exists(select 1 from stock_current where tenant_id=v_tenant and shop_id=p_shop_id and item_id=v_item_ids[v_i] and available>=v_required[v_i]) then
       raise exception 'insufficient stock';
     end if;
   end loop;
 end if;

 v_seq:=next_doc_no(p_shop_id,'SALE');
 select coalesce(nullif(invoice_prefix,''),'INV') into v_prefix from shops where id=p_shop_id and tenant_id=v_tenant;
 v_doc:=v_prefix||'-'||lpad(v_seq::text,6,'0');
 insert into sale_invoices(tenant_id,shop_id,customer_id,doc_no,doc_seq,business_date,status,subtotal_paise,discount_paise,extra_charges_paise,round_off_paise,total_paise,notes,finalized_at,client_id)
 values(v_tenant,p_shop_id,p_customer_id,v_doc,v_seq,coalesce(p_business_date,shop_business_date(p_shop_id)),'FINALIZED',v_subtotal,v_total_discount,coalesce(p_extra_charges_paise,0),v_round_off,v_total,p_notes,now(),p_client_id)
 returning id into v_sale;

 for v_line,v_ord in select value,ordinality from jsonb_array_elements(p_lines) with ordinality loop
   select * into v_item from items where id=(v_line->>'item_id')::uuid and tenant_id=v_tenant;
   v_level:=coalesce((v_line->>'unit_level')::int,1); v_qty:=(v_line->>'qty')::numeric; v_kind:=coalesce(nullif(v_line->>'price_kind',''),'retail');
   if v_level=1 then v_base:=v_qty*coalesce(v_item.conv1,1)*coalesce(v_item.conv2,1);
   elsif v_level=2 then v_base:=v_qty*coalesce(v_item.conv2,1); else v_base:=v_qty; end if;
   v_price:=phase4_current_price(v_tenant,p_shop_id,v_item.id,v_kind,v_level); v_gross:=round(v_qty*v_price)::bigint;
   v_line_discount:=coalesce((v_line->>'discount_paise')::bigint,0); v_line_total:=v_gross-v_line_discount;
   insert into sale_invoice_items(tenant_id,shop_id,sale_invoice_id,item_id,line_no,item_name_snapshot,hsn_snapshot,tax_rate_bp_snapshot,unit_name_snapshot,conv1_snapshot,conv2_snapshot,unit_level,entry_mode,is_big_unit,qty,base_qty,price_kind,unit_price_paise,discount_paise,line_total_paise,client_id)
   values(v_tenant,p_shop_id,v_sale,v_item.id,v_ord,v_item.name,v_item.hsn,v_item.tax_rate_bp,
      case v_level when 1 then v_item.unit1 when 2 then v_item.unit2 else v_item.unit3 end,v_item.conv1,v_item.conv2,v_level,
      case v_level when 1 then 'big' when 2 then 'small' else 'piece' end,v_level=1,v_qty,v_base,v_kind,v_price,v_line_discount,v_line_total,p_client_id||':line:'||v_ord::text);
   insert into stock_movements(tenant_id,shop_id,item_id,source_type,source_id,qty_base,client_id)
   values(v_tenant,p_shop_id,v_item.id,'SALE',v_sale,-v_base,p_client_id||':stock:'||v_ord::text);
 end loop;

 for v_pay,v_ord in select value,ordinality from jsonb_array_elements(p_payments) with ordinality loop
   v_amount:=(v_pay->>'amount_paise')::bigint; v_mode:=v_pay->>'mode';
   if p_customer_id is null then
     -- Use no customer ledger row for walk-in tenders; the payment still belongs to the sale.
     insert into payments(tenant_id,shop_id,kind,customer_id,party_id,source_sale_invoice_id,business_date,amount_paise,mode,reference,status,client_id)
     values(v_tenant,p_shop_id,'customer',null,null,v_sale,coalesce(p_business_date,shop_business_date(p_shop_id)),v_amount,v_mode,v_pay->>'reference','POSTED',p_client_id||':pay:'||v_ord::text)
     returning id into v_payment_id;
   else
     insert into payments(tenant_id,shop_id,kind,customer_id,source_sale_invoice_id,business_date,amount_paise,mode,reference,status,client_id)
     values(v_tenant,p_shop_id,'customer',p_customer_id,v_sale,coalesce(p_business_date,shop_business_date(p_shop_id)),v_amount,v_mode,v_pay->>'reference','POSTED',p_client_id||':pay:'||v_ord::text)
     returning id into v_payment_id;
     insert into payment_allocations(tenant_id,payment_id,doc_type,sale_invoice_id,amount_paise,client_id)
     values(v_tenant,v_payment_id,'SALE',v_sale,v_amount,p_client_id||':alloc:'||v_ord::text);
   end if;
 end loop;
 return v_sale;
exception when unique_violation then
 select id into v_existing from sale_invoices where tenant_id=v_tenant and client_id=p_client_id;
 if v_existing is not null then return v_existing; end if;
 raise;
end $$;

-- Opt-in entry point for clients that compute the rounded total. Same parameters and result as
-- phase5_sync_post_sale; the rounding switch is local to this transaction.
create function r0_sync_post_sale(
  p_device_id text,p_schema_version integer,p_shop_id uuid,p_customer_id uuid,p_business_date date,
  p_discount_paise bigint,p_extra_charges_paise bigint,p_client_id text,p_lines jsonb,p_payments jsonb,p_notes text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_result jsonb;
begin
  -- Scoped to this one sale: switched off again before returning, so a later call in the same
  -- transaction (old path) is never rounded. On error the whole transaction rolls back anyway.
  perform set_config('dsb.round_bill','on',true);
  v_result:=phase5_sync_post_sale(p_device_id,p_schema_version,p_shop_id,p_customer_id,p_business_date,
    p_discount_paise,p_extra_charges_paise,p_client_id,p_lines,p_payments,p_notes);
  perform set_config('dsb.round_bill','off',true);
  -- The acknowledgement carries the server's round-off so the device stores the authoritative value.
  return v_result||jsonb_build_object('roundOffPaise',
    (select round_off_paise from sale_invoices where id=(v_result->>'saleId')::uuid));
end $$;
revoke all on function r0_sync_post_sale(text,integer,uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text) from public,anon;
grant execute on function r0_sync_post_sale(text,integer,uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text) to authenticated;

-- check_invariants: sale totals include the round-off. Everything else verbatim from 0047.
create or replace function check_invariants()
returns jsonb language plpgsql stable security definer set search_path=public as $invariants$
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
  (r.total_paise<>(select coalesce(sum(i.amount_paise),0) from sale_return_items i where i.sale_return_id=r.id)
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
$invariants$;
