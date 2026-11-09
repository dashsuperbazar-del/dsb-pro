-- storefrontupi (SF6): the shop's UPI ID for "Pay by UPI" on the public order page (old-DSB-style free UPI link).
-- The customer's UPI app pays the shop directly; nothing here confirms a payment. Staff check that the money
-- arrived in their UPI app before "Hand over" records the sale as paid by UPI (fulfil_order, unchanged).
--  * storefront_settings.upi_id: a UPI VPA (name@bank), storefront_settings.upi_name: payee name shown in the app.
--  * set_storefront_upi(shop, upi_id, upi_name): MANAGE_STOREFRONT (owner/manager); blank clears both.
--  * public_storefront also returns upiId/upiName (public by design: it is printed on the pay link).
-- No money, stock or ledger effect. Forward-only.

alter table storefront_settings add column upi_id text
  check (upi_id is null or (char_length(upi_id) between 5 and 100 and upi_id ~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9.-]{1,34}$'));
alter table storefront_settings add column upi_name text
  check (upi_name is null or char_length(upi_name) between 1 and 60);

create function set_storefront_upi(p_shop_id uuid,p_upi_id text,p_upi_name text) returns void
language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_id text:=nullif(btrim(coalesce(p_upi_id,'')),''); v_name text:=nullif(btrim(coalesce(p_upi_name,'')),'');
begin
 v_tenant:=phase3_assert_shop(p_shop_id);
 if not has_perm('MANAGE_STOREFRONT') then raise exception 'not permitted'; end if;
 if v_id is not null and (char_length(v_id)>100 or v_id !~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9.-]{1,34}$') then
   raise exception 'DSB_INVALID_UPI: enter a UPI ID like shopname@okaxis';
 end if;
 if v_name is not null and char_length(v_name)>60 then raise exception 'DSB_INVALID_UPI: the payee name can be up to 60 characters'; end if;
 update storefront_settings set upi_id=v_id,upi_name=case when v_id is null then null else v_name end
  where tenant_id=v_tenant and shop_id=p_shop_id and deleted_at is null;
 if not found then raise exception 'DSB_STOREFRONT_MISSING: save the online shop settings first'; end if;
end $$;
revoke all on function set_storefront_upi(uuid,text,text) from public,anon;
grant execute on function set_storefront_upi(uuid,text,text) to authenticated;

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
   'freeDeliveryAbovePaise',s.free_delivery_above_paise::text,'deliverySlots',s.delivery_slots,
   'deliveryNote',s.delivery_note,'maxLines',s.max_lines,'upiId',s.upi_id,'upiName',s.upi_name);
end $$;
