-- orderadjust: staff may REDUCE or REMOVE lines of an open order before hand-over (an item ran out, the customer
-- changed their mind), with a recorded reason (e.g. "customer agreed on phone"). Safety rules:
--  * only NEW/CONFIRMED/PREPARING/READY orders; quantities can only go DOWN (never up: nothing new is held), at least
--    one line must remain (otherwise cancel the order);
--  * each line keeps the unit price the customer accepted; line totals and the subtotal are recomputed from it;
--  * the delivery fee is never raised (it stays as accepted, or drops to 0 if it was already 0);
--  * the stock hold of each line shrinks by exactly the removed base quantity (reserved == sum of active holds);
--    a removed line's hold is released with reason ADJUSTED;
--  * order_items stay immutable to everything else: only this function may change qty/base_qty/line_total
--    (transaction-local flag checked by the guard trigger). Every change is an append-only order event.
-- fulfil_order is unchanged: it compares the sale with the NEW total, so a price change still needs a re-order.
-- Forward-only.

-- A removed line keeps its row (history) with quantity 0; hand-over and the customer's status skip it.
alter table order_items drop constraint order_items_qty_check;
alter table order_items add constraint order_items_qty_check check (qty>=0);
alter table order_items drop constraint order_items_base_qty_check;
alter table order_items add constraint order_items_base_qty_check check (base_qty>=0);

alter table stock_reservations drop constraint stock_reservations_release_reason_check;
alter table stock_reservations add constraint stock_reservations_release_reason_check
  check (release_reason in ('CANCELLED','EXPIRED','FULFILLED','ADJUSTED'));

create or replace function order_items_guard() returns trigger language plpgsql as $$
begin
 if tg_op='UPDATE' and current_setting('dsb.order_adjust',true)='on'
    and new.id=old.id and new.order_id=old.order_id and new.item_id=old.item_id and new.line_no=old.line_no
    and new.unit_level=old.unit_level and new.unit_price_paise=old.unit_price_paise and new.qty<=old.qty then
   return new;
 end if;
 raise exception 'order lines change only through adjust_order';
end $$;
drop trigger order_items_immutable on order_items;
create trigger order_items_immutable before update or delete on order_items
 for each row execute function order_items_guard();

create function adjust_order(p_order_id uuid,p_revision integer,p_changes jsonb,p_reason text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o orders; c jsonb; li order_items; v_qty numeric; v_new_base numeric; v_drop numeric; r stock_reservations;
 v_reason text:=nullif(btrim(coalesce(p_reason,'')),''); v_sub bigint; v_left int; v_done int:=0;
begin
 if not has_perm('MANAGE_ORDERS') then raise exception 'not permitted'; end if;
 select * into o from orders where id=p_order_id and tenant_id=current_tenant_id() for update;
 if not found or not c1_shop_visible(o.shop_id) then raise exception 'DSB_ORDER_NOT_FOUND: order not found'; end if;
 if o.status not in ('NEW','CONFIRMED','PREPARING','READY') then
   raise exception 'DSB_ORDER_STEP: only an open order (before out for delivery) can be changed';
 end if;
 if o.revision<>p_revision then raise exception 'DSB_ORDER_CHANGED: this order was changed on another device; refresh'; end if;
 if v_reason is null or char_length(v_reason)>200 then raise exception 'DSB_ORDER_INVALID: give a reason (up to 200 characters)'; end if;
 if p_changes is null or jsonb_typeof(p_changes)<>'array' or jsonb_array_length(p_changes) not between 1 and 50 then
   raise exception 'DSB_ORDER_INVALID: nothing to change';
 end if;
 perform set_config('dsb.order_adjust','on',true);
 for c in select value from jsonb_array_elements(p_changes) loop
   begin v_qty:=(c->>'qty')::numeric; exception when others then raise exception 'DSB_ORDER_INVALID: check the quantity'; end;
   select * into li from order_items where order_id=o.id and line_no=(c->>'lineNo')::int for update;
   if not found then raise exception 'DSB_ORDER_INVALID: line not found'; end if;
   if v_qty is null or v_qty<0 or v_qty>li.qty or scale(v_qty)>3 then
     raise exception 'DSB_ORDER_INVALID: a line can only be reduced (line %)', li.line_no;
   end if;
   if v_qty=li.qty then continue; end if;
   v_new_base:=li.base_qty*v_qty/li.qty; v_drop:=li.base_qty-v_new_base;
   select * into r from stock_reservations where order_item_id=li.id and released_at is null for update;
   if found then
     perform 1 from stock_current where tenant_id=r.tenant_id and shop_id=r.shop_id and item_id=r.item_id for update;
     update stock_current set reserved=reserved-v_drop,updated_at=(extract(epoch from clock_timestamp())*1000)::bigint
      where tenant_id=r.tenant_id and shop_id=r.shop_id and item_id=r.item_id;
     if v_qty=0 then
       update stock_reservations set released_at=clock_timestamp(),release_reason='ADJUSTED' where id=r.id;
     else
       update stock_reservations set qty_base=r.qty_base-v_drop where id=r.id;
     end if;
   end if;
   update order_items set qty=v_qty,base_qty=v_new_base,
     line_total_paise=case when v_qty=0 then 0 else round(v_qty*li.unit_price_paise)::bigint end where id=li.id;
   insert into order_events(tenant_id,order_id,from_status,to_status,reason,actor,client_id)
   values(o.tenant_id,o.id,o.status,o.status,
     left(format('Line %s %s: %s → %s (%s)',li.line_no,li.item_name,li.qty::text,v_qty::text,v_reason),200),
     auth.uid(),'adjust:'||o.id::text||':'||(o.revision+1)::text||':'||li.line_no::text);
   v_done:=v_done+1;
 end loop;
 if v_done=0 then raise exception 'DSB_ORDER_INVALID: nothing changed'; end if;
 select coalesce(sum(line_total_paise),0),count(*) filter (where line_total_paise>0) into v_sub,v_left from order_items where order_id=o.id;
 if v_left=0 then raise exception 'DSB_ORDER_INVALID: every line would be removed; cancel the order instead'; end if;
 update orders set subtotal_paise=v_sub,total_paise=v_sub+delivery_fee_paise,revision=revision+1 where id=o.id;
 return jsonb_build_object('status',o.status,'revision',o.revision+1,'totalPaise',(v_sub+o.delivery_fee_paise)::text);
end $$;
revoke all on function adjust_order(uuid,integer,jsonb,text) from public,anon;
grant execute on function adjust_order(uuid,integer,jsonb,text) to authenticated;

-- Hand-over and customer views skip removed (qty 0) lines.
create or replace function fulfil_order(p_order_id uuid,p_revision integer,p_payments jsonb,p_customer_id uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o orders; v_lines jsonb; v_sale uuid; v_total bigint; v_client text; v_date date; v_shop uuid;
begin
 if not has_perm('MANAGE_ORDERS') or not has_perm('POST_SALES') then raise exception 'not permitted'; end if;
 -- Same lock order as a POS sale: shop finance lock FIRST, then the order row, then stock rows. (Taking the
 -- order/stock rows first and the finance lock inside post_sale would deadlock with a concurrent counter sale.)
 select shop_id into v_shop from orders where id=p_order_id and tenant_id=current_tenant_id();
 if v_shop is null or not c1_shop_visible(v_shop) then raise exception 'DSB_ORDER_NOT_FOUND: order not found'; end if;
 perform dsb_lock_shop_finance(phase3_assert_shop(v_shop),v_shop);
 select * into o from orders where id=p_order_id and tenant_id=current_tenant_id() for update;
 if not found or o.shop_id<>v_shop then raise exception 'DSB_ORDER_NOT_FOUND: order not found'; end if;
 v_client:='order-sale:'||o.id::text;
 -- Exact replay after success: same sale, nothing new.
 if o.status='DELIVERED' and o.sale_invoice_id is not null then
   return jsonb_build_object('saleId',o.sale_invoice_id,'status','DELIVERED','replayed',true);
 end if;
 if o.status in ('NEW','CONFIRMED','PREPARING','READY') and o.reservation_expires_at<=clock_timestamp() then
   perform order_expire_one(o.id);
   return jsonb_build_object('status','CANCELLED','expired',true,'revision',(select revision from orders where id=o.id));
 end if;
 if o.status not in ('READY','OUT_FOR_DELIVERY') then raise exception 'DSB_ORDER_STEP: only a READY or out-for-delivery order can be handed over (this one is %)', o.status; end if;
 if o.revision<>p_revision then raise exception 'DSB_ORDER_CHANGED: this order was changed on another device; refresh'; end if;
 if p_payments is null or jsonb_typeof(p_payments)<>'array' then raise exception 'DSB_ORDER_INVALID: enter the payment'; end if;

 select jsonb_agg(jsonb_build_object('item_id',item_id,'unit_level',unit_level,'qty',qty::text,'price_kind','retail') order by line_no)
   into v_lines from order_items where order_id=o.id and qty>0;
 -- Release first so the sale's own stock check sees this order's units as free (all in one transaction).
 perform order_release_holds(o.id,'FULFILLED');
 v_date:=shop_business_date(o.shop_id);
 v_sale:=post_sale(o.shop_id,p_customer_id,v_date,0,o.delivery_fee_paise,v_client,v_lines,p_payments,
   'Online order '||o.public_ref);
 select total_paise into v_total from sale_invoices where id=v_sale;
 if v_total is distinct from o.total_paise then
   raise exception 'DSB_ORDER_REQUOTE_REQUIRED: the bill today is % paise but the customer ordered for % paise; cancel this order and ask the customer to order again',
     v_total, o.total_paise;
 end if;
 update orders set status='DELIVERED',sale_invoice_id=v_sale,revision=revision+1 where id=o.id;
 insert into order_events(tenant_id,order_id,from_status,to_status,reason,actor,client_id)
 values(o.tenant_id,o.id,o.status,'DELIVERED','Sale '||v_sale::text,auth.uid(),'delivered:'||o.id::text);
 return jsonb_build_object('saleId',v_sale,'status','DELIVERED','revision',o.revision+1,'replayed',false);
end $$;

create or replace function public_order_status(p_ref text,p_token text) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare o orders;
begin
 if p_ref is null or p_token is null or char_length(p_ref)<>10 or char_length(p_token) not between 32 and 128 then return null; end if;
 select * into o from orders where public_ref=upper(p_ref);
 if not found or o.token_digest<>encode(sha256(convert_to(p_token,'UTF8')),'hex') then return null; end if;
 return jsonb_build_object('ref',o.public_ref,'status',o.status,'fulfilment',o.fulfilment,'deliverySlot',o.delivery_slot,
   'subtotalPaise',o.subtotal_paise::text,'deliveryFeePaise',o.delivery_fee_paise::text,'totalPaise',o.total_paise::text,
   'placedAt',o.created_at,'expiresAt',o.reservation_expires_at,'cancelReason',o.cancel_reason,
   'items',(select coalesce(jsonb_agg(jsonb_build_object('name',item_name,'unit',unit_name,'qty',qty::text,
       'unitPricePaise',unit_price_paise::text,'lineTotalPaise',line_total_paise::text) order by line_no),'[]'::jsonb)
     from order_items where order_id=o.id and qty>0));
end $$;

create or replace function find_order(p_slug text,p_phone text,p_ref text) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare s storefront_settings; o orders; v_digits text:=right(regexp_replace(coalesce(p_phone,''),'[^0-9]','','g'),10);
begin
 if p_slug is null or char_length(p_slug)>40 or p_ref is null or char_length(p_ref)<>10 or char_length(v_digits)<>10 then return null; end if;
 s:=storefront_public_shop(p_slug);
 if s.id is null then return null; end if;
 select * into o from orders where public_ref=upper(p_ref) and shop_id=s.shop_id;
 if not found or right(regexp_replace(o.contact_phone,'[^0-9]','','g'),10)<>v_digits then return null; end if;
 return jsonb_build_object('ref',o.public_ref,'status',o.status,'fulfilment',o.fulfilment,'deliverySlot',o.delivery_slot,
   'subtotalPaise',o.subtotal_paise::text,'deliveryFeePaise',o.delivery_fee_paise::text,'totalPaise',o.total_paise::text,
   'placedAt',o.created_at,'expiresAt',o.reservation_expires_at,'cancelReason',o.cancel_reason,
   'items',(select coalesce(jsonb_agg(jsonb_build_object('name',item_name,'unit',unit_name,'qty',qty::text,
       'unitPricePaise',unit_price_paise::text,'lineTotalPaise',line_total_paise::text) order by line_no),'[]'::jsonb)
     from order_items where order_id=o.id and qty>0));
end $$;
