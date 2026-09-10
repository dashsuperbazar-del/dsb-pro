-- Stream bounded pages so constrained links can commit progressive cache
-- updates. The cursor loop still drains every row; only transfer granularity
-- changes, while the 10,000-item/60-second acceptance gate remains unchanged.

create or replace function phase5_sync_pull(
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
    order by i.updated_at,i.id limit 1000
  ) q;

  select coalesce(jsonb_agg(to_jsonb(q) order by q.updated_at,q.id),'[]'::jsonb) into v_barcodes
  from (
    select b.id,b.tenant_id,b.item_id,b.barcode,b.unit_level,b.updated_at,b.deleted_at
    from item_barcodes b
    where b.tenant_id=v_tenant and b.updated_at<=v_cutoff
      and (b.updated_at>bu or (b.updated_at=bu and b.id::text>bi))
    order by b.updated_at,b.id limit 1000
  ) q;

  select coalesce(jsonb_agg(to_jsonb(q) order by q.updated_at,q.id),'[]'::jsonb) into v_prices
  from (
    select p.id,p.tenant_id,p.item_id,p.shop_id,p.kind,p.unit_level,p.price_paise,
      p.effective_from,p.effective_to,p.updated_at,p.deleted_at
    from item_prices p
    where p.tenant_id=v_tenant and p.updated_at<=v_cutoff
      and (p.updated_at>pu or (p.updated_at=pu and p.id::text>pi))
    order by p.updated_at,p.id limit 1000
  ) q;

  select coalesce(jsonb_agg(to_jsonb(q) order by q.updated_at,q.id),'[]'::jsonb) into v_customers
  from (
    select c.id,c.tenant_id,c.name,c.phone,c.address,c.gstin,c.credit_limit_paise,c.notes,c.updated_at,c.deleted_at
    from customers c
    where c.tenant_id=v_tenant and c.updated_at<=v_cutoff
      and (c.updated_at>cu or (c.updated_at=cu and c.id::text>ci))
    order by c.updated_at,c.id limit 1000
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
    order by s.updated_at,s.item_id limit 1000
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
