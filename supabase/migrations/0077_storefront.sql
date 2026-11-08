-- storefront (SF0): online shop settings and which items are published. Nothing here is public yet: anon has no
-- access to any of it (SF1 adds a narrow public catalog view). No money, stock or ledger effect. Forward-only.
--  * permissions MANAGE_STOREFRONT (owner, manager) and MANAGE_ORDERS (owner, manager, cashier; used from SF2).
--  * storefront_settings: one row per shop, OFF by default. Public slug (a-z, 0-9, '-', 3-40, unique), display
--    name, contact, pickup note, order hours, reservation minutes 5-120, max lines 1-50; pickup and delivery like
--    old DSB: delivery fee, minimum order, free-delivery threshold and up to 12 delivery time slots. All money in
--    integer paise; the fee is server-set and never comes from a customer.
--  * storefront_items: per shop+item published flag and a short public description (300 chars). An item is
--    sold online only when published here AND active in the item master.
--  * set_storefront_settings / set_storefront_items: MANAGE_STOREFRONT only, tenant from the JWT, validated.
-- Tables: standard columns, RLS read for MANAGE_STOREFRONT or MANAGE_ORDERS, no client writes, no delete, audited.

insert into permissions(code,description) values
 ('MANAGE_STOREFRONT','Change online shop settings and which items are published'),
 ('MANAGE_ORDERS','See and handle online orders')
on conflict do nothing;
insert into role_permissions(role,code) values
 ('owner','MANAGE_STOREFRONT'),('manager','MANAGE_STOREFRONT'),
 ('owner','MANAGE_ORDERS'),('manager','MANAGE_ORDERS'),('cashier','MANAGE_ORDERS')
on conflict do nothing;

create table storefront_settings(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 shop_id uuid not null,
 enabled boolean not null default false,
 slug text not null check(slug ~ '^[a-z0-9]([a-z0-9-]{1,38})[a-z0-9]$'),
 display_name text not null check(char_length(display_name) between 1 and 80),
 public_contact text check(public_contact is null or char_length(public_contact) between 1 and 80),
 pickup_note text check(pickup_note is null or char_length(pickup_note) between 1 and 300),
 order_hours text check(order_hours is null or char_length(order_hours) between 1 and 120),
 reservation_minutes integer not null default 30 check(reservation_minutes between 5 and 120),
 max_lines integer not null default 50 check(max_lines between 1 and 50),
 pickup_enabled boolean not null default true,
 delivery_enabled boolean not null default false,
 delivery_fee_paise bigint not null default 0 check(delivery_fee_paise between 0 and 10000000),
 min_order_paise bigint not null default 0 check(min_order_paise between 0 and 100000000),
 free_delivery_above_paise bigint check(free_delivery_above_paise is null or free_delivery_above_paise between 1 and 100000000),
 delivery_slots jsonb not null default '[]'::jsonb check(jsonb_typeof(delivery_slots)='array' and jsonb_array_length(delivery_slots)<=12),
 delivery_note text check(delivery_note is null or char_length(delivery_note) between 1 and 300),
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at bigint not null default 0,
 deleted_at bigint,
 client_id text not null check(char_length(client_id) between 1 and 128),
 check(pickup_enabled or delivery_enabled),
 unique(tenant_id,client_id),
 unique(tenant_id,id),
 unique(tenant_id,shop_id),
 unique(slug),
 foreign key(tenant_id,shop_id) references shops(tenant_id,id)
);

create table storefront_items(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 shop_id uuid not null,
 item_id uuid not null,
 published boolean not null default false,
 description text check(description is null or char_length(description) between 1 and 300),
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at bigint not null default 0,
 deleted_at bigint,
 client_id text not null check(char_length(client_id) between 1 and 128),
 unique(tenant_id,client_id),
 unique(tenant_id,id),
 unique(tenant_id,shop_id,item_id),
 foreign key(tenant_id,shop_id) references shops(tenant_id,id),
 foreign key(tenant_id,item_id) references items(tenant_id,id)
);
create index storefront_items_published on storefront_items(shop_id) where published and deleted_at is null;

create function storefront_no_delete() returns trigger language plpgsql as $$
begin raise exception 'online shop rows are never deleted; turn them off instead'; end $$;
create trigger storefront_settings_set_updated_at before insert or update on storefront_settings
 for each row execute function set_updated_at();
create trigger storefront_settings_no_delete before delete on storefront_settings
 for each row execute function storefront_no_delete();
create trigger audit_storefront_settings after insert or update on storefront_settings
 for each row execute function audit_row_change();
create trigger storefront_items_set_updated_at before insert or update on storefront_items
 for each row execute function set_updated_at();
create trigger storefront_items_no_delete before delete on storefront_items
 for each row execute function storefront_no_delete();
create trigger audit_storefront_items after insert or update on storefront_items
 for each row execute function audit_row_change();

alter table storefront_settings enable row level security;
alter table storefront_items enable row level security;
create policy storefront_settings_read on storefront_settings for select using(
 tenant_id=current_tenant_id() and c1_shop_visible(shop_id) and (has_perm('MANAGE_STOREFRONT') or has_perm('MANAGE_ORDERS')));
create policy storefront_items_read on storefront_items for select using(
 tenant_id=current_tenant_id() and c1_shop_visible(shop_id) and (has_perm('MANAGE_STOREFRONT') or has_perm('MANAGE_ORDERS')));
revoke all on storefront_settings, storefront_items from public,anon,authenticated;
grant select on storefront_settings, storefront_items to authenticated;
do $$
begin
 if exists (select 1 from pg_roles where rolname='backup_ro') then
   grant select on storefront_settings, storefront_items to backup_ro;
 end if;
end $$;

-- Create or update the shop's online shop settings (one row per shop). Returns the row id.
create function set_storefront_settings(p_shop_id uuid,p_settings jsonb,p_client_id text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_id uuid; s jsonb:=coalesce(p_settings,'{}'::jsonb); v_slots jsonb;
 v_slug text:=lower(btrim(coalesce(s->>'slug','')));
 v_name text:=btrim(coalesce(s->>'displayName',''));
 txt text; i integer;
begin
 v_tenant:=phase3_assert_shop(p_shop_id);
 if not has_perm('MANAGE_STOREFRONT') then raise exception 'not permitted'; end if;
 if p_client_id is null or char_length(p_client_id) not between 1 and 128 then raise exception 'DSB_INVALID_STOREFRONT: client id'; end if;
 if v_slug !~ '^[a-z0-9]([a-z0-9-]{1,38})[a-z0-9]$' then
   raise exception 'DSB_INVALID_SLUG: use 3-40 lower-case letters, digits or -, not starting or ending with -';
 end if;
 if exists(select 1 from storefront_settings where slug=v_slug and not (tenant_id=v_tenant and shop_id=p_shop_id)) then
   raise exception 'DSB_SLUG_TAKEN: that shop address is already used';
 end if;
 v_slots:=coalesce(s->'deliverySlots','[]'::jsonb);
 if jsonb_typeof(v_slots)<>'array' or jsonb_array_length(v_slots)>12 then
   raise exception 'DSB_INVALID_STOREFRONT: at most 12 delivery slots';
 end if;
 for i in 0..jsonb_array_length(v_slots)-1 loop
   txt:=v_slots->>i;
   if jsonb_typeof(v_slots->i)<>'string' or txt is null or char_length(btrim(txt)) not between 1 and 40 then
     raise exception 'DSB_INVALID_STOREFRONT: each delivery slot is 1-40 characters';
   end if;
 end loop;
 insert into storefront_settings(tenant_id,shop_id,enabled,slug,display_name,public_contact,pickup_note,order_hours,
   reservation_minutes,max_lines,pickup_enabled,delivery_enabled,delivery_fee_paise,min_order_paise,
   free_delivery_above_paise,delivery_slots,delivery_note,client_id)
 values(v_tenant,p_shop_id,coalesce((s->>'enabled')::boolean,false),v_slug,v_name,
   nullif(btrim(coalesce(s->>'publicContact','')),''),nullif(btrim(coalesce(s->>'pickupNote','')),''),
   nullif(btrim(coalesce(s->>'orderHours','')),''),coalesce((s->>'reservationMinutes')::integer,30),
   coalesce((s->>'maxLines')::integer,50),coalesce((s->>'pickupEnabled')::boolean,true),
   coalesce((s->>'deliveryEnabled')::boolean,false),coalesce((s->>'deliveryFeePaise')::bigint,0),
   coalesce((s->>'minOrderPaise')::bigint,0),(s->>'freeDeliveryAbovePaise')::bigint,
   (select coalesce(jsonb_agg(to_jsonb(btrim(x))),'[]'::jsonb) from jsonb_array_elements_text(v_slots) x),
   nullif(btrim(coalesce(s->>'deliveryNote','')),''),p_client_id)
 on conflict(tenant_id,shop_id) do update set
   enabled=excluded.enabled,slug=excluded.slug,display_name=excluded.display_name,public_contact=excluded.public_contact,
   pickup_note=excluded.pickup_note,order_hours=excluded.order_hours,reservation_minutes=excluded.reservation_minutes,
   max_lines=excluded.max_lines,pickup_enabled=excluded.pickup_enabled,delivery_enabled=excluded.delivery_enabled,
   delivery_fee_paise=excluded.delivery_fee_paise,min_order_paise=excluded.min_order_paise,
   free_delivery_above_paise=excluded.free_delivery_above_paise,delivery_slots=excluded.delivery_slots,
   delivery_note=excluded.delivery_note
 returning id into v_id;
 return v_id;
exception when invalid_text_representation or numeric_value_out_of_range then
 raise exception 'DSB_INVALID_STOREFRONT: a number or yes/no value is not valid';
end $$;
revoke all on function set_storefront_settings(uuid,jsonb,text) from public,anon;
grant execute on function set_storefront_settings(uuid,jsonb,text) to authenticated;

-- Publish/unpublish items in bulk: p_items = [{"itemId":uuid,"published":bool,"description":text|null}] (max 500).
-- Returns how many rows were written. Items of another tenant or unknown items are refused (nothing written).
create function set_storefront_items(p_shop_id uuid,p_items jsonb,p_client_id text)
returns integer language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; r jsonb; v_item uuid; v_desc text; n integer:=0;
begin
 v_tenant:=phase3_assert_shop(p_shop_id);
 if not has_perm('MANAGE_STOREFRONT') then raise exception 'not permitted'; end if;
 if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 500
    or p_client_id is null or char_length(p_client_id) not between 1 and 90 then
   raise exception 'DSB_INVALID_STOREFRONT: send 1-500 items';
 end if;
 for r in select value from jsonb_array_elements(p_items) loop
   v_item:=(r->>'itemId')::uuid;
   v_desc:=nullif(btrim(coalesce(r->>'description','')),'');
   if v_desc is not null and char_length(v_desc)>300 then raise exception 'DSB_INVALID_STOREFRONT: description up to 300 characters'; end if;
   if not exists(select 1 from items where id=v_item and tenant_id=v_tenant and deleted_at is null) then
     raise exception 'DSB_ITEM_NOT_FOUND: item not found';
   end if;
   insert into storefront_items(tenant_id,shop_id,item_id,published,description,client_id)
   values(v_tenant,p_shop_id,v_item,coalesce((r->>'published')::boolean,false),v_desc,p_client_id||':'||v_item::text)
   on conflict(tenant_id,shop_id,item_id) do update set published=excluded.published,description=excluded.description;
   n:=n+1;
 end loop;
 return n;
exception when invalid_text_representation then
 raise exception 'DSB_INVALID_STOREFRONT: an item id or yes/no value is not valid';
end $$;
revoke all on function set_storefront_items(uuid,jsonb,text) from public,anon;
grant execute on function set_storefront_items(uuid,jsonb,text) to authenticated;

-- The business export carries the online shop settings and published items (coverage test: every table exported).
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
  -- D3a: the request ledger (payload + result of every money request) and the shop's allocation-date
  -- trust marker, so a restore keeps replay protection and dated reports.
  'financialRequests',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from financial_requests where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'shopFinancialHistory',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from shop_financial_history where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'supplierPaymentSchedules',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from supplier_payment_schedules where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'partyMerges',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from party_merges where tenant_id=v_tenant) x),'[]'::jsonb),
  'purchaseCharges',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from purchase_bill_charges where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'purchaseImages',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from purchase_bill_images where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'documentRemarks',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from document_remarks where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'documentRemarkEvents',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.version,x.id) from (select * from document_remark_events where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'storefrontSettings',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from storefront_settings where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'storefrontItems',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from storefront_items where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb)
 );
end $$;
