-- itemrestore: bring back an item archived with archive_master('items',…).
--  * MANAGE_MASTER_DATA only (same as archive). SECURITY DEFINER; tenant from current_tenant_id().
--  * Takes the item-name lock of create_item_v2 (0071/0073) and refuses when an active item already uses the
--    name (DSB_ITEM_NAME_TAKEN), so a restore can never make a second same-name item.
--  * Only clears deleted_at and sets is_active; prices, barcodes, stock and history are untouched.
-- No new table.

create function restore_item(p_item_id uuid) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_name text; v_other text;
begin
 if not has_perm('MANAGE_MASTER_DATA') then raise exception 'not permitted'; end if;
 select btrim(name) into v_name from items where id=p_item_id and tenant_id=v_tenant for update;
 if not found then raise exception 'row not found'; end if;
 perform pg_advisory_xact_lock(hashtextextended('dsb:item-name:'||v_tenant::text||':'||lower(v_name),0));
 select name into v_other from items where tenant_id=v_tenant and id<>p_item_id and deleted_at is null and is_active
   and lower(btrim(name))=lower(v_name) limit 1;
 if found then
   raise exception 'DSB_ITEM_NAME_TAKEN: an item called % already exists; rename or archive it first',v_other;
 end if;
 update items set deleted_at=null,is_active=true where id=p_item_id and tenant_id=v_tenant;
 return p_item_id;
end $$;

revoke all on function restore_item(uuid) from public,anon;
grant execute on function restore_item(uuid) to authenticated;
