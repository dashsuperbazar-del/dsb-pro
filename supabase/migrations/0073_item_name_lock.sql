-- itemnamelock: one rule and one lock for every new item name, online or offline.
--  * The app's online "Add item" and bill-card "+ Create" now call create_item_v2 (0071) like the offline
--    sync does, so both take the advisory lock on (tenant, lower(trimmed name)) and apply the same rule:
--    exactly one same-name item with the same units -> that item is returned (nothing written); any other
--    same-name item -> DSB_ITEM_NAME_TAKEN. No client change is needed in the database for that.
--  * A DIRECT insert into items by a signed-in client (an older app version still open on a device) took no
--    lock and checked nothing. items_name_guard (BEFORE INSERT, invoker) now takes the same lock for such
--    inserts and refuses any active same-name item with DSB_ITEM_NAME_TAKEN, so a direct insert racing a
--    create_item_v2 of the same name cannot produce a second item.
--  * Scope: only rows inserted by the authenticated role. SECURITY DEFINER paths (create_item_v2, legacy
--    import, restore) run as the function owner and are not affected; create_item_v2 checks for itself and
--    restore/import must keep reproducing existing data exactly.
--  * NO unique index: live data may already hold same-name items; an index would fail the live apply.
--    Existing duplicates are left untouched; renames are not checked (unchanged behaviour).
-- No new table. items RLS, audit and updated_at triggers are unchanged.

create function items_name_guard() returns trigger language plpgsql set search_path=public as $$
declare v_name text; v_other text;
begin
 if current_user<>'authenticated' then return new; end if;
 v_name:=btrim(coalesce(new.name,''));
 if v_name='' then return new; end if; -- the items check constraint refuses it
 -- Same key as create_item_v2 (0071): 'dsb:item-name:'||tenant||':'||lower(trimmed name).
 perform pg_advisory_xact_lock(hashtextextended('dsb:item-name:'||new.tenant_id::text||':'||lower(v_name),0));
 select name into v_other from items where tenant_id=new.tenant_id and deleted_at is null and is_active
   and lower(btrim(name))=lower(v_name) limit 1;
 if found then
   raise exception 'DSB_ITEM_NAME_TAKEN: an item called % already exists; pick that item or use another name',v_other;
 end if;
 return new;
end $$;
revoke all on function items_name_guard() from public,anon,authenticated;

create trigger items_name_guard before insert on items for each row execute function items_name_guard();
