-- orders (SF2): online orders and the stock held for them. Customers place an order on the public shop; staff move it
-- NEW -> CONFIRMED -> PREPARING -> READY (DELIVERED only through fulfilment, SF3) or CANCELLED. Expiry cancels it.
-- NO stock movement, sale or payment is ever written here: an order only HOLDS stock (stock_current.reserved).
--
-- Silent-corruption guards:
--  * Stock trigger: a sale can NEVER take stock below what is held for orders, even with "allow negative stock".
--    (Before this packet nothing was ever held, so the old rule only ever meant "below zero".) Stock counts and
--    every other negative movement keep the 0042 rule: they cannot go below what is held (cancel the order first).
--  * Prices, units and totals are computed on the server from the live catalog; a customer never sends a price.
--  * place_order is idempotent per (shop, request id); a replay must present the same token (stored as a digest).
--  * Held quantity per item always equals the sum of active holds (one helper changes both, under the row lock).
--  * Anyone may call place_order (anon), so it is size-capped and rate-limited in the database itself
--    (10 orders per 10 minutes per caller network, 60 per hour per shop), which is consistent across servers.
-- Tables: standard columns, RLS read for MANAGE_ORDERS (owner/manager/cashier), no client writes, no delete, audited.
-- Forward-only.

-- 1. Stock trigger: holds are respected by every negative movement.
create or replace function apply_stock_movement() returns trigger
language plpgsql security definer set search_path=public as $$
declare v_on_hand numeric; v_reserved numeric; v_allow_negative boolean;
begin
 insert into stock_current(tenant_id,shop_id,item_id,on_hand,reserved,updated_at)
 values(new.tenant_id,new.shop_id,new.item_id,new.qty_base,0,(extract(epoch from clock_timestamp())*1000)::bigint)
 on conflict(tenant_id,shop_id,item_id) do update
 set on_hand=stock_current.on_hand+excluded.on_hand,
     updated_at=(extract(epoch from clock_timestamp())*1000)::bigint
 returning on_hand,reserved into v_on_hand,v_reserved;

 if new.qty_base <= 0 and v_on_hand < v_reserved then
   -- Every non-sale movement keeps the 0042 rule and message exactly.
   if new.source_type<>'SALE' then raise exception 'insufficient stock'; end if;
   -- Stock held for online orders is never sold, whatever the negative-stock setting. The message keeps
   -- 'insufficient stock' so offline sales treat it as a final refusal (packages/sync outbox) and show the
   -- usual "Not enough stock" text.
   if v_reserved>0 and exists(select 1 from stock_reservations sr join orders o on o.id=sr.order_id
        where sr.shop_id=new.shop_id and sr.item_id=new.item_id and sr.released_at is null
          and o.reservation_expires_at<=clock_timestamp()) then
     -- Holds that already expired must not block the counter: release them first (no cron needed).
     perform order_expire_due(new.shop_id,200);
     select on_hand,reserved into v_on_hand,v_reserved from stock_current
      where tenant_id=new.tenant_id and shop_id=new.shop_id and item_id=new.item_id;
     if v_on_hand>=v_reserved then return new; end if;
   end if;
   if v_reserved>0 then
     raise exception 'DSB_STOCK_RESERVED: insufficient stock: this stock is held for online orders (cancel or fulfil the order first)';
   end if;
   -- Nothing held: the SALE-only negative-stock override from 0042 is unchanged.
   select allow_negative_stock into v_allow_negative from shops where id=new.shop_id;
   if not coalesce(v_allow_negative,false) then raise exception 'insufficient stock'; end if;
 end if;
 return new;
end $$;
revoke all on function apply_stock_movement() from public;

-- 2. Tables.
create table orders(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 shop_id uuid not null,
 public_ref text not null check(public_ref ~ '^[A-Z2-9]{10}$'),
 status text not null default 'NEW' check(status in ('NEW','CONFIRMED','PREPARING','READY','DELIVERED','CANCELLED')),
 fulfilment text not null check(fulfilment in ('pickup','delivery')),
 delivery_slot text check(delivery_slot is null or char_length(delivery_slot) between 1 and 40),
 contact_name text not null check(char_length(contact_name) between 1 and 80),
 contact_phone text not null check(contact_phone ~ '^[0-9+() -]{6,20}$'),
 contact_address text check(contact_address is null or char_length(contact_address) between 1 and 300),
 customer_note text check(customer_note is null or char_length(customer_note) between 1 and 300),
 subtotal_paise bigint not null check(subtotal_paise>=0),
 delivery_fee_paise bigint not null default 0 check(delivery_fee_paise>=0),
 total_paise bigint not null check(total_paise=subtotal_paise+delivery_fee_paise),
 request_id uuid not null,
 token_digest text not null check(token_digest ~ '^[0-9a-f]{64}$'),
 caller_digest text not null check(caller_digest ~ '^[0-9a-f]{64}$'),
 reservation_expires_at timestamptz not null,
 revision integer not null default 1 check(revision>=1),
 sale_invoice_id uuid,
 cancel_reason text check(cancel_reason is null or char_length(cancel_reason) between 1 and 200),
 created_by uuid default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at bigint not null default 0,
 deleted_at bigint,
 client_id text not null check(char_length(client_id) between 1 and 128),
 check(fulfilment='pickup' or contact_address is not null),
 unique(tenant_id,client_id),
 unique(tenant_id,id),
 unique(shop_id,request_id),
 unique(public_ref),
 foreign key(tenant_id,shop_id) references shops(tenant_id,id)
);
create index orders_shop_status on orders(shop_id,status,created_at desc);
create index orders_caller_recent on orders(caller_digest,created_at desc);

create table order_items(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 order_id uuid not null,
 line_no integer not null check(line_no between 1 and 50),
 item_id uuid not null,
 item_name text not null,
 unit_level smallint not null check(unit_level between 1 and 3),
 unit_name text not null,
 qty numeric(18,6) not null check(qty>0),
 base_qty numeric(18,6) not null check(base_qty>0),
 unit_price_paise bigint not null check(unit_price_paise>=0),
 line_total_paise bigint not null check(line_total_paise>=0),
 created_by uuid default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at bigint not null default 0,
 deleted_at bigint,
 client_id text not null check(char_length(client_id) between 1 and 160),
 unique(tenant_id,client_id),
 unique(tenant_id,id),
 unique(order_id,line_no),
 foreign key(tenant_id,order_id) references orders(tenant_id,id),
 foreign key(tenant_id,item_id) references items(tenant_id,id)
);

create table order_events(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 order_id uuid not null,
 from_status text,
 to_status text not null,
 reason text check(reason is null or char_length(reason) between 1 and 200),
 actor uuid,
 created_by uuid default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at bigint not null default 0,
 deleted_at bigint,
 client_id text not null check(char_length(client_id) between 1 and 160),
 unique(tenant_id,client_id),
 foreign key(tenant_id,order_id) references orders(tenant_id,id)
);
create index order_events_order on order_events(order_id,created_at);

create table stock_reservations(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 shop_id uuid not null,
 order_id uuid not null,
 order_item_id uuid not null,
 item_id uuid not null,
 qty_base numeric(18,6) not null check(qty_base>0),
 expires_at timestamptz not null,
 released_at timestamptz,
 release_reason text check(release_reason in ('CANCELLED','EXPIRED','FULFILLED')),
 created_by uuid default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at bigint not null default 0,
 deleted_at bigint,
 client_id text not null check(char_length(client_id) between 1 and 160),
 check((released_at is null)=(release_reason is null)),
 unique(tenant_id,client_id),
 unique(order_item_id),
 foreign key(tenant_id,order_id) references orders(tenant_id,id),
 foreign key(tenant_id,order_item_id) references order_items(tenant_id,id),
 foreign key(tenant_id,shop_id) references shops(tenant_id,id),
 foreign key(tenant_id,item_id) references items(tenant_id,id)
);
create index stock_reservations_active on stock_reservations(shop_id,item_id) where released_at is null;
create index stock_reservations_order on stock_reservations(order_id) where released_at is null;

create function orders_no_delete() returns trigger language plpgsql as $$
begin raise exception 'online orders are never deleted; cancel them instead'; end $$;
create function order_events_append_only() returns trigger language plpgsql as $$
begin raise exception 'order history is append-only'; end $$;
create trigger orders_set_updated_at before insert or update on orders for each row execute function set_updated_at();
create trigger orders_no_delete before delete on orders for each row execute function orders_no_delete();
create trigger audit_orders after insert or update on orders for each row execute function audit_row_change();
create trigger order_items_set_updated_at before insert on order_items for each row execute function set_updated_at();
create trigger order_items_immutable before update or delete on order_items for each row execute function order_events_append_only();
create trigger order_events_set_updated_at before insert on order_events for each row execute function set_updated_at();
create trigger order_events_immutable before update or delete on order_events for each row execute function order_events_append_only();
create trigger stock_reservations_set_updated_at before insert or update on stock_reservations for each row execute function set_updated_at();
create trigger stock_reservations_no_delete before delete on stock_reservations for each row execute function orders_no_delete();
create trigger audit_stock_reservations after insert or update on stock_reservations for each row execute function audit_row_change();

alter table orders enable row level security;
alter table order_items enable row level security;
alter table order_events enable row level security;
alter table stock_reservations enable row level security;
create policy orders_read on orders for select using(tenant_id=current_tenant_id() and c1_shop_visible(shop_id) and has_perm('MANAGE_ORDERS'));
create policy order_items_read on order_items for select using(tenant_id=current_tenant_id() and has_perm('MANAGE_ORDERS')
 and exists(select 1 from orders o where o.id=order_id and c1_shop_visible(o.shop_id)));
create policy order_events_read on order_events for select using(tenant_id=current_tenant_id() and has_perm('MANAGE_ORDERS')
 and exists(select 1 from orders o where o.id=order_id and c1_shop_visible(o.shop_id)));
create policy stock_reservations_read on stock_reservations for select using(tenant_id=current_tenant_id() and c1_shop_visible(shop_id) and has_perm('MANAGE_ORDERS'));
revoke all on orders,order_items,order_events,stock_reservations from public,anon,authenticated;
grant select on order_items,order_events,stock_reservations to authenticated;
-- Staff never read the secret digests (customer token, caller network).
grant select(id,tenant_id,shop_id,public_ref,status,fulfilment,delivery_slot,contact_name,contact_phone,contact_address,
 customer_note,subtotal_paise,delivery_fee_paise,total_paise,request_id,reservation_expires_at,revision,sale_invoice_id,
 cancel_reason,created_by,created_at,updated_at,deleted_at,client_id) on orders to authenticated;
do $$
begin
 if exists (select 1 from pg_roles where rolname='backup_ro') then
   grant select on orders,order_items,order_events,stock_reservations to backup_ro;
 end if;
end $$;

-- 3. Internal helpers (no grants).
-- Release every active hold of one order under the stock row locks (sorted), keeping reserved == sum(active holds).
create function order_release_holds(p_order uuid,p_reason text) returns void
language plpgsql security definer set search_path=public as $$
declare r record;
begin
 for r in select sr.* from stock_reservations sr where sr.order_id=p_order and sr.released_at is null order by sr.item_id,sr.id loop
   perform 1 from stock_current where tenant_id=r.tenant_id and shop_id=r.shop_id and item_id=r.item_id for update;
   update stock_current set reserved=reserved-r.qty_base,updated_at=(extract(epoch from clock_timestamp())*1000)::bigint
    where tenant_id=r.tenant_id and shop_id=r.shop_id and item_id=r.item_id;
   update stock_reservations set released_at=clock_timestamp(),release_reason=p_reason where id=r.id;
 end loop;
end $$;
revoke all on function order_release_holds(uuid,text) from public,anon,authenticated;

-- Cancel ONE open order whose hold has expired (caller holds the order row lock). Returns true if cancelled.
create function order_expire_one(p_order uuid) returns boolean
language plpgsql security definer set search_path=public as $$
declare o orders;
begin
 select * into o from orders where id=p_order for update;
 if not found or o.status not in ('NEW','CONFIRMED','PREPARING','READY') or o.reservation_expires_at>clock_timestamp() then return false; end if;
 perform order_release_holds(o.id,'EXPIRED');
 update orders set status='CANCELLED',cancel_reason='Expired: not collected in time',revision=revision+1 where id=o.id;
 insert into order_events(tenant_id,order_id,from_status,to_status,reason,actor,client_id)
 values(o.tenant_id,o.id,o.status,'CANCELLED','EXPIRED',null,'expire:'||o.id::text);
 return true;
end $$;
revoke all on function order_expire_one(uuid) from public,anon,authenticated;

-- Cancel open orders of a shop whose hold has expired, oldest expiry first (bounded batch). Returns how many.
create function order_expire_due(p_shop uuid,p_limit integer default 50) returns integer
language plpgsql security definer set search_path=public as $$
declare o record; n integer:=0;
begin
 for o in select id from orders where shop_id=p_shop and status in ('NEW','CONFIRMED','PREPARING','READY')
   and reservation_expires_at<=clock_timestamp() order by reservation_expires_at,id
   limit greatest(1,least(coalesce(p_limit,50),200)) for update skip locked loop
   if order_expire_one(o.id) then n:=n+1; end if;
 end loop;
 return n;
end $$;
revoke all on function order_expire_due(uuid,integer) from public,anon,authenticated;

create function order_caller_digest() returns text language plpgsql stable set search_path=public as $$
declare h json; ip text;
begin
 begin h:=nullif(current_setting('request.headers',true),'')::json; exception when others then h:=null; end;
 -- cf-connecting-ip is set by the edge and cannot be supplied by the caller. Otherwise use the LAST
 -- x-forwarded-for hop (added by the trusted proxy), never the caller-controlled first one.
 ip:=coalesce(nullif(btrim(h->>'cf-connecting-ip'),''),
   nullif(btrim(regexp_replace(coalesce(h->>'x-forwarded-for',''),'^.*,','')),''),
   nullif(btrim(h->>'x-real-ip'),''),'unknown');
 return encode(sha256(convert_to('dsb-order-caller:'||btrim(ip),'UTF8')),'hex');
end $$;
revoke all on function order_caller_digest() from public,anon,authenticated;

-- 4. Public: place an order. p_lines = [{"itemId":uuid,"unitLevel":1|2|3,"qty":"2"}]; p_contact = {"name","phone","address"}.
-- Returns {"ref","status","totalPaise","expiresAt", "replayed"}. All refusals are DSB_* errors with a plain sentence.
create function place_order(p_slug text,p_request_id uuid,p_token text,p_fulfilment text,p_delivery_slot text,
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
revoke all on function place_order(text,uuid,text,text,text,jsonb,jsonb,text) from public;
grant execute on function place_order(text,uuid,text,text,text,jsonb,jsonb,text) to anon,authenticated;

-- 5. Public: order status for the customer who holds the token. Customer-safe fields only.
create function public_order_status(p_ref text,p_token text) returns jsonb
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
     from order_items where order_id=o.id));
end $$;
revoke all on function public_order_status(text,text) from public;
grant execute on function public_order_status(text,text) to anon,authenticated;

-- 6. Staff: move an order along, or cancel it. Optimistic revision; DELIVERED only through fulfilment (SF3).
create function set_order_status(p_order_id uuid,p_to text,p_revision integer,p_reason text default null)
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
   or (p_to='CANCELLED' and o.status in ('NEW','CONFIRMED','PREPARING','READY'));
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
revoke all on function set_order_status(uuid,text,integer,text) from public,anon;
grant execute on function set_order_status(uuid,text,integer,text) to authenticated;

-- 7. Staff: cancel expired orders now (also done lazily on every order placement and status change).
create function expire_due_orders(p_shop_id uuid) returns integer
language plpgsql security definer set search_path=public as $$
begin
 perform phase3_assert_shop(p_shop_id);
 if not has_perm('MANAGE_ORDERS') then raise exception 'not permitted'; end if;
 return order_expire_due(p_shop_id,200);
end $$;
revoke all on function expire_due_orders(uuid) from public,anon;
grant execute on function expire_due_orders(uuid) to authenticated;

-- 8. The business export carries orders, their lines, history and stock holds.
create or replace function phase6_export_tenant(p_shop_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_base jsonb; v_tenant uuid;
begin
 v_base:=phase6_export_tenant_v4_base(p_shop_id); v_tenant:=(v_base->>'tenantId')::uuid;
 return v_base || jsonb_build_object(
  'schemaVersion',4,
  'saleReturns',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from sale_returns where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'saleReturnLines',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from sale_return_items where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'purchaseReturns',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from purchase_returns where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'purchaseReturnLines',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from purchase_return_items where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'accountOpenings',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from account_openings where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'openingSettlements',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from opening_settlements where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'financialRequests',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from financial_requests where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'shopFinancialHistory',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from shop_financial_history where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'supplierPaymentSchedules',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from supplier_payment_schedules where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'partyMerges',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from party_merges where tenant_id=v_tenant) x),'[]'::jsonb),
  'purchaseCharges',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from purchase_bill_charges where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'purchaseImages',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from purchase_bill_images where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'documentRemarks',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from document_remarks where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'documentRemarkEvents',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.version,x.id) from (select * from document_remark_events where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'storefrontSettings',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from storefront_settings where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'storefrontItems',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from storefront_items where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'orders',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from orders where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'orderItems',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select oi.* from order_items oi join orders o on o.id=oi.order_id where oi.tenant_id=v_tenant and o.shop_id=p_shop_id) x),'[]'::jsonb),
  'orderEvents',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select oe.* from order_events oe join orders o on o.id=oe.order_id where oe.tenant_id=v_tenant and o.shop_id=p_shop_id) x),'[]'::jsonb),
  'stockReservations',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from stock_reservations where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb)
 );
end $$;
