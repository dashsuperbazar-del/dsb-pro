-- Allow stock that is already negative to be repaired incrementally.
--
-- The 0039 trigger evaluated only the resulting balance. A purchase of one
-- unit against on_hand=-3 therefore produced -2 and was rejected even though
-- the movement improved the projection. Direction is the missing part of the
-- invariant: positive movements are always recovery; zero/negative movements
-- must not consume reserved/unavailable stock unless this is the deliberately
-- enabled SALE-only oversell policy.
--
-- This remains an AFTER INSERT projection trigger. Raising rolls back both the
-- projection update and the source movement insert atomically. The UPSERT takes
-- the stock_current row lock, preserving the existing serialization behavior.
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

 -- A strictly positive movement can only improve availability. Negative
 -- movements retain the reservation guard. The shop override is deliberately
 -- scoped to SALE so purchase returns, sale-return voids, purchase voids and
 -- negative stock-count adjustments cannot borrow this exception.
 if new.qty_base <= 0 and v_on_hand < v_reserved then
   if new.source_type<>'SALE' then raise exception 'insufficient stock'; end if;
   select allow_negative_stock into v_allow_negative from shops where id=new.shop_id;
   if not coalesce(v_allow_negative,false) then raise exception 'insufficient stock'; end if;
 end if;
 return new;
end $$;
revoke all on function apply_stock_movement() from public;
