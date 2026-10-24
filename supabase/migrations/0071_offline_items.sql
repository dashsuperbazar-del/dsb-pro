-- offlineitems: create an item with a DEVICE-generated id, idempotently (owner/manager), so a new item made
-- while offline can be queued in the ordered outbox BEFORE the purchase bill that references it.
--  * create_item_v2(p_item_id, p_client_id, p_item) inserts the item under the device's id and client id.
--  * Replay: the same client id with the same id returns that item (created=false), even if it was edited
--    since. The same client id with another id, or an id already used by another item, is DSB_PAYLOAD_MISMATCH
--    (never a silent second item, never a remap).
--  * Same name already in the tenant (active, case and outer spaces ignored): when EXACTLY one such item has
--    the same units and conversions (and the same SKU, if one was given) its id is returned (mapped=true) and
--    nothing is written; the device then points its queued bills at that item. Any other same-name item is
--    refused with DSB_ITEM_NAME_TAKEN (the device shows REJECTED and keeps its dependent bills from posting).
--    The existing item's GST rate is kept on a mapping.
--  * SKU already used: DSB_ITEM_SKU_TAKEN. Unit rules: the items check constraints, in plain words first.
--  * Serialized per tenant and name (advisory lock) so two devices creating the same name cannot both insert.
--  * A mapping writes nothing, so a client-id lookup of items decides every lost answer exactly: a row means
--    it was created; no row means nothing was written.
-- No new table. The items RLS, audit and updated_at triggers apply unchanged (definer insert still fires them).

create function create_item_v2(p_item_id uuid,p_client_id text,p_item jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
 v_tenant uuid:=current_tenant_id(); v_req uuid; v_name text; v_sku text; v_u1 text; v_u2 text; v_u3 text;
 v_c1 numeric; v_c2 numeric; v_tax integer; v_row items%rowtype; v_n int;
begin
 if v_tenant is null then raise exception 'not authenticated'; end if;
 if coalesce("current_role"(),'') not in ('owner','manager') or not has_perm('MANAGE_MASTER_DATA') then
   raise exception 'not permitted';
 end if;
 v_req:=c1_assert_request_uuid(p_client_id);
 if p_client_id<>v_req::text then raise exception 'DSB_INVALID_REQUEST_ID: client_id must be a lower-case request UUID'; end if;
 if p_item_id is null then raise exception 'DSB_INVALID_ITEM: item id required'; end if;
 if p_item is null or jsonb_typeof(p_item)<>'object' then raise exception 'DSB_INVALID_ITEM: item required'; end if;
 v_name:=btrim(coalesce(p_item->>'name',''));
 v_sku:=nullif(btrim(coalesce(p_item->>'sku','')),'');
 v_u1:=btrim(coalesce(p_item->>'unit1',''));
 v_u2:=nullif(btrim(coalesce(p_item->>'unit2','')),'');
 v_u3:=nullif(btrim(coalesce(p_item->>'unit3','')),'');
 begin
   v_c1:=nullif(p_item->>'conv1','')::numeric;
   v_c2:=nullif(p_item->>'conv2','')::numeric;
   v_tax:=coalesce(nullif(p_item->>'tax_rate_bp','')::integer,0);
 exception when others then
   raise exception 'DSB_INVALID_ITEM: conversions and GST must be numbers';
 end;
 if char_length(v_name) not between 1 and 120 then raise exception 'DSB_INVALID_ITEM: item name required (1-120 characters)'; end if;
 if char_length(v_u1) not between 1 and 30 or char_length(coalesce(v_u2,'')) >30 or char_length(coalesce(v_u3,''))>30 then
   raise exception 'DSB_INVALID_ITEM: big unit required (units up to 30 characters)';
 end if;
 if v_sku is not null and char_length(v_sku)>64 then raise exception 'DSB_INVALID_ITEM: SKU up to 64 characters'; end if;
 if (v_u2 is null)<>(v_c1 is null) or (v_c1 is not null and v_c1<=0) then
   raise exception 'DSB_INVALID_ITEM: small unit and small units per big go together (more than zero)';
 end if;
 if (v_u3 is null)<>(v_c2 is null) or (v_c2 is not null and v_c2<=0) or (v_u3 is not null and v_u2 is null) then
   raise exception 'DSB_INVALID_ITEM: piece unit needs the small unit and pieces per small (more than zero)';
 end if;
 if v_tax<0 or v_tax>10000 then raise exception 'DSB_INVALID_ITEM: GST from 0 to 100%%'; end if;

 perform pg_advisory_xact_lock(hashtextextended('dsb:item-create:'||v_tenant::text||':'||p_client_id,0));
 perform pg_advisory_xact_lock(hashtextextended('dsb:item-name:'||v_tenant::text||':'||lower(v_name),0));

 -- Replay of this client id: the same item, or a mismatch (never a second item).
 select * into v_row from items where tenant_id=v_tenant and client_id=p_client_id;
 if found then
   -- Keyed by id only: the item may have been edited since (rename, GST); it is still this request's item.
   if v_row.id=p_item_id then
     return jsonb_build_object('itemId',v_row.id,'requestedItemId',p_item_id,'created',false,'mapped',false);
   end if;
   raise exception 'DSB_PAYLOAD_MISMATCH: client_id already used for a different item';
 end if;
 if exists(select 1 from items where id=p_item_id) then
   raise exception 'DSB_PAYLOAD_MISMATCH: item id already used';
 end if;

 -- Same name: map only to exactly one item with the same units (and SKU when given); else refuse visibly.
 select count(*) into v_n from items where tenant_id=v_tenant and deleted_at is null and is_active
   and lower(btrim(name))=lower(v_name);
 if v_n>0 then
   select * into v_row from items where tenant_id=v_tenant and deleted_at is null and is_active
     and lower(btrim(name))=lower(v_name) order by created_at,id limit 1;
   if v_n=1 and v_row.unit1=v_u1 and v_row.unit2 is not distinct from v_u2 and v_row.unit3 is not distinct from v_u3
      and v_row.conv1 is not distinct from v_c1 and v_row.conv2 is not distinct from v_c2
      and (v_sku is null or v_row.sku is not distinct from v_sku) then
     return jsonb_build_object('itemId',v_row.id,'requestedItemId',p_item_id,'created',false,'mapped',true,
       'name',v_row.name);
   end if;
   raise exception 'DSB_ITEM_NAME_TAKEN: an item called % already exists with different units; pick that item or use another name',v_row.name;
 end if;
 if v_sku is not null and exists(select 1 from items where tenant_id=v_tenant and sku=v_sku) then
   raise exception 'DSB_ITEM_SKU_TAKEN: SKU % is already used by another item',v_sku;
 end if;

 insert into items(id,tenant_id,name,sku,unit1,unit2,unit3,conv1,conv2,tax_rate_bp,client_id)
 values(p_item_id,v_tenant,v_name,v_sku,v_u1,v_u2,v_u3,v_c1,v_c2,v_tax,p_client_id);
 return jsonb_build_object('itemId',p_item_id,'requestedItemId',p_item_id,'created',true,'mapped',false);
end $$;
revoke all on function create_item_v2(uuid,text,jsonb) from public,anon;
grant execute on function create_item_v2(uuid,text,jsonb) to authenticated;
