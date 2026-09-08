-- Hotfix: Phase 3 purchase stock conversion must use the same unit semantics as
-- packages/core and legacy DSB: unit1=big, unit2=small, unit3=piece.
-- Stock movements are always stored in the smallest available unit.

create or replace function post_purchase(
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
  if v_level=1 then
    v_base:=v_qty * coalesce(v_item.conv1,1) * coalesce(v_item.conv2,1);
  elsif v_level=2 and v_item.unit2 is not null then
    v_base:=v_qty * coalesce(v_item.conv2,1);
  elsif v_level=3 and v_item.unit3 is not null then
    v_base:=v_qty;
  else
    raise exception 'unit tier unavailable';
  end if;
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
  if v_level=1 then v_base:=v_qty*coalesce(v_item.conv1,1)*coalesce(v_item.conv2,1);
  elsif v_level=2 then v_base:=v_qty*coalesce(v_item.conv2,1);
  else v_base:=v_qty; end if;
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

revoke all on function post_purchase(uuid,uuid,text,date,bigint,bigint,text,jsonb,text) from public;
grant execute on function post_purchase(uuid,uuid,text,date,bigint,bigint,text,jsonb,text) to authenticated;
