-- DW2b / billdocs: private immutable supplier-bill attachments; one image/PDF per bill.
-- Existing item-image policies must never grant access to cost-bearing supplier documents.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('bill-documents','bill-documents',false,5242880,array['image/webp','image/jpeg','image/png','application/pdf'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

create policy bill_documents_read on storage.objects for select to authenticated
using(bucket_id='bill-documents' and split_part(name,'/',1)=current_tenant_id()::text
 and (has_perm('POST_PURCHASES') or has_perm('VIEW_REPORTS'))
 and exists(select 1 from public.shops s where s.id::text=split_part(name,'/',2)
   and s.tenant_id=current_tenant_id() and c1_shop_visible(s.id)));
create policy bill_documents_insert on storage.objects for insert to authenticated
with check(bucket_id='bill-documents' and split_part(name,'/',1)=current_tenant_id()::text
 and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(webp|jpg|png|pdf)$'
 and has_perm('POST_PURCHASES')
 and exists(select 1 from public.shops s where s.id::text=split_part(name,'/',2)
   and s.tenant_id=current_tenant_id() and c1_shop_visible(s.id)));
-- No UPDATE/DELETE grant for this bucket. Posted originals cannot be replaced or deleted;
-- removing/replacing an unsent attachment only unlinks it from the local draft. Orphan retention
-- cleanup and object-byte backup are separate operator work, not claimed by this migration.

-- Keep the existing signature/grants/C0 shop lock and C3b comparison; validate immutable storage
-- only for new purchases, so an exact retry of an already posted bill stays idempotent.
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
        or (v_bill.bill_image_path is distinct from p_bill_image_path)
        or v_stored<>v_given then
       raise exception 'DSB_PAYLOAD_MISMATCH: client_id already used for a different purchase';
     end if;
     return v_bill.id;
   end if;
 end if;
 if p_bill_image_path is not null then
   if p_bill_image_path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(webp|jpg|png|pdf)$'
      or split_part(p_bill_image_path,'/',1)<>v_tenant::text
      or split_part(p_bill_image_path,'/',2)<>p_shop_id::text
      or split_part(p_bill_image_path,'/',3) is distinct from p_client_id
      or not exists(select 1 from storage.objects o where o.bucket_id='bill-documents' and o.name=p_bill_image_path
         and o.metadata->>'mimetype'=case when right(p_bill_image_path,4)='.pdf' then 'application/pdf'
           when right(p_bill_image_path,4)='.jpg' then 'image/jpeg' when right(p_bill_image_path,4)='.png' then 'image/png' else 'image/webp' end
         and coalesce(o.metadata->>'size','') ~ '^[0-9]+$'
         and case when coalesce(o.metadata->>'size','') ~ '^[0-9]+$' then (o.metadata->>'size')::numeric else 0 end between 1 and 5242880)
   then raise exception 'DSB_BILL_DOCUMENT_INVALID: upload a document for this purchase before posting'; end if;
 end if;
 return c0_post_purchase_body(p_shop_id,p_party_id,p_bill_no,p_business_date,p_discount_paise,p_extra_charges_paise,p_client_id,p_lines,p_bill_image_path);
end $$;
