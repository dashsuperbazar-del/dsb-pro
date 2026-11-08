-- publiccatalog (SF1): what the public online shop may read, and nothing else. Three read-only functions callable
-- by anon. Each takes the public shop slug, answers only for an ENABLED shop, and returns an explicit allowlist:
--  * public_storefront(slug): shop display name, contact, order hours, pickup/delivery options, fee, minimum
--    order, free-delivery threshold, delivery slots. Never tenant ids, addresses, GSTIN or settings.
--  * public_catalog_categories(slug): names of categories that have at least one published, sellable item.
--  * public_catalog(slug, query, category, after, limit): published + active items only, each with public id,
--    name, category name, description, units with the CURRENT RETAIL price per unit (same precedence as sales:
--    shop price first, then tenant price) and an in-stock yes/no. A unit without a retail price is not offered; an
--    item with no priced unit is hidden. Never cost, purchase, wholesale, MRP, supplier or stock quantities.
--    Keyset paging by (name,id), at most 100 per page, search text at most 60 characters (LIKE wildcards escaped).
-- Base tables stay closed to anon. No writes, no money/stock effect. Forward-only.

create function storefront_public_shop(p_slug text) returns storefront_settings
language sql stable security definer set search_path=public as $$
 select s.* from storefront_settings s join shops sh on sh.id=s.shop_id and sh.tenant_id=s.tenant_id
  where s.slug=lower(btrim(coalesce(p_slug,''))) and s.enabled and s.deleted_at is null and sh.deleted_at is null
  limit 1 $$;
revoke all on function storefront_public_shop(text) from public,anon,authenticated;

create function storefront_retail_price(p_tenant uuid,p_shop uuid,p_item uuid,p_level int) returns bigint
language sql stable security definer set search_path=public as $$
 select price_paise from item_prices
  where tenant_id=p_tenant and item_id=p_item and kind='retail' and unit_level=p_level and deleted_at is null
    and effective_from<=clock_timestamp() and (effective_to is null or effective_to>clock_timestamp())
    and (shop_id=p_shop or shop_id is null)
  order by (shop_id is not null) desc,effective_from desc limit 1 $$;
revoke all on function storefront_retail_price(uuid,uuid,uuid,int) from public,anon,authenticated;

create function public_storefront(p_slug text) returns jsonb
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
   'deliveryNote',s.delivery_note,'maxLines',s.max_lines);
end $$;

create function public_catalog_categories(p_slug text) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare s storefront_settings;
begin
 if p_slug is null or char_length(p_slug)>40 then return '[]'::jsonb; end if;
 s:=storefront_public_shop(p_slug);
 if s.id is null then return '[]'::jsonb; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name) order by c.name,c.id)
   from categories c where c.tenant_id=s.tenant_id and c.deleted_at is null and exists(
     select 1 from storefront_items si join items i on i.id=si.item_id and i.tenant_id=si.tenant_id
      where si.shop_id=s.shop_id and si.tenant_id=s.tenant_id and si.published and si.deleted_at is null
        and i.category_id=c.id and i.is_active and i.deleted_at is null)),'[]'::jsonb);
end $$;

create function public_catalog(p_slug text,p_query text default null,p_category uuid default null,
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
   select i.id,i.name,i.unit1,i.unit2,i.unit3,c.name as category,si.description,
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
   'units',units,'inStock',in_stock) order by name,id),'[]'::jsonb) into v_rows from page;
 return jsonb_build_object('items',v_rows,'more',jsonb_array_length(v_rows)=v_lim);
end $$;

revoke all on function public_storefront(text) from public;
revoke all on function public_catalog_categories(text) from public;
revoke all on function public_catalog(text,text,uuid,text,uuid,integer) from public;
grant execute on function public_storefront(text) to anon,authenticated;
grant execute on function public_catalog_categories(text) to anon,authenticated;
grant execute on function public_catalog(text,text,uuid,text,uuid,integer) to anon,authenticated;
