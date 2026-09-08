-- Price changes are atomic: close current interval and insert successor under an
-- advisory lock scoped to tenant/item/shop/kind/unit. This preserves the no-
-- overlap exclusion constraint under concurrent admin updates.
create function set_item_price(p_item_id uuid,p_shop_id uuid,p_kind text,p_unit_level smallint,p_price_paise bigint,p_client_id text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_id uuid; v_now timestamptz:=clock_timestamp(); v_existing uuid;
begin
 if not has_perm('MANAGE_MASTER_DATA') then raise exception 'not permitted'; end if;
 if p_kind not in ('retail','wholesale','mrp','cost_last') or p_unit_level not between 1 and 3 or p_price_paise<0 then raise exception 'invalid price'; end if;
 if p_client_id is null or btrim(p_client_id)='' then raise exception 'client_id required'; end if;
 if not exists(select 1 from items where id=p_item_id and tenant_id=v_tenant and deleted_at is null) then raise exception 'item not in tenant'; end if;
 if p_shop_id is not null then perform phase3_assert_shop(p_shop_id); end if;
 select id into v_existing from item_prices where tenant_id=v_tenant and client_id=p_client_id;
 if v_existing is not null then return v_existing; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_tenant::text||':'||p_item_id::text||':'||coalesce(p_shop_id::text,'global')||':'||p_kind||':'||p_unit_level::text,0));
 update item_prices set effective_to=v_now
 where tenant_id=v_tenant and item_id=p_item_id and shop_id is not distinct from p_shop_id
   and kind=p_kind and unit_level=p_unit_level and effective_to is null and deleted_at is null;
 insert into item_prices(tenant_id,item_id,shop_id,kind,unit_level,price_paise,effective_from,client_id)
 values(v_tenant,p_item_id,p_shop_id,p_kind,p_unit_level,p_price_paise,v_now,p_client_id) returning id into v_id;
 return v_id;
exception when unique_violation then
 select id into v_existing from item_prices where tenant_id=v_tenant and client_id=p_client_id;
 if v_existing is not null then return v_existing; end if; raise;
end $$;
revoke all on function set_item_price(uuid,uuid,text,smallint,bigint,text) from public;
grant execute on function set_item_price(uuid,uuid,text,smallint,bigint,text) to authenticated;
