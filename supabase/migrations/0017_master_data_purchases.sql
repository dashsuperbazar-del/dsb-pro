-- Phase 3 — Master data + purchases.
-- Stock is derived only from append-only stock_movements written by RPCs.
-- Financial rows are immutable; correction is reversal, never destructive edit.
create extension if not exists btree_gist with schema extensions;

insert into permissions(code,description) values
 ('MANAGE_MASTER_DATA','Manage item/category/party master data'),
 ('POST_PURCHASES','Post and void purchase bills')
on conflict(code) do nothing;
insert into role_permissions(role,code) values
 ('owner','MANAGE_MASTER_DATA'),('manager','MANAGE_MASTER_DATA'),
 ('owner','POST_PURCHASES'),('manager','POST_PURCHASES')
on conflict do nothing;

create table categories(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 name text not null,
 created_by uuid not null default auth.uid(), created_at timestamptz not null default now(),
 updated_at bigint not null default 0, deleted_at bigint, client_id text,
 unique(tenant_id,name), unique(tenant_id,client_id)
);

create table parties(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 name text not null, phone text, gstin text, address text,
 created_by uuid not null default auth.uid(), created_at timestamptz not null default now(),
 updated_at bigint not null default 0, deleted_at bigint, client_id text,
 unique(tenant_id,client_id)
);

create table items(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 name text not null, sku text, hsn text, category_id uuid references categories(id),
 unit1 text not null, unit2 text, unit3 text,
 conv1 numeric(18,6), conv2 numeric(18,6),
 tax_rate_bp integer not null default 0 check(tax_rate_bp between 0 and 10000),
 min_stock numeric(18,6) not null default 0 check(min_stock>=0),
 image_path text, is_active boolean not null default true,
 created_by uuid not null default auth.uid(), created_at timestamptz not null default now(),
 updated_at bigint not null default 0, deleted_at bigint, client_id text,
 check((unit2 is null and conv1 is null) or (unit2 is not null and conv1>0)),
 check((unit3 is null and conv2 is null) or (unit3 is not null and unit2 is not null and conv2>0)),
 unique(tenant_id,sku), unique(tenant_id,client_id)
);

create table item_barcodes(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 item_id uuid not null references items(id), barcode text not null,
 unit_level smallint not null check(unit_level between 1 and 3),
 created_by uuid not null default auth.uid(), created_at timestamptz not null default now(),
 updated_at bigint not null default 0, deleted_at bigint, client_id text,
 unique(tenant_id,barcode), unique(tenant_id,client_id)
);

create table item_prices(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 item_id uuid not null references items(id), shop_id uuid references shops(id),
 kind text not null check(kind in ('retail','wholesale','mrp','cost_last')),
 unit_level smallint not null check(unit_level between 1 and 3),
 price_paise bigint not null check(price_paise>=0),
 effective_from timestamptz not null default now(), effective_to timestamptz,
 created_by uuid not null default auth.uid(), created_at timestamptz not null default now(),
 updated_at bigint not null default 0, deleted_at bigint, client_id text,
 check(effective_to is null or effective_to>effective_from),
 unique(tenant_id,client_id)
);
alter table item_prices add constraint item_prices_no_overlap exclude using gist(
 tenant_id with =,
 item_id with =,
 (coalesce(shop_id,'00000000-0000-0000-0000-000000000000'::uuid)) with =,
 kind with =,
 unit_level with =,
 tstzrange(effective_from,coalesce(effective_to,'infinity'::timestamptz),'[)') with &&
) where(deleted_at is null);

create table purchase_bills(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id), shop_id uuid not null references shops(id),
 party_id uuid references parties(id), bill_no text, business_date date not null,
 status text not null default 'POSTED' check(status in ('POSTED','VOID')),
 subtotal_paise bigint not null check(subtotal_paise>=0),
 discount_paise bigint not null default 0 check(discount_paise>=0),
 extra_charges_paise bigint not null default 0 check(extra_charges_paise>=0),
 total_paise bigint not null check(total_paise>=0), bill_image_path text, voided_at timestamptz,
 created_by uuid not null default auth.uid(), created_at timestamptz not null default now(),
 updated_at bigint not null default 0, deleted_at bigint, client_id text not null,
 unique(tenant_id,client_id)
);

create table purchase_bill_items(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id), shop_id uuid not null references shops(id),
 purchase_bill_id uuid not null references purchase_bills(id), item_id uuid not null references items(id),
 line_no integer not null check(line_no>0),
 item_name_snapshot text not null, hsn_snapshot text, tax_rate_bp_snapshot integer not null,
 unit_name_snapshot text not null, conv1_snapshot numeric(18,6), conv2_snapshot numeric(18,6),
 unit_level smallint not null check(unit_level between 1 and 3),
 qty numeric(18,6) not null check(qty>0), base_qty numeric(18,6) not null check(base_qty>0),
 unit_price_paise bigint not null check(unit_price_paise>=0), line_total_paise bigint not null check(line_total_paise>=0),
 created_by uuid not null default auth.uid(), created_at timestamptz not null default now(),
 updated_at bigint not null default 0, deleted_at bigint, client_id text not null,
 unique(purchase_bill_id,line_no), unique(tenant_id,client_id)
);

create table stock_movements(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id), shop_id uuid not null references shops(id), item_id uuid not null references items(id),
 source_type text not null check(source_type in ('PURCHASE','PURCHASE_VOID','SALE','SALE_VOID','RETURN','ADJUSTMENT')),
 source_id uuid not null, qty_base numeric(18,6) not null check(qty_base<>0),
 created_by uuid not null default auth.uid(), created_at timestamptz not null default now(),
 updated_at bigint not null default 0, deleted_at bigint, client_id text not null,
 unique(tenant_id,client_id)
);

create view stock_current with(security_invoker=true) as
 select tenant_id,shop_id,item_id,coalesce(sum(qty_base),0)::numeric(18,6) qty_base
 from stock_movements where deleted_at is null group by tenant_id,shop_id,item_id;

create index categories_tenant_idx on categories(tenant_id);
create index parties_tenant_idx on parties(tenant_id);
create index items_tenant_name_idx on items(tenant_id,name);
create index item_barcodes_lookup_idx on item_barcodes(tenant_id,barcode);
create index item_prices_lookup_idx on item_prices(tenant_id,item_id,kind,unit_level,effective_from desc);
create index purchase_bills_date_idx on purchase_bills(tenant_id,shop_id,business_date desc);
create index purchase_bill_items_bill_idx on purchase_bill_items(tenant_id,purchase_bill_id);
create index stock_movements_lookup_idx on stock_movements(tenant_id,shop_id,item_id,created_at);

create trigger categories_set_updated_at before insert or update on categories for each row execute function set_updated_at();
create trigger parties_set_updated_at before insert or update on parties for each row execute function set_updated_at();
create trigger items_set_updated_at before insert or update on items for each row execute function set_updated_at();
create trigger item_barcodes_set_updated_at before insert or update on item_barcodes for each row execute function set_updated_at();
create trigger item_prices_set_updated_at before insert or update on item_prices for each row execute function set_updated_at();
create trigger purchase_bills_set_updated_at before insert or update on purchase_bills for each row execute function set_updated_at();
create trigger purchase_bill_items_set_updated_at before insert or update on purchase_bill_items for each row execute function set_updated_at();
create trigger stock_movements_set_updated_at before insert or update on stock_movements for each row execute function set_updated_at();

create trigger audit_categories after insert or update on categories for each row execute function audit_row_change();
create trigger audit_parties after insert or update on parties for each row execute function audit_row_change();
create trigger audit_items after insert or update on items for each row execute function audit_row_change();
create trigger audit_item_barcodes after insert or update on item_barcodes for each row execute function audit_row_change();
create trigger audit_item_prices after insert or update on item_prices for each row execute function audit_row_change();
create trigger audit_purchase_bills after insert or update on purchase_bills for each row execute function audit_row_change();
create trigger audit_purchase_bill_items after insert on purchase_bill_items for each row execute function audit_row_change();
create trigger audit_stock_movements after insert on stock_movements for each row execute function audit_row_change();

alter table categories enable row level security;
alter table parties enable row level security;
alter table items enable row level security;
alter table item_barcodes enable row level security;
alter table item_prices enable row level security;
alter table purchase_bills enable row level security;
alter table purchase_bill_items enable row level security;
alter table stock_movements enable row level security;

grant select on categories,parties,items,item_barcodes,item_prices,purchase_bills,purchase_bill_items,stock_movements to authenticated;
grant select on stock_current to authenticated;
grant insert,update on categories,parties,items,item_barcodes,item_prices to authenticated;

create policy categories_read on categories for select using(tenant_id=current_tenant_id() and deleted_at is null);
create policy categories_write on categories for all using(tenant_id=current_tenant_id() and has_perm('MANAGE_MASTER_DATA')) with check(tenant_id=current_tenant_id() and has_perm('MANAGE_MASTER_DATA'));
create policy parties_read on parties for select using(tenant_id=current_tenant_id() and deleted_at is null);
create policy parties_write on parties for all using(tenant_id=current_tenant_id() and has_perm('MANAGE_MASTER_DATA')) with check(tenant_id=current_tenant_id() and has_perm('MANAGE_MASTER_DATA'));
create policy items_read on items for select using(tenant_id=current_tenant_id() and deleted_at is null);
create policy items_write on items for all using(tenant_id=current_tenant_id() and has_perm('MANAGE_MASTER_DATA')) with check(tenant_id=current_tenant_id() and has_perm('MANAGE_MASTER_DATA'));
create policy item_barcodes_read on item_barcodes for select using(tenant_id=current_tenant_id() and deleted_at is null);
create policy item_barcodes_write on item_barcodes for all using(tenant_id=current_tenant_id() and has_perm('MANAGE_MASTER_DATA')) with check(tenant_id=current_tenant_id() and has_perm('MANAGE_MASTER_DATA'));
create policy item_prices_read on item_prices for select using(tenant_id=current_tenant_id() and deleted_at is null);
create policy item_prices_write on item_prices for all using(tenant_id=current_tenant_id() and has_perm('MANAGE_MASTER_DATA')) with check(tenant_id=current_tenant_id() and has_perm('MANAGE_MASTER_DATA'));
create policy purchase_bills_read on purchase_bills for select using(tenant_id=current_tenant_id());
create policy purchase_bill_items_read on purchase_bill_items for select using(tenant_id=current_tenant_id());
create policy stock_movements_read on stock_movements for select using(tenant_id=current_tenant_id());

create function phase3_assert_shop(p_shop_id uuid) returns uuid
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id();
begin
 if v_tenant is null or not exists(select 1 from shops s where s.id=p_shop_id and s.tenant_id=v_tenant and s.deleted_at is null) then raise exception 'shop not in tenant'; end if;
 if not (p_shop_id=any(current_shop_ids()) or "current_role"() in ('owner','manager')) then raise exception 'shop not permitted'; end if;
 return v_tenant;
end $$;
revoke all on function phase3_assert_shop(uuid) from public;

create function post_purchase(
 p_shop_id uuid,p_party_id uuid,p_bill_no text,p_business_date date,
 p_discount_paise bigint,p_extra_charges_paise bigint,p_client_id text,p_lines jsonb,p_bill_image_path text default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare
 v_tenant uuid; v_bill uuid; v_existing uuid; v_subtotal bigint:=0; v_total bigint;
 v_line jsonb; v_ord bigint; v_item items%rowtype; v_level int; v_qty numeric; v_base numeric; v_price bigint; v_line_total bigint;
begin
 if not has_perm('POST_PURCHASES') then raise exception 'not permitted'; end if;
 v_tenant:=phase3_assert_shop(p_shop_id);
 if p_client_id is null or btrim(p_client_id)='' then raise exception 'client_id required'; end if;
 select id into v_existing from purchase_bills where tenant_id=v_tenant and client_id=p_client_id;
 if v_existing is not null then return v_existing; end if;
 if coalesce(p_discount_paise,0)<0 or coalesce(p_extra_charges_paise,0)<0 then raise exception 'negative adjustment'; end if;
 if p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then raise exception 'purchase requires lines'; end if;
 if p_party_id is not null and not exists(select 1 from parties where id=p_party_id and tenant_id=v_tenant and deleted_at is null) then raise exception 'party not in tenant'; end if;

 for v_line,v_ord in select value,ordinality from jsonb_array_elements(p_lines) with ordinality loop
  select * into v_item from items where id=(v_line->>'item_id')::uuid and tenant_id=v_tenant and deleted_at is null for share;
  if not found then raise exception 'item not in tenant'; end if;
  v_level:=coalesce((v_line->>'unit_level')::int,1); v_qty:=(v_line->>'qty')::numeric; v_price:=(v_line->>'unit_price_paise')::bigint;
  if v_qty<=0 or v_price<0 or v_level not between 1 and 3 then raise exception 'invalid purchase line'; end if;
  if v_level=1 then v_base:=v_qty;
  elsif v_level=2 and v_item.unit2 is not null and v_item.conv1>0 then v_base:=v_qty*v_item.conv1;
  elsif v_level=3 and v_item.unit3 is not null and v_item.conv1>0 and v_item.conv2>0 then v_base:=v_qty*v_item.conv1*v_item.conv2;
  else raise exception 'unit tier unavailable'; end if;
  v_line_total:=round(v_qty*v_price)::bigint; v_subtotal:=v_subtotal+v_line_total;
 end loop;
 v_total:=v_subtotal-coalesce(p_discount_paise,0)+coalesce(p_extra_charges_paise,0);
 if v_total<0 then raise exception 'negative total'; end if;
 insert into purchase_bills(tenant_id,shop_id,party_id,bill_no,business_date,subtotal_paise,discount_paise,extra_charges_paise,total_paise,bill_image_path,client_id)
 values(v_tenant,p_shop_id,p_party_id,p_bill_no,coalesce(p_business_date,current_date),v_subtotal,coalesce(p_discount_paise,0),coalesce(p_extra_charges_paise,0),v_total,p_bill_image_path,p_client_id)
 returning id into v_bill;

 for v_line,v_ord in select value,ordinality from jsonb_array_elements(p_lines) with ordinality loop
  select * into v_item from items where id=(v_line->>'item_id')::uuid and tenant_id=v_tenant;
  v_level:=coalesce((v_line->>'unit_level')::int,1); v_qty:=(v_line->>'qty')::numeric; v_price:=(v_line->>'unit_price_paise')::bigint;
  if v_level=1 then v_base:=v_qty; elsif v_level=2 then v_base:=v_qty*v_item.conv1; else v_base:=v_qty*v_item.conv1*v_item.conv2; end if;
  v_line_total:=round(v_qty*v_price)::bigint;
  insert into purchase_bill_items(tenant_id,shop_id,purchase_bill_id,item_id,line_no,item_name_snapshot,hsn_snapshot,tax_rate_bp_snapshot,unit_name_snapshot,conv1_snapshot,conv2_snapshot,unit_level,qty,base_qty,unit_price_paise,line_total_paise,client_id)
  values(v_tenant,p_shop_id,v_bill,v_item.id,v_ord,v_item.name,v_item.hsn,v_item.tax_rate_bp,case v_level when 1 then v_item.unit1 when 2 then v_item.unit2 else v_item.unit3 end,v_item.conv1,v_item.conv2,v_level,v_qty,v_base,v_price,v_line_total,p_client_id||':line:'||v_ord::text);
  insert into stock_movements(tenant_id,shop_id,item_id,source_type,source_id,qty_base,client_id)
  values(v_tenant,p_shop_id,v_item.id,'PURCHASE',v_bill,v_base,p_client_id||':stock:'||v_ord::text);
 end loop;
 return v_bill;
exception when unique_violation then
 select id into v_existing from purchase_bills where tenant_id=v_tenant and client_id=p_client_id;
 if v_existing is not null then return v_existing; end if;
 raise;
end $$;

create function void_purchase(p_purchase_id uuid,p_client_id text) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_bill purchase_bills%rowtype; v_line purchase_bill_items%rowtype;
begin
 if not has_perm('POST_PURCHASES') then raise exception 'not permitted'; end if;
 if p_client_id is null or btrim(p_client_id)='' then raise exception 'client_id required'; end if;
 select * into v_bill from purchase_bills where id=p_purchase_id and tenant_id=current_tenant_id() for update;
 if not found then raise exception 'purchase not found'; end if;
 if v_bill.status='VOID' then return v_bill.id; end if;
 perform phase3_assert_shop(v_bill.shop_id);
 for v_line in select * from purchase_bill_items where purchase_bill_id=v_bill.id and deleted_at is null loop
  insert into stock_movements(tenant_id,shop_id,item_id,source_type,source_id,qty_base,client_id)
  values(v_bill.tenant_id,v_bill.shop_id,v_line.item_id,'PURCHASE_VOID',v_bill.id,-v_line.base_qty,p_client_id||':stock:'||v_line.line_no::text);
 end loop;
 update purchase_bills set status='VOID',voided_at=now() where id=v_bill.id;
 return v_bill.id;
end $$;

create function phase3_immutable() returns trigger language plpgsql set search_path=public as $$
begin raise exception 'financial rows are immutable; use reversal RPC'; end $$;
create trigger purchase_bill_items_immutable before update or delete on purchase_bill_items for each row execute function phase3_immutable();
create trigger stock_movements_immutable before update or delete on stock_movements for each row execute function phase3_immutable();
create trigger purchase_bill_final_immutable before delete on purchase_bills for each row execute function phase3_immutable();

create function archive_master(p_table text,p_id uuid) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_now bigint:=(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 if not has_perm('MANAGE_MASTER_DATA') then raise exception 'not permitted'; end if;
 case p_table
  when 'categories' then update categories set deleted_at=v_now where id=p_id and tenant_id=current_tenant_id();
  when 'parties' then update parties set deleted_at=v_now where id=p_id and tenant_id=current_tenant_id();
  when 'items' then update items set deleted_at=v_now,is_active=false where id=p_id and tenant_id=current_tenant_id();
  else raise exception 'unsupported master table';
 end case;
 if not found then raise exception 'row not found'; end if;
 return p_id;
end $$;

revoke all on function post_purchase(uuid,uuid,text,date,bigint,bigint,text,jsonb,text) from public;
revoke all on function void_purchase(uuid,text) from public;
revoke all on function archive_master(text,uuid) from public;
grant execute on function post_purchase(uuid,uuid,text,date,bigint,bigint,text,jsonb,text) to authenticated;
grant execute on function void_purchase(uuid,text) to authenticated;
grant execute on function archive_master(text,uuid) to authenticated;
