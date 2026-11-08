-- orderfulfil (SF3): turn a READY online order into a normal sale. The existing post_sale stays the ONLY writer of
-- sales, payments and stock movements; this function only orchestrates it inside one transaction:
--   lock the order -> check READY, not expired, revision -> release its holds (FULFILLED) -> post_sale with the
--   order's items/units/quantities at RETAIL, the delivery fee as an extra charge, the staff-entered payments and
--   a deterministic client id -> compare the resulting sale total with the order total -> link the sale, mark
--   DELIVERED and record the event.
-- Any difference between the sale and what the customer accepted (a price changed, GST added on top, a unit
-- removed) raises DSB_ORDER_REQUOTE_REQUIRED and rolls EVERYTHING back (holds, sale, payments, numbering). Staff
-- then cancel the order and ask the customer to order again at today's price; a price difference is never hidden
-- as a discount. Requires MANAGE_ORDERS and POST_SALES. Exact replay returns the same sale (post_sale is
-- idempotent on the client id). Takes the shop finance lock first (same order as POS: no deadlock). No new table.
-- Forward-only.

create function fulfil_order(p_order_id uuid,p_revision integer,p_payments jsonb,p_customer_id uuid default null)
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
 if o.status<>'READY' then raise exception 'DSB_ORDER_STEP: only a READY order can be handed over (this one is %)', o.status; end if;
 if o.revision<>p_revision then raise exception 'DSB_ORDER_CHANGED: this order was changed on another device; refresh'; end if;
 if p_payments is null or jsonb_typeof(p_payments)<>'array' then raise exception 'DSB_ORDER_INVALID: enter the payment'; end if;

 select jsonb_agg(jsonb_build_object('item_id',item_id,'unit_level',unit_level,'qty',qty::text,'price_kind','retail') order by line_no)
   into v_lines from order_items where order_id=o.id;
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
 values(o.tenant_id,o.id,'READY','DELIVERED','Sale '||v_sale::text,auth.uid(),'delivered:'||o.id::text);
 return jsonb_build_object('saleId',v_sale,'status','DELIVERED','revision',o.revision+1,'replayed',false);
end $$;
revoke all on function fulfil_order(uuid,integer,jsonb,uuid) from public,anon;
grant execute on function fulfil_order(uuid,integer,jsonb,uuid) to authenticated;
