-- Packet C3b (group c3b): post_purchase retries are verified, not trusted.
-- Before: a retry with an existing client_id returned the stored bill whatever the payload said, so
-- a client that edited its cart after a lost response was told its NEW lines were posted while the
-- OLD bill stood (silent stock/payable mismatch). Now the stored bill is compared field by field
-- (shop, party, bill no, date when given, discount, extra charges, every line in order); any
-- difference raises DSB_PAYLOAD_MISMATCH and nothing is posted. This needs no request row, so it
-- covers purchases committed before this migration too. Same signature, grants and C0 lock order.
create or replace function post_purchase(
 p_shop_id uuid,p_party_id uuid,p_bill_no text,p_business_date date,p_discount_paise bigint,p_extra_charges_paise bigint,
 p_client_id text,p_lines jsonb,p_bill_image_path text default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_bill purchase_bills%rowtype; v_stored jsonb; v_given jsonb;
begin
 if not has_perm('POST_PURCHASES') then raise exception 'not permitted'; end if;
 v_tenant:=phase3_assert_shop(p_shop_id);
 perform dsb_lock_shop_finance(v_tenant,p_shop_id);
 if p_client_id is not null and btrim(p_client_id)<>'' then
   perform pg_advisory_xact_lock(hashtextextended(v_tenant::text||':purchase:'||p_client_id,0));
   select * into v_bill from purchase_bills where tenant_id=v_tenant and client_id=p_client_id;
   if found then
     select coalesce(jsonb_agg(jsonb_build_array(i.item_id::text,i.unit_level::int,round(i.qty,6),i.unit_price_paise) order by i.line_no),'[]'::jsonb)
       into v_stored from purchase_bill_items i where i.tenant_id=v_tenant and i.purchase_bill_id=v_bill.id;
     begin
       -- Normalized exactly as the body stores it: unit_level defaults to 1, qty is numeric(18,6).
       select coalesce(jsonb_agg(jsonb_build_array(lower(e->>'item_id'),coalesce((e->>'unit_level')::int,1),round((e->>'qty')::numeric,6),
         (e->>'unit_price_paise')::bigint) order by o),'[]'::jsonb)
         into v_given from jsonb_array_elements(p_lines) with ordinality x(e,o);
     exception when others then v_given:=null;
     end;
     if v_given is null or v_bill.shop_id<>p_shop_id or v_bill.party_id is distinct from p_party_id
        or coalesce(nullif(btrim(v_bill.bill_no),''),'') is distinct from coalesce(nullif(btrim(p_bill_no),''),'')
        or (p_business_date is not null and v_bill.business_date<>p_business_date)
        or v_bill.discount_paise<>coalesce(p_discount_paise,0) or v_bill.extra_charges_paise<>coalesce(p_extra_charges_paise,0)
        or (p_bill_image_path is not null and v_bill.bill_image_path is distinct from p_bill_image_path)
        or v_stored<>v_given then
       raise exception 'DSB_PAYLOAD_MISMATCH: client_id already used for a different purchase';
     end if;
     return v_bill.id;
   end if;
 end if;
 return c0_post_purchase_body(p_shop_id,p_party_id,p_bill_no,p_business_date,p_discount_paise,p_extra_charges_paise,p_client_id,p_lines,p_bill_image_path);
end $$;
