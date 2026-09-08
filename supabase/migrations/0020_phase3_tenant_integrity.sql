-- Phase 3 hardening: tenant-scoped composite foreign keys prevent cross-tenant
-- references even when a foreign UUID is known. Shop timezone is authoritative
-- for business dates; clients must not derive financial dates from UTC/browser time.

alter table shops add column if not exists timezone text not null default 'Asia/Kolkata';

alter table shops add constraint shops_tenant_id_id_key unique(tenant_id,id);
alter table categories add constraint categories_tenant_id_id_key unique(tenant_id,id);
alter table parties add constraint parties_tenant_id_id_key unique(tenant_id,id);
alter table items add constraint items_tenant_id_id_key unique(tenant_id,id);
alter table purchase_bills add constraint purchase_bills_tenant_id_id_key unique(tenant_id,id);

alter table items
  add constraint items_category_same_tenant_fk foreign key(tenant_id,category_id)
  references categories(tenant_id,id);
alter table item_barcodes
  add constraint item_barcodes_item_same_tenant_fk foreign key(tenant_id,item_id)
  references items(tenant_id,id);
alter table item_prices
  add constraint item_prices_item_same_tenant_fk foreign key(tenant_id,item_id)
  references items(tenant_id,id),
  add constraint item_prices_shop_same_tenant_fk foreign key(tenant_id,shop_id)
  references shops(tenant_id,id);
alter table purchase_bills
  add constraint purchase_bills_shop_same_tenant_fk foreign key(tenant_id,shop_id)
  references shops(tenant_id,id),
  add constraint purchase_bills_party_same_tenant_fk foreign key(tenant_id,party_id)
  references parties(tenant_id,id);
alter table purchase_bill_items
  add constraint purchase_items_bill_same_tenant_fk foreign key(tenant_id,purchase_bill_id)
  references purchase_bills(tenant_id,id),
  add constraint purchase_items_shop_same_tenant_fk foreign key(tenant_id,shop_id)
  references shops(tenant_id,id),
  add constraint purchase_items_item_same_tenant_fk foreign key(tenant_id,item_id)
  references items(tenant_id,id);
alter table stock_movements
  add constraint stock_movements_shop_same_tenant_fk foreign key(tenant_id,shop_id)
  references shops(tenant_id,id),
  add constraint stock_movements_item_same_tenant_fk foreign key(tenant_id,item_id)
  references items(tenant_id,id);

create function shop_business_date(p_shop_id uuid) returns date
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_timezone text;
begin
  select s.timezone into v_timezone from shops s
   where s.id=p_shop_id and s.tenant_id=v_tenant and s.deleted_at is null;
  if v_timezone is null then raise exception 'shop not in tenant'; end if;
  if not exists(select 1 from pg_timezone_names where name=v_timezone) then raise exception 'invalid shop timezone'; end if;
  return (clock_timestamp() at time zone v_timezone)::date;
end $$;
revoke all on function shop_business_date(uuid) from public;
grant execute on function shop_business_date(uuid) to authenticated;
