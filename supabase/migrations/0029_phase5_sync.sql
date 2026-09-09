-- Phase 5 — offline-first sync contract.
-- The server remains authoritative for financial posting. Devices may queue
-- locally, but every sync push is revalidated against current permissions,
-- device revocation, prices and stock before it becomes an official document.

alter table devices
  add column sync_cursors jsonb not null default '{}'::jsonb,
  add column schema_version integer not null default 1 check(schema_version>0),
  add column last_sync_at timestamptz;

create table sync_conflicts(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  device_row_id uuid not null references devices(id),
  op_client_id text,
  kind text not null,
  target text not null,
  reason text not null,
  payload jsonb,
  server_ref jsonb,
  status text not null default 'OPEN' check(status in ('OPEN','RESOLVED')),
  resolved_at timestamptz,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at bigint not null default 0,
  deleted_at bigint,
  client_id text not null,
  unique(tenant_id,client_id)
);
create index sync_conflicts_tenant_status_idx on sync_conflicts(tenant_id,status,created_at desc);
create trigger sync_conflicts_set_updated_at before insert or update on sync_conflicts for each row execute function set_updated_at();
create trigger audit_sync_conflicts after insert or update on sync_conflicts for each row execute function audit_row_change();
alter table sync_conflicts enable row level security;
revoke all on sync_conflicts from anon,authenticated;
grant select on sync_conflicts to authenticated;
create policy sync_conflicts_read on sync_conflicts for select using(
  tenant_id=current_tenant_id() and (created_by=auth.uid() or "current_role"() in ('owner','manager'))
);

create table sync_idempotency_keys(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  operation text not null,
  op_client_id text not null,
  payload jsonb not null,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at bigint not null default 0,
  deleted_at bigint,
  client_id text not null,
  unique(tenant_id,operation,op_client_id),
  unique(tenant_id,client_id)
);
create trigger sync_idempotency_keys_set_updated_at before insert or update on sync_idempotency_keys for each row execute function set_updated_at();
create trigger audit_sync_idempotency_keys after insert on sync_idempotency_keys for each row execute function audit_row_change();
create trigger sync_idempotency_keys_immutable before update or delete on sync_idempotency_keys for each row execute function phase3_immutable();
alter table sync_idempotency_keys enable row level security;
revoke all on sync_idempotency_keys from anon,authenticated;

create function phase5_assert_schema(p_schema_version integer) returns void
language plpgsql immutable security definer set search_path=public as $$
begin
  if p_schema_version<>1 then raise exception 'sync schema update required'; end if;
end $$;
revoke all on function phase5_assert_schema(integer) from public,anon,authenticated;

create function phase5_assert_sync_device(p_device_id text) returns uuid
language plpgsql security definer set search_path=public as $$
declare
  v_tenant uuid:=current_tenant_id();
  v_id uuid;
  v_revoked timestamptz;
begin
  if v_tenant is null then raise exception 'not authenticated'; end if;
  if p_device_id is null or btrim(p_device_id)='' then raise exception 'device id required'; end if;
  if not exists(
    select 1 from tenant_users tu
    where tu.tenant_id=v_tenant and tu.user_id=auth.uid() and tu.status='active' and tu.deleted_at is null
  ) then raise exception 'membership inactive'; end if;
  select d.id,d.revoked_at into v_id,v_revoked
  from devices d
  where d.tenant_id=v_tenant and d.user_id=auth.uid() and d.device_id=p_device_id
  for update;
  if v_id is null then raise exception 'device not registered'; end if;
  if v_revoked is not null then raise exception 'device revoked'; end if;
  update devices set last_seen=now() where id=v_id;
  return v_id;
end $$;
revoke all on function phase5_assert_sync_device(text) from public,anon,authenticated;

create function phase5_sync_pull(
  p_device_id text,p_shop_id uuid,p_schema_version integer,p_cursors jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  v_tenant uuid;
  v_cutoff bigint:=(extract(epoch from (clock_timestamp()-interval '1 second'))*1000)::bigint;
  v_server_now bigint:=(extract(epoch from clock_timestamp())*1000)::bigint;
  v_settings jsonb;
  v_items jsonb; v_barcodes jsonb; v_prices jsonb; v_customers jsonb; v_stock jsonb;
  iu bigint:=coalesce(nullif(p_cursors#>>'{items,updatedAt}','')::bigint,0);
  ii text:=coalesce(p_cursors#>>'{items,id}','');
  bu bigint:=coalesce(nullif(p_cursors#>>'{barcodes,updatedAt}','')::bigint,0);
  bi text:=coalesce(p_cursors#>>'{barcodes,id}','');
  pu bigint:=coalesce(nullif(p_cursors#>>'{prices,updatedAt}','')::bigint,0);
  pi text:=coalesce(p_cursors#>>'{prices,id}','');
  cu bigint:=coalesce(nullif(p_cursors#>>'{customers,updatedAt}','')::bigint,0);
  ci text:=coalesce(p_cursors#>>'{customers,id}','');
  su bigint:=coalesce(nullif(p_cursors#>>'{stock,updatedAt}','')::bigint,0);
  si text:=coalesce(p_cursors#>>'{stock,id}','');
begin
  perform phase5_assert_schema(p_schema_version);
  perform phase5_assert_sync_device(p_device_id);
  v_tenant:=phase3_assert_shop(p_shop_id);
  select settings into v_settings from tenants where id=v_tenant;

  select coalesce(jsonb_agg(to_jsonb(q) order by q.updated_at,q.id),'[]'::jsonb) into v_items
  from (
    select i.id,i.tenant_id,i.name,i.sku,i.unit1,i.unit2,i.unit3,
      i.conv1::double precision conv1,i.conv2::double precision conv2,i.tax_rate_bp,
      i.min_stock::double precision min_stock,i.image_path,i.is_active,i.updated_at,i.deleted_at
    from items i
    where i.tenant_id=v_tenant and i.updated_at<=v_cutoff
      and (i.updated_at>iu or (i.updated_at=iu and i.id::text>ii))
    order by i.updated_at,i.id limit 5000
  ) q;

  select coalesce(jsonb_agg(to_jsonb(q) order by q.updated_at,q.id),'[]'::jsonb) into v_barcodes
  from (
    select b.id,b.tenant_id,b.item_id,b.barcode,b.unit_level,b.updated_at,b.deleted_at
    from item_barcodes b
    where b.tenant_id=v_tenant and b.updated_at<=v_cutoff
      and (b.updated_at>bu or (b.updated_at=bu and b.id::text>bi))
    order by b.updated_at,b.id limit 5000
  ) q;

  select coalesce(jsonb_agg(to_jsonb(q) order by q.updated_at,q.id),'[]'::jsonb) into v_prices
  from (
    select p.id,p.tenant_id,p.item_id,p.shop_id,p.kind,p.unit_level,p.price_paise,
      p.effective_from,p.effective_to,p.updated_at,p.deleted_at
    from item_prices p
    where p.tenant_id=v_tenant and p.updated_at<=v_cutoff
      and (p.updated_at>pu or (p.updated_at=pu and p.id::text>pi))
    order by p.updated_at,p.id limit 10000
  ) q;

  select coalesce(jsonb_agg(to_jsonb(q) order by q.updated_at,q.id),'[]'::jsonb) into v_customers
  from (
    select c.id,c.tenant_id,c.name,c.phone,c.address,c.gstin,c.credit_limit_paise,c.notes,c.updated_at,c.deleted_at
    from customers c
    where c.tenant_id=v_tenant and c.updated_at<=v_cutoff
      and (c.updated_at>cu or (c.updated_at=cu and c.id::text>ci))
    order by c.updated_at,c.id limit 5000
  ) q;

  select coalesce(jsonb_agg(to_jsonb(q) order by q.updated_at,q.id),'[]'::jsonb) into v_stock
  from (
    select (s.shop_id::text||':'||s.item_id::text) id,(s.shop_id::text||':'||s.item_id::text) key,
      s.tenant_id,s.shop_id,s.item_id,s.on_hand::double precision on_hand,
      s.reserved::double precision reserved,s.available::double precision available,
      s.qty_base::double precision qty_base,s.updated_at,null::bigint deleted_at
    from stock_current s
    where s.tenant_id=v_tenant and s.shop_id=p_shop_id and s.updated_at<=v_cutoff
      and (s.updated_at>su or (s.updated_at=su and (s.shop_id::text||':'||s.item_id::text)>si))
    order by s.updated_at,s.item_id limit 5000
  ) q;

  return jsonb_build_object(
    'schemaVersion',1,'serverNowMs',v_server_now,'cutoffMs',v_cutoff,
    'businessDate',shop_business_date(p_shop_id),
    'policy',jsonb_build_object('allowCashierOfflineFinalization',
      case when jsonb_typeof(v_settings->'allow_cashier_offline_finalization')='boolean'
        then (v_settings->>'allow_cashier_offline_finalization')::boolean else false end),
    'items',v_items,'barcodes',v_barcodes,'prices',v_prices,'customers',v_customers,'stock',v_stock
  );
end $$;
revoke all on function phase5_sync_pull(text,uuid,integer,jsonb) from public,anon;
grant execute on function phase5_sync_pull(text,uuid,integer,jsonb) to authenticated;

create function phase5_sync_ack(p_device_id text,p_schema_version integer,p_cursors jsonb) returns void
language plpgsql security definer set search_path=public as $$
declare v_device uuid;
begin
  perform phase5_assert_schema(p_schema_version);
  v_device:=phase5_assert_sync_device(p_device_id);
  if p_cursors is null or jsonb_typeof(p_cursors)<>'object' then raise exception 'sync cursors must be an object'; end if;
  update devices set sync_cursors=p_cursors,schema_version=p_schema_version,last_sync_at=now() where id=v_device;
end $$;
revoke all on function phase5_sync_ack(text,integer,jsonb) from public,anon;
grant execute on function phase5_sync_ack(text,integer,jsonb) to authenticated;

create function phase5_sync_post_sale(
  p_device_id text,p_schema_version integer,
  p_shop_id uuid,p_customer_id uuid,p_business_date date,p_discount_paise bigint,p_extra_charges_paise bigint,
  p_client_id text,p_lines jsonb,p_payments jsonb default '[]'::jsonb,p_notes text default null
) returns jsonb
language plpgsql security definer set search_path=public as $
declare
  v_sale uuid; v_doc text; v_stock jsonb; v_existing_payload jsonb;
  v_request jsonb:=jsonb_build_object(
    'shop_id',p_shop_id,'customer_id',p_customer_id,'business_date',p_business_date,
    'discount_paise',p_discount_paise,'extra_charges_paise',p_extra_charges_paise,
    'lines',coalesce(p_lines,'[]'::jsonb),'payments',coalesce(p_payments,'[]'::jsonb),'notes',p_notes
  );
begin
  perform phase5_assert_schema(p_schema_version);
  perform phase5_assert_sync_device(p_device_id);
  insert into sync_idempotency_keys(tenant_id,operation,op_client_id,payload,client_id)
  values(current_tenant_id(),'post_sale',p_client_id,v_request,'post_sale:'||p_client_id)
  on conflict(tenant_id,operation,op_client_id) do nothing;
  select payload into v_existing_payload from sync_idempotency_keys
    where tenant_id=current_tenant_id() and operation='post_sale' and op_client_id=p_client_id;
  if v_existing_payload is distinct from v_request then
    raise exception 'client_id payload mismatch';
  end if;
  v_sale:=post_sale(p_shop_id,p_customer_id,p_business_date,p_discount_paise,p_extra_charges_paise,p_client_id,p_lines,p_payments,p_notes);
  select doc_no into v_doc from sale_invoices where id=v_sale and tenant_id=current_tenant_id();
  select coalesce(jsonb_agg(to_jsonb(q) order by q.item_id),'[]'::jsonb) into v_stock
  from (
    select (s.shop_id::text||':'||s.item_id::text) id,(s.shop_id::text||':'||s.item_id::text) key,
      s.tenant_id,s.shop_id,s.item_id,s.on_hand::double precision on_hand,
      s.reserved::double precision reserved,s.available::double precision available,
      s.qty_base::double precision qty_base,s.updated_at,null::bigint deleted_at
    from stock_current s
    where s.tenant_id=current_tenant_id() and s.shop_id=p_shop_id
      and s.item_id in (select sii.item_id from sale_invoice_items sii where sii.sale_invoice_id=v_sale)
  ) q;
  return jsonb_build_object('saleId',v_sale,'docNo',v_doc,'stock',v_stock);
end $$;
revoke all on function phase5_sync_post_sale(text,integer,uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text) from public,anon;
grant execute on function phase5_sync_post_sale(text,integer,uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text) to authenticated;

create function phase5_set_offline_finalization_policy(p_allow_cashier boolean)
returns boolean language plpgsql security definer set search_path=public as $$
begin
  if "current_role"()<>'owner' then raise exception 'owner required'; end if;
  update tenants set settings=jsonb_set(settings,'{allow_cashier_offline_finalization}',to_jsonb(p_allow_cashier),true)
  where id=current_tenant_id() and deleted_at is null;
  if not found then raise exception 'tenant not found'; end if;
  return p_allow_cashier;
end $$;
revoke all on function phase5_set_offline_finalization_policy(boolean) from public,anon;
grant execute on function phase5_set_offline_finalization_policy(boolean) to authenticated;

create function phase5_record_sync_conflict(
  p_device_id text,p_schema_version integer,p_op_client_id text,p_kind text,p_target text,p_reason text,
  p_payload jsonb,p_server_ref jsonb,p_client_id text
) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_device uuid; v_id uuid;
begin
  perform phase5_assert_schema(p_schema_version);
  v_device:=phase5_assert_sync_device(p_device_id);
  if p_reason is null or btrim(p_reason)='' then raise exception 'reason required'; end if;
  insert into sync_conflicts(tenant_id,device_row_id,op_client_id,kind,target,reason,payload,server_ref,client_id)
  values(current_tenant_id(),v_device,p_op_client_id,coalesce(nullif(btrim(p_kind),''),'unknown'),
    coalesce(nullif(btrim(p_target),''),'unknown'),p_reason,p_payload,p_server_ref,p_client_id)
  returning id into v_id;
  return v_id;
exception when unique_violation then
  select id into v_id from sync_conflicts where tenant_id=current_tenant_id() and client_id=p_client_id;
  if v_id is not null then return v_id; end if;
  raise;
end $$;
revoke all on function phase5_record_sync_conflict(text,integer,text,text,text,text,jsonb,jsonb,text) from public,anon;
grant execute on function phase5_record_sync_conflict(text,integer,text,text,text,text,jsonb,jsonb,text) to authenticated;

create function phase5_resolve_sync_conflict(p_device_id text,p_schema_version integer,p_id uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  perform phase5_assert_schema(p_schema_version);
  perform phase5_assert_sync_device(p_device_id);
  update sync_conflicts set status='RESOLVED',resolved_at=now()
  where id=p_id and tenant_id=current_tenant_id()
    and (created_by=auth.uid() or "current_role"() in ('owner','manager')) and status='OPEN';
  if not found then raise exception 'conflict not found or not permitted'; end if;
end $$;
revoke all on function phase5_resolve_sync_conflict(text,integer,uuid) from public,anon;
grant execute on function phase5_resolve_sync_conflict(text,integer,uuid) to authenticated;
