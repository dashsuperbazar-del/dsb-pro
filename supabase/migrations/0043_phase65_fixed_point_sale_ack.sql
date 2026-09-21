-- Batch B: enforce the six-decimal sale quantity contract at the server and
-- return the posted invoice as the authoritative offline acknowledgement.
-- The RPC signature remains unchanged for rolling compatibility.
set local search_path = public, pg_temp;

create function phase65_assert_quantity_lines(p_lines jsonb) returns void
language plpgsql immutable set search_path=public as $$
begin
  if p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then
    raise exception 'financial document requires lines';
  end if;
  if exists(
    select 1 from jsonb_array_elements(p_lines) line
    where case
      when coalesce(line->>'qty','') ~ '^[0-9]+([.][0-9]{1,6})?$' then (line->>'qty')::numeric <= 0
      else true
    end
  ) then raise exception 'quantity must be a positive plain decimal with at most 6 places'; end if;
end $$;
revoke all on function phase65_assert_quantity_lines(jsonb) from public,anon,authenticated;

-- Preserve exact retries before applying the stricter new-input contract.
-- This is important for an acknowledgement lost before the Batch B rollout.
create or replace function post_sale(
  p_shop_id uuid,p_customer_id uuid,p_business_date date,p_discount_paise bigint,p_extra_charges_paise bigint,
  p_client_id text,p_lines jsonb,p_payments jsonb default '[]'::jsonb,p_notes text default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_existing uuid;
begin
  if p_client_id is null or btrim(p_client_id)='' then raise exception 'client_id required'; end if;
  if not has_perm('POST_SALES') then raise exception 'not permitted'; end if;
  v_tenant:=phase3_assert_shop(p_shop_id);
  perform pg_advisory_xact_lock(hashtextextended(v_tenant::text||':sale:'||p_client_id,0));
  select id into v_existing from sale_invoices where tenant_id=v_tenant and client_id=p_client_id;
  if v_existing is not null then
    return phase4_post_sale_unlocked(p_shop_id,p_customer_id,p_business_date,p_discount_paise,p_extra_charges_paise,p_client_id,p_lines,p_payments,p_notes);
  end if;
  perform phase65_assert_quantity_lines(p_lines);
  return phase4_post_sale_unlocked(p_shop_id,p_customer_id,p_business_date,p_discount_paise,p_extra_charges_paise,p_client_id,p_lines,p_payments,p_notes);
end $$;
revoke all on function post_sale(uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text) from public;
grant execute on function post_sale(uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text) to authenticated;

alter function post_purchase(uuid,uuid,text,date,bigint,bigint,text,jsonb,text)
rename to phase65_post_purchase_unlocked;
revoke all on function phase65_post_purchase_unlocked(uuid,uuid,text,date,bigint,bigint,text,jsonb,text) from public,anon,authenticated;
create function post_purchase(
  p_shop_id uuid,p_party_id uuid,p_bill_no text,p_business_date date,
  p_discount_paise bigint,p_extra_charges_paise bigint,p_client_id text,p_lines jsonb,p_bill_image_path text default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_existing uuid;
begin
  if p_client_id is null or btrim(p_client_id)='' then raise exception 'client_id required'; end if;
  if not has_perm('POST_PURCHASES') then raise exception 'not permitted'; end if;
  v_tenant:=phase3_assert_shop(p_shop_id);
  perform pg_advisory_xact_lock(hashtextextended(v_tenant::text||':purchase:'||p_client_id,0));
  select id into v_existing from purchase_bills where tenant_id=v_tenant and client_id=p_client_id;
  if v_existing is null then perform phase65_assert_quantity_lines(p_lines); end if;
  return phase65_post_purchase_unlocked(p_shop_id,p_party_id,p_bill_no,p_business_date,p_discount_paise,p_extra_charges_paise,p_client_id,p_lines,p_bill_image_path);
end $$;
revoke all on function post_purchase(uuid,uuid,text,date,bigint,bigint,text,jsonb,text) from public;
grant execute on function post_purchase(uuid,uuid,text,date,bigint,bigint,text,jsonb,text) to authenticated;

alter function post_return(text,uuid,date,text,jsonb,text)
rename to phase65_post_return_unlocked;
revoke all on function phase65_post_return_unlocked(text,uuid,date,text,jsonb,text) from public,anon,authenticated;
create function post_return(
  p_return_type text,p_source_id uuid,p_business_date date,p_client_id text,p_lines jsonb,p_notes text default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_type text:=upper(btrim(coalesce(p_return_type,''))); v_existing boolean;
begin
  if v_tenant is null then raise exception 'not authenticated'; end if;
  if v_type not in ('SALE','PURCHASE') then raise exception 'return type must be SALE or PURCHASE'; end if;
  if p_client_id is null or btrim(p_client_id)='' then raise exception 'client_id required'; end if;
  if v_type='SALE' and not has_perm('POST_SALES') then raise exception 'not permitted'; end if;
  if v_type='PURCHASE' and not has_perm('POST_PURCHASES') then raise exception 'not permitted'; end if;
  select exists(select 1 from sale_returns where tenant_id=v_tenant and client_id=p_client_id)
      or exists(select 1 from purchase_returns where tenant_id=v_tenant and client_id=p_client_id)
    into v_existing;
  if not v_existing then perform phase65_assert_quantity_lines(p_lines); end if;
  return phase65_post_return_unlocked(p_return_type,p_source_id,p_business_date,p_client_id,p_lines,p_notes);
end $$;
revoke all on function post_return(text,uuid,date,text,jsonb,text) from public,anon;
grant execute on function post_return(text,uuid,date,text,jsonb,text) to authenticated;

create or replace function phase5_sync_post_sale(
  p_device_id text,p_schema_version integer,
  p_shop_id uuid,p_customer_id uuid,p_business_date date,p_discount_paise bigint,p_extra_charges_paise bigint,
  p_client_id text,p_lines jsonb,p_payments jsonb default '[]'::jsonb,p_notes text default null
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  v_sale uuid; v_doc text; v_stock jsonb; v_existing_payload jsonb;
  v_intent_fingerprint text; v_has_client_fingerprint boolean; v_invoice sale_invoices%rowtype;
  v_lines jsonb; v_authoritative_payments jsonb;
  v_request jsonb:=jsonb_build_object(
    'shop_id',p_shop_id,'customer_id',p_customer_id,'business_date',p_business_date,
    'discount_paise',p_discount_paise,'extra_charges_paise',p_extra_charges_paise,
    'lines',coalesce(p_lines,'[]'::jsonb),'payments',coalesce(p_payments,'[]'::jsonb),'notes',p_notes
  );
begin
  perform phase5_assert_schema(p_schema_version);
  perform phase5_assert_sync_device(p_device_id);
  if p_client_id is null or btrim(p_client_id)='' then raise exception 'client_id required'; end if;
  if p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then
    raise exception 'sale requires lines';
  end if;

  select p_lines->0->>'intent_fingerprint' into v_intent_fingerprint;
  v_has_client_fingerprint:=v_intent_fingerprint is not null;
  if v_intent_fingerprint is null then
    -- Old clients remain postable during the rolling transition. They ignore
    -- the expanded response; only new clients validate the intent checksum.
    v_intent_fingerprint:='legacy:'||md5(v_request::text);
  end if;

  perform pg_advisory_xact_lock(hashtextextended(current_tenant_id()::text||':phase5:post_sale:'||p_client_id,0));
  select payload into v_existing_payload from sync_idempotency_keys
    where tenant_id=current_tenant_id() and operation='post_sale' and op_client_id=p_client_id;

  if v_existing_payload is null then
    -- JSON numbers may arrive in exponent form and JavaScript numbers may have
    -- already lost the operator's decimal intent. Only a plain, positive decimal
    -- with at most six places crosses this financial boundary. Exact retries of
    -- historical events are checked against their stored payload instead.
    if exists(
      select 1 from jsonb_array_elements(p_lines) line
      where case
        when coalesce(line->>'qty','') ~ '^[0-9]+([.][0-9]{1,6})?$' then (line->>'qty')::numeric <= 0
        else true
      end
    ) then raise exception 'quantity must be a positive plain decimal with at most 6 places'; end if;
    if v_has_client_fingerprint and (
      v_intent_fingerprint !~ '^intent-v1:[0-9a-f]{32}$'
      or exists(select 1 from jsonb_array_elements(p_lines) line
                where line->>'intent_fingerprint' is distinct from v_intent_fingerprint)
    ) then raise exception 'invalid sale intent fingerprint'; end if;
    if exists(
      select 1
      from jsonb_array_elements(p_lines) line
      where not (line ? 'expected_unit_price_paise')
         or (line->>'expected_unit_price_paise') is null
         or (line->>'expected_unit_price_paise')::bigint <> phase4_current_price(
           current_tenant_id(),p_shop_id,(line->>'item_id')::uuid,
           coalesce(nullif(line->>'price_kind',''),'retail'),
           coalesce((line->>'unit_level')::int,1)
         )
    ) then raise exception 'offline sale price changed; review required'; end if;
    insert into sync_idempotency_keys(tenant_id,operation,op_client_id,payload,client_id)
    values(current_tenant_id(),'post_sale',p_client_id,v_request,'post_sale:'||p_client_id)
    on conflict(tenant_id,operation,op_client_id) do nothing;
    select payload into v_existing_payload from sync_idempotency_keys
      where tenant_id=current_tenant_id() and operation='post_sale' and op_client_id=p_client_id;
  end if;

  if v_existing_payload is distinct from v_request then raise exception 'client_id payload mismatch'; end if;
  v_sale:=post_sale(p_shop_id,p_customer_id,p_business_date,p_discount_paise,p_extra_charges_paise,p_client_id,p_lines,p_payments,p_notes);
  select * into strict v_invoice from sale_invoices where id=v_sale and tenant_id=current_tenant_id();
  v_doc:=v_invoice.doc_no;

  select coalesce(jsonb_agg(jsonb_build_object(
    'itemId',sii.item_id,'unitLevel',sii.unit_level,'qty',sii.qty::text,'priceKind',sii.price_kind,
    'unitPricePaise',sii.unit_price_paise,'discountPaise',sii.discount_paise,'lineTotalPaise',sii.line_total_paise
  ) order by sii.line_no),'[]'::jsonb) into v_lines
  from sale_invoice_items sii where sii.tenant_id=current_tenant_id() and sii.sale_invoice_id=v_sale;

  select coalesce(jsonb_agg(jsonb_build_object(
    'amountPaise',p.amount_paise,'mode',p.mode,'reference',p.reference
  ) order by p.created_at,p.id),'[]'::jsonb) into v_authoritative_payments
  from payments p where p.tenant_id=current_tenant_id() and p.source_sale_invoice_id=v_sale and p.status='POSTED';

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

  return jsonb_build_object(
    'saleId',v_sale,'docNo',v_doc,'clientId',p_client_id,'intentFingerprint',v_intent_fingerprint,
    'subtotalPaise',v_invoice.subtotal_paise,'discountPaise',v_invoice.discount_paise,
    'extraChargesPaise',v_invoice.extra_charges_paise,'totalPaise',v_invoice.total_paise,
    'lines',v_lines,'payments',v_authoritative_payments,'stock',v_stock
  );
end $$;

revoke all on function phase5_sync_post_sale(text,integer,uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text) from public,anon;
grant execute on function phase5_sync_post_sale(text,integer,uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text) to authenticated;
