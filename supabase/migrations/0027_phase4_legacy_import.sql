-- Phase 4 shop-test bridge: owner-only, one-time import of legacy DSB
-- master data and current stock. Historical bills/invoices/payments are deliberately
-- NOT imported here; this bridge exists only to establish a trustworthy opening
-- state for parallel shop-day reconciliation.

create table legacy_import_runs(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 shop_id uuid not null,
 source_exported_at timestamptz not null,
 source_version integer not null,
 summary jsonb not null,
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at bigint not null default 0,
 deleted_at bigint,
 client_id text not null,
 unique(tenant_id,client_id),
 unique(tenant_id,shop_id,source_exported_at),
 unique(tenant_id,id),
 foreign key(tenant_id,shop_id) references shops(tenant_id,id)
);
create trigger legacy_import_runs_set_updated_at before insert or update on legacy_import_runs
 for each row execute function set_updated_at();
create trigger audit_legacy_import_runs after insert or update on legacy_import_runs
 for each row execute function audit_row_change();
alter table legacy_import_runs enable row level security;
grant select on legacy_import_runs to authenticated;
create policy legacy_import_runs_read on legacy_import_runs for select
 using(tenant_id=current_tenant_id() and "current_role"()='owner' and deleted_at is null);

create function import_legacy_dsb_master(p_shop_id uuid,p_plan jsonb,p_client_id text)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
 v_tenant uuid;
 v_existing jsonb;
 v_source_version integer;
 v_source_exported_at timestamptz;
 v_items jsonb;
 v_parties jsonb;
 v_customers jsonb;
 v_row jsonb;
 v_price jsonb;
 v_item_id uuid;
 v_legacy_id text;
 v_unit1 text;
 v_unit2 text;
 v_unit3 text;
 v_conv1 numeric;
 v_conv2 numeric;
 v_stock numeric;
 v_level integer;
 v_kind text;
 v_price_paise bigint;
 v_items_count integer:=0;
 v_parties_count integer:=0;
 v_customers_count integer:=0;
 v_prices_count integer:=0;
 v_stock_count integer:=0;
 v_summary jsonb;
begin
 if p_client_id is null or btrim(p_client_id)='' then raise exception 'client_id required'; end if;
 v_tenant:=phase3_assert_shop(p_shop_id);
 if "current_role"()<>'owner' then raise exception 'legacy import requires owner'; end if;
 if p_plan is null or jsonb_typeof(p_plan)<>'object' then raise exception 'legacy import plan must be an object'; end if;

 v_source_version:=coalesce((p_plan->>'sourceVersion')::integer,0);
 if v_source_version<>3 then raise exception 'unsupported legacy source version'; end if;
 begin
   v_source_exported_at:=(p_plan->>'exportedAt')::timestamptz;
 exception when others then
   raise exception 'invalid legacy export timestamp';
 end;
 if v_source_exported_at is null then raise exception 'invalid legacy export timestamp'; end if;

 select summary into v_existing from legacy_import_runs
  where tenant_id=v_tenant and (client_id=p_client_id or (shop_id=p_shop_id and source_exported_at=v_source_exported_at))
  order by created_at limit 1;
 if v_existing is not null then return v_existing; end if;

 -- Opening-state import must never be mixed into an already-operating shop.
 if exists(select 1 from sale_invoices where tenant_id=v_tenant and shop_id=p_shop_id)
    or exists(select 1 from purchase_bills where tenant_id=v_tenant and shop_id=p_shop_id)
    or exists(select 1 from stock_movements where tenant_id=v_tenant and shop_id=p_shop_id)
    or exists(select 1 from items where tenant_id=v_tenant and deleted_at is null)
    or exists(select 1 from parties where tenant_id=v_tenant and deleted_at is null)
    or exists(select 1 from customers where tenant_id=v_tenant and deleted_at is null)
 then raise exception 'shop must be empty before legacy import'; end if;

 v_items:=coalesce(p_plan->'items','[]'::jsonb);
 v_parties:=coalesce(p_plan->'parties','[]'::jsonb);
 v_customers:=coalesce(p_plan->'customers','[]'::jsonb);
 if jsonb_typeof(v_items)<>'array' or jsonb_array_length(v_items)=0 then raise exception 'legacy import requires items'; end if;
 if jsonb_typeof(v_parties)<>'array' or jsonb_typeof(v_customers)<>'array' then raise exception 'invalid legacy master arrays'; end if;
 if jsonb_array_length(v_items)>5000 or jsonb_array_length(v_parties)>5000 or jsonb_array_length(v_customers)>5000 then
   raise exception 'legacy import exceeds safety limit';
 end if;

 for v_row in select value from jsonb_array_elements(v_parties) loop
   v_legacy_id:=btrim(coalesce(v_row->>'legacyId',''));
   if v_legacy_id='' or btrim(coalesce(v_row->>'name',''))='' then raise exception 'invalid legacy party'; end if;
   insert into parties(tenant_id,name,phone,gstin,address,client_id)
   values(v_tenant,btrim(v_row->>'name'),nullif(btrim(coalesce(v_row->>'phone','')),''),nullif(btrim(coalesce(v_row->>'gstin','')),''),nullif(btrim(coalesce(v_row->>'address','')),''),'legacy:party:'||v_legacy_id);
   v_parties_count:=v_parties_count+1;
 end loop;

 for v_row in select value from jsonb_array_elements(v_customers) loop
   v_legacy_id:=btrim(coalesce(v_row->>'legacyId',''));
   if v_legacy_id='' or btrim(coalesce(v_row->>'name',''))='' then raise exception 'invalid legacy customer'; end if;
   insert into customers(tenant_id,name,phone,address,gstin,credit_limit_paise,notes,client_id)
   values(v_tenant,btrim(v_row->>'name'),nullif(btrim(coalesce(v_row->>'phone','')),''),nullif(btrim(coalesce(v_row->>'address','')),''),nullif(btrim(coalesce(v_row->>'gstin','')),''),
          greatest(coalesce((v_row->>'creditLimitPaise')::bigint,0),0),nullif(btrim(coalesce(v_row->>'notes','')),''),'legacy:customer:'||v_legacy_id);
   v_customers_count:=v_customers_count+1;
 end loop;

 for v_row in select value from jsonb_array_elements(v_items) loop
   v_legacy_id:=btrim(coalesce(v_row->>'legacyId',''));
   v_unit1:=btrim(coalesce(v_row->>'unit1',''));
   v_unit2:=nullif(btrim(coalesce(v_row->>'unit2','')),'');
   v_unit3:=nullif(btrim(coalesce(v_row->>'unit3','')),'');
   if v_legacy_id='' or btrim(coalesce(v_row->>'name',''))='' or v_unit1='' then raise exception 'invalid legacy item'; end if;
   if v_unit3 is not null and v_unit2 is null then raise exception 'invalid legacy unit hierarchy'; end if;
   v_conv1:=case when v_unit2 is null then null else (v_row->>'conv1')::numeric end;
   v_conv2:=case when v_unit3 is null then null else (v_row->>'conv2')::numeric end;
   if v_unit2 is not null and coalesce(v_conv1,0)<=0 then raise exception 'invalid legacy conv1'; end if;
   if v_unit3 is not null and coalesce(v_conv2,0)<=0 then raise exception 'invalid legacy conv2'; end if;
   v_stock:=coalesce((v_row->>'openingStockSmallest')::numeric,0);
   if v_stock<0 then raise exception 'negative opening stock not permitted'; end if;

   insert into items(tenant_id,name,unit1,unit2,unit3,conv1,conv2,tax_rate_bp,is_active,client_id)
   values(v_tenant,btrim(v_row->>'name'),v_unit1,v_unit2,v_unit3,v_conv1,v_conv2,
          greatest(0,least(10000,coalesce((v_row->>'taxRateBp')::integer,0))),
          coalesce((v_row->>'isActive')::boolean,true),'legacy:item:'||v_legacy_id)
   returning id into v_item_id;
   v_items_count:=v_items_count+1;

   if jsonb_typeof(coalesce(v_row->'prices','[]'::jsonb))<>'array' then raise exception 'invalid legacy prices'; end if;
   for v_price in select value from jsonb_array_elements(coalesce(v_row->'prices','[]'::jsonb)) loop
     v_kind:=v_price->>'kind';
     v_level:=(v_price->>'unitLevel')::integer;
     v_price_paise:=(v_price->>'pricePaise')::bigint;
     if v_kind not in ('retail','wholesale') or v_level not between 1 and 3 or v_price_paise<=0 then raise exception 'invalid legacy price'; end if;
     if v_level=2 and v_unit2 is null then raise exception 'price tier unavailable';
     elsif v_level=3 and v_unit3 is null then raise exception 'price tier unavailable'; end if;
     insert into item_prices(tenant_id,item_id,shop_id,kind,unit_level,price_paise,effective_from,client_id)
     values(v_tenant,v_item_id,p_shop_id,v_kind,v_level,v_price_paise,v_source_exported_at,
            'legacy:price:'||v_legacy_id||':'||v_kind||':'||v_level::text);
     v_prices_count:=v_prices_count+1;
   end loop;

   if v_stock>0 then
     insert into stock_movements(tenant_id,shop_id,item_id,source_type,source_id,qty_base,client_id)
     values(v_tenant,p_shop_id,v_item_id,'ADJUSTMENT',v_item_id,v_stock,'legacy:opening-stock:'||v_legacy_id);
     v_stock_count:=v_stock_count+1;
   end if;
 end loop;

 v_summary:=jsonb_build_object(
   'sourceVersion',v_source_version,
   'exportedAt',v_source_exported_at,
   'items',v_items_count,
   'parties',v_parties_count,
   'customers',v_customers_count,
   'prices',v_prices_count,
   'stockRows',v_stock_count
 );
 insert into legacy_import_runs(tenant_id,shop_id,source_exported_at,source_version,summary,client_id)
 values(v_tenant,p_shop_id,v_source_exported_at,v_source_version,v_summary,p_client_id);
 return v_summary;
exception when unique_violation then
 select summary into v_existing from legacy_import_runs
  where tenant_id=v_tenant and (client_id=p_client_id or (shop_id=p_shop_id and source_exported_at=v_source_exported_at))
  order by created_at limit 1;
 if v_existing is not null then return v_existing; end if;
 raise;
end $$;

revoke all on function import_legacy_dsb_master(uuid,jsonb,text) from public;
grant execute on function import_legacy_dsb_master(uuid,jsonb,text) to authenticated;
