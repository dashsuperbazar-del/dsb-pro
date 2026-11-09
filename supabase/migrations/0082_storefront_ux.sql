-- storefrontux (SF7): the old DSB shop experience on the new safe order model.
--  * Orders: OUT_FOR_DELIVERY between READY and DELIVERED (delivery orders only). Stock stays HELD while out for
--    delivery and such an order does not expire (expiry covers NEW..READY only). It can be handed over
--    (fulfil_order) or cancelled (holds released). fulfil_order now accepts READY or OUT_FOR_DELIVERY.
--  * Shop: open/closed switch with a closing message (closed = browse only, place_order refused), promo banner,
--    shop address, https map link, licence line, separate minimum for delivery (null = same as pickup). Set with
--    set_storefront_extras (MANAGE_STOREFRONT); public_storefront returns them.
--  * Catalog: public_catalog adds hasImage (a photo exists; the path is never exposed).
--    public_item_image_path(slug,item) returns the stored path ONLY for a published, active item of an enabled
--    shop; the public image endpoint uses it, so only published items' photos are ever served.
--  * find_order(slug, phone, ref): the customer-safe status of an order when BOTH the phone number and the
--    10-character order number match (lost link / another phone). Never returns contact details or the token.
-- No ledger change. Forward-only.

alter table orders drop constraint orders_status_check;
alter table orders add constraint orders_status_check
  check (status in ('NEW','CONFIRMED','PREPARING','READY','OUT_FOR_DELIVERY','DELIVERED','CANCELLED'));

alter table storefront_settings
  add column shop_open boolean not null default true,
  add column closed_message text check (closed_message is null or char_length(closed_message) between 1 and 200),
  add column banner_text text check (banner_text is null or char_length(banner_text) between 1 and 200),
  add column shop_address text check (shop_address is null or char_length(shop_address) between 1 and 300),
  add column map_url text check (map_url is null or (char_length(map_url)<=500 and map_url ~ '^https://[^[:space:]<>"]+$')),
  add column licence_line text check (licence_line is null or char_length(licence_line) between 1 and 120),
  add column min_delivery_paise bigint check (min_delivery_paise is null or min_delivery_paise between 0 and 100000000);

create function set_storefront_extras(p_shop_id uuid,p_extras jsonb) returns void
language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; e jsonb:=coalesce(p_extras,'{}'::jsonb); v_map text:=nullif(btrim(coalesce(e->>'mapUrl','')),'');
begin
 v_tenant:=phase3_assert_shop(p_shop_id);
 if not has_perm('MANAGE_STOREFRONT') then raise exception 'not permitted'; end if;
 if v_map is not null and (char_length(v_map)>500 or v_map !~ '^https://[^[:space:]<>"]+$') then
   raise exception 'DSB_INVALID_STOREFRONT: the map link must start with https://';
 end if;
 update storefront_settings set
   shop_open=coalesce((e->>'shopOpen')::boolean,true),
   closed_message=nullif(btrim(coalesce(e->>'closedMessage','')),''),
   banner_text=nullif(btrim(coalesce(e->>'bannerText','')),''),
   shop_address=nullif(btrim(coalesce(e->>'shopAddress','')),''),
   map_url=v_map,
   licence_line=nullif(btrim(coalesce(e->>'licenceLine','')),''),
   min_delivery_paise=(e->>'minDeliveryPaise')::bigint
  where tenant_id=v_tenant and shop_id=p_shop_id and deleted_at is null;
 if not found then raise exception 'DSB_STOREFRONT_MISSING: save the online shop settings first'; end if;
exception
 when invalid_text_representation or numeric_value_out_of_range then
   raise exception 'DSB_INVALID_STOREFRONT: a number or yes/no value is not valid';
 when check_violation then
   raise exception 'DSB_INVALID_STOREFRONT: a text is too long or a value is not allowed';
end $$;
revoke all on function set_storefront_extras(uuid,jsonb) from public,anon;
grant execute on function set_storefront_extras(uuid,jsonb) to authenticated;

create or replace function public_storefront(p_slug text) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare s storefront_settings;
begin
 if p_slug is null or char_length(p_slug)>40 then return null; end if;
 s:=storefront_public_shop(p_slug);
 if s.id is null then return null; end if;
 return jsonb_build_object('slug',s.slug,'name',s.display_name,'contact',s.public_contact,'orderHours',s.order_hours,
   'pickup',s.pickup_enabled,'pickupNote',s.pickup_note,'delivery',s.delivery_enabled,
   'deliveryFeePaise',s.delivery_fee_paise::text,'minOrderPaise',s.min_order_paise::text,
   'minDeliveryPaise',coalesce(s.min_delivery_paise,s.min_order_paise)::text,
   'freeDeliveryAbovePaise',s.free_delivery_above_paise::text,'deliverySlots',s.delivery_slots,
   'deliveryNote',s.delivery_note,'maxLines',s.max_lines,'upiId',s.upi_id,'upiName',s.upi_name,
   'open',s.shop_open,'closedMessage',s.closed_message,'banner',s.banner_text,'address',s.shop_address,
   'mapUrl',s.map_url,'licence',s.licence_line);
end $$;

create function public_item_image_path(p_slug text,p_item uuid) returns text
language plpgsql stable security definer set search_path=public as $$
declare s storefront_settings; v text;
begin
 if p_slug is null or char_length(p_slug)>40 or p_item is null then return null; end if;
 s:=storefront_public_shop(p_slug);
 if s.id is null then return null; end if;
 select i.image_path into v from storefront_items si join items i on i.id=si.item_id and i.tenant_id=si.tenant_id
  where si.tenant_id=s.tenant_id and si.shop_id=s.shop_id and si.item_id=p_item and si.published
    and si.deleted_at is null and i.is_active and i.deleted_at is null;
 return v;
end $$;
revoke all on function public_item_image_path(text,uuid) from public;
grant execute on function public_item_image_path(text,uuid) to anon,authenticated;

create function find_order(p_slug text,p_phone text,p_ref text) returns jsonb
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
     from order_items where order_id=o.id));
end $$;
revoke all on function find_order(text,text,text) from public;
grant execute on function find_order(text,text,text) to anon,authenticated;

-- Order functions re-issued with OUT_FOR_DELIVERY, shop_open and the delivery minimum (grants unchanged).

create or replace function place_order(p_slug text,p_request_id uuid,p_token text,p_fulfilment text,p_delivery_slot text,
 p_contact jsonb,p_lines jsonb,p_note text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare s storefront_settings; v_digest text; v_caller text; o orders; v_ref text; v_order uuid;
 v_name text; v_phone text; v_addr text; v_note text; v_slot text; v_fee bigint:=0; v_sub bigint:=0;
 l jsonb; v_item items; v_level int; v_qty numeric; v_base numeric; v_unit text; v_price bigint; v_line bigint;
 v_no int:=0; v_need jsonb:='{}'::jsonb; k text; v_req numeric; v_avail numeric; v_expires timestamptz;
 v_oi uuid; v_alpha constant text:='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; v_bytes bytea; i int;
begin
 if p_slug is null or char_length(p_slug)>40 or p_request_id is null then raise exception 'DSB_ORDER_INVALID: the order is incomplete'; end if;
 if p_token is null or char_length(p_token) not between 32 and 128 then raise exception 'DSB_ORDER_INVALID: the order is incomplete'; end if;
 s:=storefront_public_shop(p_slug);
 if s.id is null then raise exception 'DSB_SHOP_CLOSED: this shop is not taking online orders'; end if;
 if not s.shop_open then raise exception 'DSB_SHOP_CLOSED: %', coalesce(s.closed_message,'the shop is closed right now; please order later'); end if;
 v_digest:=encode(sha256(convert_to(p_token,'UTF8')),'hex');

 -- Replay: same request id returns the same order only with the same token.
 select * into o from orders where shop_id=s.shop_id and request_id=p_request_id;
 if found then
   if o.token_digest<>v_digest then raise exception 'DSB_ORDER_INVALID: this order request was already used'; end if;
   return jsonb_build_object('ref',o.public_ref,'status',o.status,'totalPaise',o.total_paise::text,
     'expiresAt',o.reservation_expires_at,'replayed',true);
 end if;


 v_name:=btrim(coalesce(p_contact->>'name','')); v_phone:=btrim(coalesce(p_contact->>'phone',''));
 v_addr:=nullif(btrim(coalesce(p_contact->>'address','')),''); v_note:=nullif(btrim(coalesce(p_note,'')),'');
 if char_length(v_name) not between 1 and 80 then raise exception 'DSB_ORDER_INVALID: enter your name'; end if;
 if v_phone !~ '^[0-9+() -]{6,20}$' then raise exception 'DSB_ORDER_INVALID: enter a phone number'; end if;
 if v_note is not null and char_length(v_note)>300 then raise exception 'DSB_ORDER_INVALID: the note can be up to 300 characters'; end if;
 if p_fulfilment='pickup' then
   if not s.pickup_enabled then raise exception 'DSB_ORDER_INVALID: pickup is not offered'; end if;
   v_slot:=null;
 elsif p_fulfilment='delivery' then
   if not s.delivery_enabled then raise exception 'DSB_ORDER_INVALID: delivery is not offered'; end if;
   if v_addr is null or char_length(v_addr)>300 then raise exception 'DSB_ORDER_INVALID: enter the delivery address'; end if;
   v_slot:=nullif(btrim(coalesce(p_delivery_slot,'')),'');
   if jsonb_array_length(s.delivery_slots)>0 and (v_slot is null or not (s.delivery_slots ? v_slot)) then
     raise exception 'DSB_ORDER_INVALID: choose a delivery time';
   end if;
   if jsonb_array_length(s.delivery_slots)=0 then v_slot:=null; end if;
 else raise exception 'DSB_ORDER_INVALID: choose pickup or delivery'; end if;
 if p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines) not between 1 and s.max_lines then
   raise exception 'DSB_ORDER_INVALID: the cart must have 1 to % lines', s.max_lines;
 end if;

 -- Serialise this shop's order placement (only after the cheap checks), then rate limits and replay recheck.
 perform pg_advisory_xact_lock(hashtextextended('dsb-orders:'||s.shop_id::text,0));
 select * into o from orders where shop_id=s.shop_id and request_id=p_request_id;
 if found then
   if o.token_digest<>v_digest then raise exception 'DSB_ORDER_INVALID: this order request was already used'; end if;
   return jsonb_build_object('ref',o.public_ref,'status',o.status,'totalPaise',o.total_paise::text,
     'expiresAt',o.reservation_expires_at,'replayed',true);
 end if;
 v_caller:=order_caller_digest();
 if (select count(*) from orders where caller_digest=v_caller and created_at>clock_timestamp()-interval '10 minutes')>=10
    or (select count(*) from orders where shop_id=s.shop_id and created_at>clock_timestamp()-interval '1 hour')>=60 then
   raise exception 'DSB_ORDER_RATE_LIMIT: too many orders just now, please try again in a few minutes';
 end if;
 perform order_expire_due(s.shop_id,50);

 -- Price every line from the live catalog (published, active, retail price for that unit).
 create temp table if not exists _order_lines(no int,item_id uuid,item_name text,lvl smallint,unit text,qty numeric,base numeric,price bigint,total bigint) on commit drop;
 truncate _order_lines;
 for l in select value from jsonb_array_elements(p_lines) loop
   v_no:=v_no+1;
   begin
     v_level:=(l->>'unitLevel')::int; v_qty:=(l->>'qty')::numeric;
     select i.* into v_item from items i join storefront_items si on si.item_id=i.id and si.tenant_id=i.tenant_id
      where i.id=(l->>'itemId')::uuid and i.tenant_id=s.tenant_id and si.shop_id=s.shop_id and si.published
        and si.deleted_at is null and i.is_active and i.deleted_at is null;
   exception when invalid_text_representation or numeric_value_out_of_range then
     raise exception 'DSB_ORDER_INVALID: line % is not valid', v_no;
   end;
   if v_item.id is null then raise exception 'DSB_ORDER_ITEM_GONE: an item in your cart is no longer sold online'; end if;
   if v_level is null or v_level not between 1 and 3 or v_qty is null or v_qty<=0 or v_qty>10000 or scale(v_qty)>3 then
     raise exception 'DSB_ORDER_INVALID: check the quantity on line %', v_no;
   end if;
   v_unit:=case v_level when 1 then v_item.unit1 when 2 then v_item.unit2 else v_item.unit3 end;
   if v_unit is null then raise exception 'DSB_ORDER_INVALID: check the unit on line %', v_no; end if;
   v_price:=storefront_retail_price(s.tenant_id,s.shop_id,v_item.id,v_level);
   if v_price is null then raise exception 'DSB_ORDER_ITEM_GONE: % has no price right now', v_item.name; end if;
   v_base:=v_qty*case v_level when 1 then coalesce(case when v_item.unit2 is not null then v_item.conv1 end,1)
                                          *coalesce(case when v_item.unit3 is not null then v_item.conv2 end,1)
                               when 2 then coalesce(case when v_item.unit3 is not null then v_item.conv2 end,1) else 1 end;
   v_line:=round(v_qty*v_price)::bigint;
   v_sub:=v_sub+v_line;
   insert into _order_lines values(v_no,v_item.id,v_item.name,v_level,v_unit,v_qty,v_base,v_price,v_line);
   v_need:=jsonb_set(v_need,array[v_item.id::text],to_jsonb(coalesce((v_need->>v_item.id::text)::numeric,0)+v_base));
   v_item:=null;
 end loop;

 if p_fulfilment='delivery' then s.min_order_paise:=coalesce(s.min_delivery_paise,s.min_order_paise); end if;
 if v_sub<s.min_order_paise then
   raise exception 'DSB_ORDER_MINIMUM: the minimum order is % paise', s.min_order_paise;
 end if;
 if p_fulfilment='delivery' then
   v_fee:=case when s.free_delivery_above_paise is not null and v_sub>=s.free_delivery_above_paise then 0 else s.delivery_fee_paise end;
 end if;

 -- Hold stock: lock rows sorted by item id, check what is free, then hold it.
 for k in select key from jsonb_each(v_need) order by key loop
   insert into stock_current(tenant_id,shop_id,item_id,on_hand,reserved) values(s.tenant_id,s.shop_id,k::uuid,0,0) on conflict do nothing;
   select available into v_avail from stock_current where tenant_id=s.tenant_id and shop_id=s.shop_id and item_id=k::uuid for update;
   v_req:=(v_need->>k)::numeric;
   if v_avail<v_req then
     raise exception 'DSB_ORDER_STOCK: % is not available in that quantity right now',
       (select item_name from _order_lines where item_id=k::uuid limit 1);
   end if;
 end loop;

 -- Public reference: 10 characters, no look-alike letters, random.
 loop
   v_bytes:=extensions.gen_random_bytes(10); v_ref:='';
   for i in 0..9 loop v_ref:=v_ref||substr(v_alpha,(get_byte(v_bytes,i)%32)+1,1); end loop;
   exit when not exists(select 1 from orders where public_ref=v_ref);
 end loop;
 v_expires:=clock_timestamp()+make_interval(mins=>s.reservation_minutes);
 insert into orders(tenant_id,shop_id,public_ref,fulfilment,delivery_slot,contact_name,contact_phone,contact_address,
   customer_note,subtotal_paise,delivery_fee_paise,total_paise,request_id,token_digest,caller_digest,reservation_expires_at,client_id)
 values(s.tenant_id,s.shop_id,v_ref,p_fulfilment,v_slot,v_name,v_phone,v_addr,v_note,v_sub,v_fee,v_sub+v_fee,
   p_request_id,v_digest,v_caller,v_expires,'order:'||p_request_id::text)
 returning id into v_order;
 for l in select to_jsonb(x) from _order_lines x order by no loop
   insert into order_items(tenant_id,order_id,line_no,item_id,item_name,unit_level,unit_name,qty,base_qty,unit_price_paise,line_total_paise,client_id)
   values(s.tenant_id,v_order,(l->>'no')::int,(l->>'item_id')::uuid,l->>'item_name',(l->>'lvl')::smallint,l->>'unit',
     (l->>'qty')::numeric,(l->>'base')::numeric,(l->>'price')::bigint,(l->>'total')::bigint,'order:'||p_request_id::text||':'||(l->>'no'))
   returning id into v_oi;
   insert into stock_reservations(tenant_id,shop_id,order_id,order_item_id,item_id,qty_base,expires_at,client_id)
   values(s.tenant_id,s.shop_id,v_order,v_oi,(l->>'item_id')::uuid,(l->>'base')::numeric,v_expires,'hold:'||v_oi::text);
   update stock_current set reserved=reserved+(l->>'base')::numeric,updated_at=(extract(epoch from clock_timestamp())*1000)::bigint
    where tenant_id=s.tenant_id and shop_id=s.shop_id and item_id=(l->>'item_id')::uuid;
 end loop;
 insert into order_events(tenant_id,order_id,from_status,to_status,reason,actor,client_id)
 values(s.tenant_id,v_order,null,'NEW','Placed online',null,'placed:'||v_order::text);
 return jsonb_build_object('ref',v_ref,'status','NEW','totalPaise',(v_sub+v_fee)::text,'expiresAt',v_expires,'replayed',false);
end $$;

create or replace function set_order_status(p_order_id uuid,p_to text,p_revision integer,p_reason text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o orders; v_ok boolean; v_reason text:=nullif(btrim(coalesce(p_reason,'')),'');
begin
 if not has_perm('MANAGE_ORDERS') then raise exception 'not permitted'; end if;
 select * into o from orders where id=p_order_id and tenant_id=current_tenant_id() for update;
 if not found or not c1_shop_visible(o.shop_id) then raise exception 'DSB_ORDER_NOT_FOUND: order not found'; end if;
 if o.status in ('NEW','CONFIRMED','PREPARING','READY') and o.reservation_expires_at<=clock_timestamp() then
   perform order_expire_one(o.id);
   return jsonb_build_object('status','CANCELLED','expired',true,
     'revision',(select revision from orders where id=o.id));
 end if;
 if o.revision<>p_revision then raise exception 'DSB_ORDER_CHANGED: this order was changed on another device; refresh'; end if;
 v_ok:=(o.status,p_to) in (('NEW','CONFIRMED'),('CONFIRMED','PREPARING'),('PREPARING','READY'))
   or (o.status='READY' and p_to='OUT_FOR_DELIVERY' and o.fulfilment='delivery')
   or (p_to='CANCELLED' and o.status in ('NEW','CONFIRMED','PREPARING','READY','OUT_FOR_DELIVERY'));
 if not v_ok then raise exception 'DSB_ORDER_STEP: an order cannot go from % to %', o.status, p_to; end if;
 if p_to='CANCELLED' then
   if v_reason is null or char_length(v_reason)>200 then raise exception 'DSB_ORDER_INVALID: give a reason (up to 200 characters)'; end if;
   perform order_release_holds(o.id,'CANCELLED');
 end if;
 update orders set status=p_to,revision=revision+1,cancel_reason=case when p_to='CANCELLED' then v_reason else cancel_reason end
  where id=o.id;
 insert into order_events(tenant_id,order_id,from_status,to_status,reason,actor,client_id)
 values(o.tenant_id,o.id,o.status,p_to,v_reason,auth.uid(),'step:'||o.id::text||':'||(o.revision+1)::text);
 return jsonb_build_object('status',p_to,'revision',o.revision+1);
end $$;

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
 values(o.tenant_id,o.id,o.status,'DELIVERED','Sale '||v_sale::text,auth.uid(),'delivered:'||o.id::text);
 return jsonb_build_object('saleId',v_sale,'status','DELIVERED','revision',o.revision+1,'replayed',false);
end $$;

create or replace function public_catalog(p_slug text,p_query text default null,p_category uuid default null,
 p_after_name text default null,p_after_id uuid default null,p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare s storefront_settings; v_q text; v_lim int; v_rows jsonb;
begin
 if p_slug is null or char_length(p_slug)>40 then return null; end if;
 s:=storefront_public_shop(p_slug);
 if s.id is null then return null; end if;
 if p_query is not null and char_length(p_query)>60 then raise exception 'DSB_SEARCH_TOO_LONG: search up to 60 characters'; end if;
 v_q:=nullif(btrim(coalesce(p_query,'')),'');
 if v_q is not null then v_q:='%'||replace(replace(replace(lower(v_q),'\','\\'),'%','\%'),'_','\_')||'%'; end if;
 v_lim:=least(greatest(coalesce(p_limit,50),1),100);
 with base as (
   select i.id,i.name,i.unit1,i.unit2,i.unit3,c.name as category,si.description,(i.image_path is not null) as has_image,
          coalesce(sc.available,0)>0 as in_stock
     from storefront_items si
     join items i on i.id=si.item_id and i.tenant_id=si.tenant_id and i.is_active and i.deleted_at is null
     left join categories c on c.id=i.category_id and c.tenant_id=i.tenant_id and c.deleted_at is null
     left join stock_current sc on sc.tenant_id=i.tenant_id and sc.shop_id=s.shop_id and sc.item_id=i.id
    where si.tenant_id=s.tenant_id and si.shop_id=s.shop_id and si.published and si.deleted_at is null
      and (v_q is null or lower(i.name) like v_q escape '\')
      and (p_category is null or i.category_id=p_category)
      and (p_after_name is null or (p_after_id is null and i.name>p_after_name) or (p_after_id is not null and (i.name,i.id)>(p_after_name,p_after_id)))
 ), priced as (
   select b.*,
     (select coalesce(jsonb_agg(jsonb_build_object('level',u.lvl,'unit',u.nm,'pricePaise',u.pr::text) order by u.lvl),'[]'::jsonb)
        from (select l.lvl,l.nm,storefront_retail_price(s.tenant_id,s.shop_id,b.id,l.lvl) pr
                from (values(1,b.unit1),(2,b.unit2),(3,b.unit3)) l(lvl,nm) where l.nm is not null) u
       where u.pr is not null) as units
   from base b
 ), page as (
   select * from priced where jsonb_array_length(units)>0 order by name,id limit v_lim
 )
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'category',category,'description',description,
   'units',units,'inStock',in_stock,'hasImage',has_image) order by name,id),'[]'::jsonb) into v_rows from page;
 return jsonb_build_object('items',v_rows,'more',jsonb_array_length(v_rows)=v_lim);
end $$;
