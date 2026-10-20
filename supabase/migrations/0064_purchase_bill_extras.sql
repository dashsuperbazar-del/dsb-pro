-- billextras: old-DSB purchase-bill fields the shop uses (bill modal, item card, saveBill).
--  * Payment type credit | cash | upi (owner 2026-10-19: no cheque). A cash/UPI bill is paid in full, as in
--    old DSB, but the balance is never hidden by a flag: the bill AND a full supplier payment (mode = payment
--    type, allocated to the bill) are posted in ONE transaction by post_purchase_v2. Balances still derive only
--    from bills, payments and allocations. A retry or lost-reply replay returns the same bill and payment ids
--    (financial_requests 'purchase.post.v2'; the payment's own request id is derived from the bill id).
--  * Notes (trimmed, 1-500 characters or null; escaped at render only).
--  * Per-line discount % and GST % in basis points. Line total = round_half_up(qty x price x (1-d) x (1+g)),
--    rounded once, exactly; the server recomputes every line and the bill and refuses a client total that
--    differs. A line with GST added carries that rate as its tax_rate_bp_snapshot, so the GST summary (which
--    treats a line total as GST-inclusive at the snapshot rate) stays right. Lines without a GST % keep
--    today's meaning (price as entered, item master rate snapshot).
--  * Named extra charges (purchase_bill_charges); their sum must equal purchase_bills.extra_charges_paise.
--  * Several bill images (purchase_bill_images); the first is also bill_image_path, so every existing reader,
--    viewer and backup reference keeps working, and old bills keep their single bill_image_path.
--  * Round-off (owner decision B, 2026-10-20; old DSB saveBill billTotal = Math.round(rawTotal), every bill):
--    a v2 bill's total is rounded to the nearest rupee, half up, exactly like sales (0051 r0_round_off); the
--    signed adjustment is purchase_bills.round_off_paise (-49..+50, immutable) and total_paise is the rounded
--    total. The client sends its round-off and total; any difference is DSB_TOTAL_MISMATCH. The cash/UPI
--    payment is the rounded total. Like sales, item values stay exact: the GST summary, FIFO landed cost and
--    purchase-return caps use line values (subtotal - discount, + extra charges for cost) and never the
--    round-off, except that the return completing a rounded bill also reverses its round-off (as sales 0053):
--    purchase_returns.round_off_paise, so a fully returned bill nets to zero. v1 and existing bills keep 0.
--  * void_paid_purchase (owner, as voiding a supplier payment is owner-only) voids the auto payment and the
--    bill together. The v1 void_purchase keeps refusing a bill with live allocations.
-- post_purchase (v1) is NOT redefined: its body is an upgrade-classifier anchor (billdocs, partymerge, c3b).

alter table purchase_bills
 add column round_off_paise bigint not null default 0 check(round_off_paise between -49 and 50),
 add column payment_type text not null default 'credit' check(payment_type in ('credit','cash','upi')),
 add column notes text check(notes is null or (char_length(notes) between 1 and 500 and notes=btrim(notes)));

-- Same guard as sale_invoices (0051): the round-off never changes after posting.
create trigger purchase_bills_round_off_immutable before update on purchase_bills
 for each row execute function r0_round_off_immutable();

alter table purchase_bill_items
 add column discount_bp integer not null default 0 check(discount_bp between 0 and 10000),
 add column gst_bp integer check(gst_bp between 0 and 10000),
 add constraint purchase_bill_items_gst_snapshot_check check(gst_bp is null or gst_bp=tax_rate_bp_snapshot);

create table purchase_bill_charges(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 shop_id uuid not null references shops(id),
 purchase_bill_id uuid not null references purchase_bills(id),
 line_no integer not null check(line_no between 1 and 20),
 label text not null check(char_length(label) between 1 and 60 and label=btrim(label)),
 amount_paise bigint not null check(amount_paise>0 and amount_paise<=9007199254740991),
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at bigint not null default 0,
 deleted_at bigint,
 client_id text not null check(char_length(client_id) between 1 and 200),
 unique(purchase_bill_id,line_no),
 unique(tenant_id,client_id)
);
create index purchase_bill_charges_bill_idx on purchase_bill_charges(tenant_id,purchase_bill_id);

create table purchase_bill_images(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 shop_id uuid not null references shops(id),
 purchase_bill_id uuid not null references purchase_bills(id),
 sort_order integer not null check(sort_order between 0 and 9),
 storage_path text not null check(storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(webp|jpg|png|pdf)$'),
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at bigint not null default 0,
 deleted_at bigint,
 client_id text not null check(char_length(client_id) between 1 and 200),
 unique(purchase_bill_id,sort_order),
 unique(tenant_id,storage_path),
 unique(tenant_id,client_id)
);
create index purchase_bill_images_bill_idx on purchase_bill_images(tenant_id,purchase_bill_id);

-- Child rows must belong to their bill's tenant/shop; checked at commit so all rows of a bill are present.
create function bx_purchase_children_check() returns trigger language plpgsql security definer set search_path=public as $$
declare v_bill purchase_bills%rowtype; v_sum numeric;
begin
 select * into v_bill from purchase_bills where id=new.purchase_bill_id;
 if not found or v_bill.tenant_id<>new.tenant_id or v_bill.shop_id<>new.shop_id then
   raise exception 'DSB_BILL_MISMATCH: purchase detail does not belong to its bill';
 end if;
 if tg_table_name='purchase_bill_charges' then
   select coalesce(sum(amount_paise),0) into v_sum from purchase_bill_charges where purchase_bill_id=new.purchase_bill_id;
   if v_sum<>v_bill.extra_charges_paise then
     raise exception 'DSB_CHARGES_MISMATCH: named charges must add up to the bill''s extra charges';
   end if;
 else
   if v_bill.bill_image_path is distinct from
      (select storage_path from purchase_bill_images where purchase_bill_id=new.purchase_bill_id and sort_order=0) then
     raise exception 'DSB_BILL_DOCUMENT_INVALID: the first bill image must be the bill''s document';
   end if;
 end if;
 return null;
end $$;

create constraint trigger purchase_bill_charges_check after insert on purchase_bill_charges
 deferrable initially deferred for each row execute function bx_purchase_children_check();
create constraint trigger purchase_bill_images_check after insert on purchase_bill_images
 deferrable initially deferred for each row execute function bx_purchase_children_check();
create trigger purchase_bill_charges_set_updated_at before insert or update on purchase_bill_charges
 for each row execute function set_updated_at();
create trigger purchase_bill_images_set_updated_at before insert or update on purchase_bill_images
 for each row execute function set_updated_at();
create trigger purchase_bill_charges_immutable before update or delete on purchase_bill_charges
 for each row execute function phase3_immutable();
create trigger purchase_bill_images_immutable before update or delete on purchase_bill_images
 for each row execute function phase3_immutable();
create trigger audit_purchase_bill_charges after insert on purchase_bill_charges
 for each row execute function audit_row_change();
create trigger audit_purchase_bill_images after insert on purchase_bill_images
 for each row execute function audit_row_change();

alter table purchase_bill_charges enable row level security;
alter table purchase_bill_images enable row level security;
create policy purchase_bill_charges_read on purchase_bill_charges for select using(
 tenant_id=current_tenant_id() and c1_shop_visible(shop_id)
 and (has_perm('POST_PURCHASES') or has_perm('VIEW_REPORTS')));
create policy purchase_bill_images_read on purchase_bill_images for select using(
 tenant_id=current_tenant_id() and c1_shop_visible(shop_id)
 and (has_perm('POST_PURCHASES') or has_perm('VIEW_REPORTS')));
revoke all on purchase_bill_charges,purchase_bill_images from public,anon,authenticated;
grant select on purchase_bill_charges,purchase_bill_images to authenticated;
do $$
begin
 if exists (select 1 from pg_roles where rolname='backup_ro') then
   grant select on purchase_bill_charges,purchase_bill_images to backup_ro;
 end if;
end $$;

alter table financial_requests drop constraint financial_requests_operation_check;
alter table financial_requests add constraint financial_requests_operation_check check(operation in (
  'supplier.record.v1','supplier.allocate.v1','supplier.void.v1','supplier.release.v1',
  'record_customer_payment_v2','allocate_customer_payment_v2','customer.record.legacy-v1',
  'purchase.post.v2','purchase.void_paid.v1'));

-- One exact rounding per line, half up, in pure integer arithmetic (no numeric division before rounding:
-- numeric division keeps ~16 significant digits and would misround large quantities). With qty in
-- millionths: N = qty_micros*price*(10000-d)*(10000+g), D = 10^14, total = floor((2N+D)/(2D)).
-- packages/core/src/purchaseBill.ts mirrors this exactly with BigInt.
create function bx_purchase_line_total(p_qty numeric,p_price bigint,p_discount_bp integer,p_gst_bp integer)
returns bigint language sql immutable set search_path=public as $$
 select div(2*round(p_qty*1000000)*p_price*(10000-p_discount_bp)*(10000+coalesce(p_gst_bp,0))+100000000000000,
   200000000000000)::bigint
$$;

create function post_purchase_v2(p_shop_id uuid,p_client_id text,p_bill jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
 v_tenant uuid; v_req uuid; v_client text; v_request jsonb; v_prev jsonb;
 v_party uuid; v_bill_no text; v_date date; v_given_date date; v_discount bigint; v_type text; v_notes text; v_expected bigint; v_round_given bigint; v_round bigint; v_before numeric;
 v_lines jsonb:='[]'::jsonb; v_charges jsonb:='[]'::jsonb; v_images jsonb:='[]'::jsonb;
 v_e jsonb; v_o bigint; v_qty numeric; v_level int; v_price bigint; v_disc int; v_gst int; v_lt bigint; v_given_lt bigint;
 v_item items%rowtype; v_base numeric; v_subtotal numeric:=0; v_extra numeric:=0; v_total numeric;
 v_bill uuid; v_path text; v_payment uuid; v_result jsonb; v_today date; v_label text; v_amount bigint;
begin
 if not has_perm('POST_PURCHASES') then raise exception 'not permitted'; end if;
 v_req:=c1_assert_request_uuid(p_client_id);
 if p_client_id<>v_req::text then raise exception 'DSB_INVALID_REQUEST_ID: client_id must be a lower-case request UUID'; end if;
 v_client:=v_req::text;
 v_tenant:=phase3_assert_shop(p_shop_id);
 if p_bill is null or jsonb_typeof(p_bill)<>'object' then raise exception 'DSB_INVALID_PURCHASE: bill required'; end if;

 -- Canonical request (what a retry must repeat exactly).
 v_party:=nullif(p_bill->>'party_id','')::uuid;
 v_bill_no:=nullif(btrim(coalesce(p_bill->>'bill_no','')),'');
 v_given_date:=nullif(p_bill->>'business_date','')::date;
 v_discount:=coalesce((p_bill->>'discount_paise')::bigint,0);
 v_type:=coalesce(p_bill->>'payment_type','credit');
 v_notes:=nullif(btrim(coalesce(p_bill->>'notes','')),'');
 v_expected:=(p_bill->>'total_paise')::bigint;
 v_round_given:=(p_bill->>'round_off_paise')::bigint;
 if v_type not in ('credit','cash','upi') then raise exception 'DSB_INVALID_PAYMENT_TYPE: payment type must be credit, cash or upi'; end if;
 if v_notes is not null and char_length(v_notes)>500 then raise exception 'DSB_INVALID_NOTES: notes are limited to 500 characters'; end if;
 if v_bill_no is not null and char_length(v_bill_no)>100 then raise exception 'DSB_INVALID_PURCHASE: bill number too long'; end if;
 if v_expected is null or v_round_given is null then
   raise exception 'DSB_TOTAL_MISMATCH: the bill total and its round-off are required';
 end if;
 if v_discount<0 then raise exception 'negative adjustment'; end if;
 perform phase65_assert_quantity_lines(p_bill->'lines');
 if jsonb_array_length(p_bill->'lines')>200 then raise exception 'DSB_INVALID_PURCHASE: at most 200 lines'; end if;
 for v_e,v_o in select value,ordinality from jsonb_array_elements(p_bill->'lines') with ordinality loop
   if jsonb_typeof(v_e)<>'object' or (v_e->>'line_total_paise') is null then
     raise exception 'DSB_TOTAL_MISMATCH: every line needs its total';
   end if;
   v_lines:=v_lines||jsonb_build_array(jsonb_build_array(lower(v_e->>'item_id'),coalesce((v_e->>'unit_level')::int,1),
     round((v_e->>'qty')::numeric,6)::text,(v_e->>'unit_price_paise')::bigint,coalesce((v_e->>'discount_bp')::int,0),
     (v_e->>'gst_bp')::int,(v_e->>'line_total_paise')::bigint));
 end loop;
 if p_bill->'charges' is not null and jsonb_typeof(p_bill->'charges')<>'null' then
   if jsonb_typeof(p_bill->'charges')<>'array' or jsonb_array_length(p_bill->'charges')>20 then
     raise exception 'DSB_INVALID_CHARGES: at most 20 named charges';
   end if;
   for v_e in select value from jsonb_array_elements(p_bill->'charges') loop
     v_label:=btrim(coalesce(v_e->>'label',''));
     v_amount:=(v_e->>'amount_paise')::bigint;
     if char_length(v_label) not between 1 and 60 then raise exception 'DSB_INVALID_CHARGES: each charge needs a name (up to 60 characters)'; end if;
     if v_amount is null or v_amount<=0 then raise exception 'DSB_INVALID_CHARGES: each charge needs a positive amount'; end if;
     perform dsb_assert_safe_paise(v_amount);
     v_charges:=v_charges||jsonb_build_array(jsonb_build_array(v_label,v_amount));
     v_extra:=v_extra+v_amount;
   end loop;
 end if;
 if p_bill->'images' is not null and jsonb_typeof(p_bill->'images')<>'null' then
   if jsonb_typeof(p_bill->'images')<>'array' or jsonb_array_length(p_bill->'images')>10 then
     raise exception 'DSB_BILL_DOCUMENT_INVALID: at most 10 bill images';
   end if;
   for v_e in select value from jsonb_array_elements(p_bill->'images') loop
     if jsonb_typeof(v_e)<>'string' then raise exception 'DSB_BILL_DOCUMENT_INVALID: image paths must be text'; end if;
     if v_images @> jsonb_build_array(v_e) then raise exception 'DSB_BILL_DOCUMENT_INVALID: the same image is attached twice'; end if;
     v_images:=v_images||jsonb_build_array(v_e);
   end loop;
 end if;
 v_request:=jsonb_build_object('shopId',p_shop_id,'partyId',v_party,'billNo',v_bill_no,'businessDate',v_given_date,
   'discountPaise',v_discount::text,'paymentType',v_type,'notes',v_notes,'totalPaise',v_expected::text,'roundOffPaise',v_round_given::text,
   'lines',v_lines,'charges',v_charges,'images',v_images);

 perform dsb_lock_shop_finance(v_tenant,p_shop_id);
 perform pg_advisory_xact_lock(hashtextextended(v_tenant::text||':purchase:'||v_client,0));
 perform dsb_lock_request(v_tenant,'purchase.post.v2',v_client);
 v_prev:=dsb_request_result(v_tenant,p_shop_id,'purchase.post.v2',v_client,v_request);
 if v_prev is not null then return v_prev; end if;
 if exists(select 1 from purchase_bills where tenant_id=v_tenant and client_id=v_client) then
   raise exception 'DSB_PAYLOAD_MISMATCH: client_id already used for a different purchase';
 end if;

 -- New bill: validate everything against current data.
 if v_party is not null and not exists(select 1 from parties where id=v_party and tenant_id=v_tenant and deleted_at is null) then
   raise exception 'party not in tenant';
 end if;
 if v_type<>'credit' and v_party is null then
   raise exception 'DSB_PAYMENT_NEEDS_SUPPLIER: a cash or UPI bill needs a supplier (the payment is recorded against them)';
 end if;
 v_today:=shop_business_date(p_shop_id);
 v_date:=coalesce(v_given_date,v_today);
 if v_type<>'credit' and v_date>v_today then
   raise exception 'DSB_FUTURE_DATE: a paid bill cannot be dated after today';
 end if;
 perform dsb_assert_safe_paise(v_discount);
 for v_e in select value from jsonb_array_elements(v_images) loop
   v_path:=v_e#>>'{}';
   if v_path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(webp|jpg|png|pdf)$'
      or split_part(v_path,'/',1)<>v_tenant::text
      or split_part(v_path,'/',2)<>p_shop_id::text
      or split_part(v_path,'/',3)<>v_client
      or not exists(select 1 from storage.objects o where o.bucket_id='bill-documents' and o.name=v_path
         and o.metadata->>'mimetype'=case when right(v_path,4)='.pdf' then 'application/pdf'
           when right(v_path,4)='.jpg' then 'image/jpeg' when right(v_path,4)='.png' then 'image/png' else 'image/webp' end
         and coalesce(o.metadata->>'size','') ~ '^[0-9]+$'
         and case when coalesce(o.metadata->>'size','') ~ '^[0-9]+$' then (o.metadata->>'size')::numeric else 0 end between 1 and 5242880)
      or exists(select 1 from purchase_bills b where b.tenant_id=v_tenant and b.bill_image_path=v_path)
      or exists(select 1 from purchase_bill_images i where i.tenant_id=v_tenant and i.storage_path=v_path)
   then raise exception 'DSB_BILL_DOCUMENT_INVALID: upload a document for this purchase before posting'; end if;
 end loop;

 for v_e,v_o in select value,ordinality from jsonb_array_elements(v_lines) with ordinality loop
   select * into v_item from items where id=(v_e->>0)::uuid and tenant_id=v_tenant and deleted_at is null for share;
   if not found then raise exception 'item not in tenant'; end if;
   v_level:=(v_e->>1)::int; v_qty:=(v_e->>2)::numeric; v_price:=(v_e->>3)::bigint; v_disc:=(v_e->>4)::int; v_gst:=(v_e->>5)::int;
   v_given_lt:=(v_e->>6)::bigint;
   if v_qty<=0 or v_price<0 or v_level not between 1 and 3 then raise exception 'invalid purchase line'; end if;
   if v_disc not between 0 and 10000 or (v_gst is not null and v_gst not between 0 and 10000) then
     raise exception 'DSB_INVALID_PURCHASE: discount and GST must be between 0%% and 100%%';
   end if;
   perform dsb_assert_safe_paise(v_price);
   if not (v_level=1 or (v_level=2 and v_item.unit2 is not null) or (v_level=3 and v_item.unit3 is not null)) then
     raise exception 'unit tier unavailable';
   end if;
   v_lt:=bx_purchase_line_total(v_qty,v_price,v_disc,v_gst);
   if v_lt<>v_given_lt then
     raise exception 'DSB_TOTAL_MISMATCH: line % total is % paise, not %',v_o,v_lt,v_given_lt;
   end if;
   v_subtotal:=v_subtotal+v_lt;
 end loop;
 v_before:=v_subtotal-v_discount+v_extra;
 if v_before<0 then raise exception 'negative total'; end if;
 if v_subtotal>9007199254740991 or v_extra>9007199254740991 or v_before>9007199254740941 then  -- MAX_SAFE - 50: the rounded total stays safe (same bound in core)
   raise exception 'DSB_AMOUNT_OUT_OF_RANGE: amount out of safe range';
 end if;
 -- Old DSB: the bill rounds to the nearest rupee, half up (same function as sales, 0051).
 v_round:=r0_round_off(v_before::bigint);
 v_total:=v_before+v_round;
 if v_round<>v_round_given or v_total<>v_expected then
   raise exception 'DSB_TOTAL_MISMATCH: bill total is % paise (round-off %), not % (round-off %)',v_total,v_round,v_expected,v_round_given;
 end if;

 insert into purchase_bills(tenant_id,shop_id,party_id,bill_no,business_date,subtotal_paise,discount_paise,extra_charges_paise,
   total_paise,bill_image_path,client_id,payment_type,notes,round_off_paise)
 values(v_tenant,p_shop_id,v_party,v_bill_no,v_date,v_subtotal::bigint,v_discount,v_extra::bigint,v_total::bigint,
   v_images->>0,v_client,v_type,v_notes,v_round)
 returning id into v_bill;
 for v_e,v_o in select value,ordinality from jsonb_array_elements(v_lines) with ordinality loop
   select * into v_item from items where id=(v_e->>0)::uuid and tenant_id=v_tenant;
   v_level:=(v_e->>1)::int; v_qty:=(v_e->>2)::numeric; v_price:=(v_e->>3)::bigint; v_disc:=(v_e->>4)::int; v_gst:=(v_e->>5)::int;
   if v_level=1 then v_base:=v_qty*coalesce(v_item.conv1,1)*coalesce(v_item.conv2,1);
   elsif v_level=2 then v_base:=v_qty*coalesce(v_item.conv2,1);
   else v_base:=v_qty; end if;
   insert into purchase_bill_items(tenant_id,shop_id,purchase_bill_id,item_id,line_no,item_name_snapshot,hsn_snapshot,tax_rate_bp_snapshot,
     unit_name_snapshot,conv1_snapshot,conv2_snapshot,unit_level,qty,base_qty,unit_price_paise,line_total_paise,client_id,discount_bp,gst_bp)
   values(v_tenant,p_shop_id,v_bill,v_item.id,v_o,v_item.name,v_item.hsn,coalesce(v_gst,v_item.tax_rate_bp),
     case v_level when 1 then v_item.unit1 when 2 then v_item.unit2 else v_item.unit3 end,v_item.conv1,v_item.conv2,v_level,v_qty,v_base,v_price,
     bx_purchase_line_total(v_qty,v_price,v_disc,v_gst),v_client||':line:'||v_o::text,v_disc,v_gst);
   insert into stock_movements(tenant_id,shop_id,item_id,source_type,source_id,qty_base,client_id)
   values(v_tenant,p_shop_id,v_item.id,'PURCHASE',v_bill,v_base,v_client||':stock:'||v_o::text);
 end loop;
 for v_e,v_o in select value,ordinality from jsonb_array_elements(v_charges) with ordinality loop
   insert into purchase_bill_charges(tenant_id,shop_id,purchase_bill_id,line_no,label,amount_paise,client_id)
   values(v_tenant,p_shop_id,v_bill,v_o,v_e->>0,(v_e->>1)::bigint,v_client||':charge:'||v_o::text);
 end loop;
 for v_e,v_o in select value,ordinality from jsonb_array_elements(v_images) with ordinality loop
   insert into purchase_bill_images(tenant_id,shop_id,purchase_bill_id,sort_order,storage_path,client_id)
   values(v_tenant,p_shop_id,v_bill,v_o-1,v_e#>>'{}',v_client||':image:'||v_o::text);
 end loop;

 -- Paid at purchase: the full payment, in the same transaction, allocated to this bill. Its request id is
 -- derived from the bill id, so it can exist at most once per bill.
 if v_type<>'credit' and v_total>0 then
   v_payment:=record_supplier_payment(p_shop_id,v_party,v_date,v_total::bigint,v_type,
     left('Paid with purchase bill'||coalesce(' '||v_bill_no,''),200),
     jsonb_build_array(jsonb_build_object('purchase_bill_id',v_bill,'amount_paise',v_total::bigint)),
     md5('dsb.purchase.v2.payment:'||v_bill::text)::uuid::text);
 end if;

 v_result:=jsonb_build_object('billId',v_bill,'paymentId',v_payment,'totalPaise',v_total::bigint::text,
   'roundOffPaise',v_round::text,'businessDate',v_date);
 insert into financial_requests(tenant_id,shop_id,operation,request,result,client_id)
 values(v_tenant,p_shop_id,'purchase.post.v2',v_request,v_result,v_client);
 return v_result;
end $$;

-- Void a cash/UPI bill and its automatic payment together (owner: voiding a supplier payment is owner-only).
create function void_paid_purchase(p_purchase_id uuid,p_reason text,p_client_id text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_req uuid; v_shop uuid; v_request jsonb; v_prev jsonb; v_bill purchase_bills%rowtype;
 v_payment uuid; v_status text; v_result jsonb; v_voided boolean:=false;
begin
 v_req:=c1_assert_request_uuid(p_client_id);
 if v_tenant is null then raise exception 'not authenticated'; end if;
 if coalesce("current_role"(),'')<>'owner' then raise exception 'not permitted'; end if;
 if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
   raise exception 'DSB_INVALID_REASON: reason required (1-500 characters)';
 end if;
 select shop_id into v_shop from purchase_bills where tenant_id=v_tenant and id=p_purchase_id;
 if v_shop is null then raise exception 'purchase not found'; end if;
 perform phase3_assert_shop(v_shop);
 v_request:=jsonb_build_object('purchaseId',p_purchase_id,'reason',btrim(p_reason));
 perform dsb_lock_shop_finance(v_tenant,v_shop);
 perform dsb_lock_request(v_tenant,'purchase.void_paid.v1',v_req::text);
 v_prev:=dsb_request_result(v_tenant,v_shop,'purchase.void_paid.v1',v_req::text,v_request);
 if v_prev is not null then return v_prev; end if;
 select * into v_bill from purchase_bills where tenant_id=v_tenant and id=p_purchase_id for update;
 if v_bill.payment_type='credit' then
   raise exception 'DSB_NOT_PAID_BILL: this is a credit bill; void it with the normal void';
 end if;
 select (result->>'paymentId')::uuid into v_payment from financial_requests
  where tenant_id=v_tenant and operation='purchase.post.v2' and client_id=v_bill.client_id;
 if v_payment is not null then
   select status into v_status from payments where tenant_id=v_tenant and id=v_payment for update;
   if v_status='POSTED' then
     if exists(select 1 from payment_allocations where tenant_id=v_tenant and payment_id=v_payment and status='POSTED'
                 and purchase_bill_id is distinct from v_bill.id) then
       raise exception 'DSB_PAYMENT_REASSIGNED: the bill''s payment is also assigned elsewhere; release that first';
     end if;
     perform void_supplier_payment(v_payment,p_reason,md5('dsb.purchase.v2.void-payment:'||v_req::text)::uuid::text);
     v_voided:=true;
   end if;
 end if;
 perform void_purchase(v_bill.id,'purchase.void_paid.v1:'||v_req::text);
 v_result:=jsonb_build_object('billId',v_bill.id,'paymentId',v_payment,'paymentVoided',v_voided);
 insert into financial_requests(tenant_id,shop_id,operation,request,result,client_id)
 values(v_tenant,v_shop,'purchase.void_paid.v1',v_request,v_result,v_req::text);
 return v_result;
end $$;

-- Outcome reconciliation: a client with an unknown outcome reads the stored answer of its own request.
create or replace function get_financial_request(p_shop_id uuid,p_operation text,p_client_id text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_row financial_requests%rowtype; v_payment uuid; v_status text;
begin
 v_tenant:=phase3_assert_shop(p_shop_id);
 if p_operation in ('supplier.record.v1','supplier.allocate.v1','supplier.void.v1','supplier.release.v1',
                    'purchase.post.v2','purchase.void_paid.v1') then
   if not has_perm('POST_PURCHASES') then raise exception 'not permitted'; end if;
 elsif p_operation in ('record_customer_payment_v2','allocate_customer_payment_v2','customer.record.legacy-v1') then
   if not has_perm('POST_SALES') then raise exception 'not permitted'; end if;
 else
   raise exception 'unknown financial operation';
 end if;
 if p_client_id is null or char_length(p_client_id) not between 1 and 128 then raise exception 'client_id required'; end if;
 perform dsb_lock_request(v_tenant,p_operation,p_client_id);
 select * into v_row from financial_requests
  where tenant_id=v_tenant and operation=p_operation and client_id=p_client_id;
 if not found or v_row.shop_id<>p_shop_id then return jsonb_build_object('state','NOT_FOUND'); end if;
 if p_operation='supplier.release.v1'
    and coalesce(v_row.result->>'allocationId','') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
   select status into v_status from payment_allocations
    where tenant_id=v_tenant and id=(v_row.result->>'allocationId')::uuid;
 elsif coalesce(v_row.result->>'paymentId','') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
   v_payment:=(v_row.result->>'paymentId')::uuid;
   select status into v_status from payments where tenant_id=v_tenant and id=v_payment;
 end if;
 return jsonb_build_object('state','COMMITTED','result',v_row.result,'currentStatus',v_status);
end $$;

-- Purchase return round-off (like sale_returns, 0053): set only by the completing return of a rounded bill.
alter table purchase_returns add column round_off_paise bigint not null default 0
  check (round_off_paise <= 50);

-- Purchase return guard (from 0062), unchanged except: the void path keeps round_off_paise too.
create or replace function phase65_purchase_return_guard() returns trigger language plpgsql as $$
begin
 if dsb_party_merge_move(old,new) then return new; end if;
 if old.status='DRAFT' and new.status='POSTED' and new.posted_at is not null then return new; end if;
 if old.status='POSTED' and new.status='VOID'
    and new.tenant_id=old.tenant_id and new.shop_id=old.shop_id
    and new.purchase_bill_id=old.purchase_bill_id and new.party_id is not distinct from old.party_id
    and new.doc_no=old.doc_no and new.doc_seq=old.doc_seq and new.business_date=old.business_date
    and new.total_paise=old.total_paise and new.round_off_paise=old.round_off_paise and new.notes is not distinct from old.notes
    and new.request_fingerprint=old.request_fingerprint and new.voided_at is not null then return new;
 end if;
 raise exception 'posted purchase return is immutable; use void_return';
end $$;

-- Return body (from 0053), unchanged except the purchase round-off block (sale path untouched).
CREATE OR REPLACE FUNCTION public.phase65_post_return_unlocked(p_return_type text, p_source_id uuid, p_business_date date, p_client_id text, p_lines jsonb, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
 v_tenant uuid:=current_tenant_id(); v_type text:=upper(btrim(coalesce(p_return_type,''))); v_date date;
 v_existing_id uuid; v_existing_source uuid; v_existing_fingerprint text; v_fingerprint text;
 v_sale sale_invoices%rowtype; v_sale_line sale_invoice_items%rowtype; v_sale_return uuid;
 v_purchase purchase_bills%rowtype; v_purchase_line purchase_bill_items%rowtype; v_purchase_return uuid;
 v_line jsonb; v_ord bigint; v_qty numeric; v_base numeric; v_prior_base numeric; v_prior_amount bigint;
 v_cap bigint; v_amount bigint; v_total bigint:=0; v_disposition text; v_seq bigint; v_doc text;
 v_received bigint:=0; v_prior_refunds bigint:=0; v_refund bigint:=0; v_round bigint:=0; v_prior_total bigint; v_remaining bigint;
begin
 if v_tenant is null then raise exception 'not authenticated'; end if;
 if v_type not in ('SALE','PURCHASE') then raise exception 'return type must be SALE or PURCHASE'; end if;
 if p_client_id is null or btrim(p_client_id)='' then raise exception 'client_id required'; end if;
 if p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then raise exception 'return requires lines'; end if;

 perform pg_advisory_xact_lock(hashtextextended(v_tenant::text||':return-client:'||p_client_id,0));

 if v_type='SALE' then
   if not has_perm('POST_SALES') then raise exception 'not permitted'; end if;
   select id,sale_invoice_id,request_fingerprint into v_existing_id,v_existing_source,v_existing_fingerprint
   from sale_returns where tenant_id=v_tenant and client_id=p_client_id;
 else
   if not has_perm('POST_PURCHASES') then raise exception 'not permitted'; end if;
   select id,purchase_bill_id,request_fingerprint into v_existing_id,v_existing_source,v_existing_fingerprint
   from purchase_returns where tenant_id=v_tenant and client_id=p_client_id;
 end if;
 if v_existing_id is null then
   if exists(select 1 from sale_returns where tenant_id=v_tenant and client_id=p_client_id)
      or exists(select 1 from purchase_returns where tenant_id=v_tenant and client_id=p_client_id) then
     raise exception 'client_id already used for another return type';
   end if;
 end if;

 if v_type='SALE' then
   select * into v_sale from sale_invoices where id=p_source_id and tenant_id=v_tenant for update;
   if not found or v_sale.status<>'FINALIZED' then raise exception 'sale unavailable for return'; end if;
   perform phase3_assert_shop(v_sale.shop_id);
   v_date:=coalesce(p_business_date,shop_business_date(v_sale.shop_id));
 else
   select * into v_purchase from purchase_bills where id=p_source_id and tenant_id=v_tenant for update;
   if not found or v_purchase.status<>'POSTED' then raise exception 'purchase unavailable for return'; end if;
   perform phase3_assert_shop(v_purchase.shop_id);
   v_date:=coalesce(p_business_date,shop_business_date(v_purchase.shop_id));
 end if;
 v_fingerprint:=md5(jsonb_build_object('type',v_type,'source',p_source_id,'date',v_date,'lines',p_lines,'notes',p_notes)::text);
 if v_existing_id is not null then
   if v_existing_source<>p_source_id or v_existing_fingerprint<>v_fingerprint then
     raise exception 'client_id already used with different return payload';
   end if;
   return v_existing_id;
 end if;

 -- Serialize every return for the same source document. This protects both
 -- cumulative returned quantities and the paid-amount refund ceiling.
 perform pg_advisory_xact_lock(hashtextextended(v_tenant::text||':'||v_type||'-return:'||p_source_id::text,0));

 if v_type='SALE' then
   v_seq:=next_doc_no(v_sale.shop_id,'SALE_RETURN'); v_doc:='SR-'||lpad(v_seq::text,6,'0');
   insert into sale_returns(tenant_id,shop_id,sale_invoice_id,customer_id,doc_no,doc_seq,business_date,notes,request_fingerprint,client_id)
   values(v_tenant,v_sale.shop_id,v_sale.id,v_sale.customer_id,v_doc,v_seq,v_date,p_notes,v_fingerprint,p_client_id)
   returning id into v_sale_return;

   for v_line,v_ord in select value,ordinality from jsonb_array_elements(p_lines) with ordinality loop
     begin
       v_qty:=(v_line->>'qty')::numeric;
     exception when others then raise exception 'invalid return quantity'; end;
     v_disposition:=upper(btrim(coalesce(v_line->>'disposition','')));
     if v_qty<=0 or v_disposition not in ('RETURN_TO_SELLABLE','DAMAGED','EXPIRED','SUPPLIER_RETURN') then
       raise exception 'invalid sale return line';
     end if;
     select * into v_sale_line from sale_invoice_items
       where id=(v_line->>'sale_invoice_item_id')::uuid and tenant_id=v_tenant and sale_invoice_id=v_sale.id
       for update;
     if not found then raise exception 'sale line unavailable for return'; end if;
     v_base:=v_qty*v_sale_line.base_qty/v_sale_line.qty;
     select coalesce(sum(sri.base_qty),0),coalesce(sum(sri.amount_paise),0)
       into v_prior_base,v_prior_amount
     from sale_return_items sri join sale_returns sr on sr.tenant_id=sri.tenant_id and sr.id=sri.sale_return_id
     where sri.tenant_id=v_tenant and sri.sale_invoice_item_id=v_sale_line.id and sr.status in ('DRAFT','POSTED');
     if v_prior_base+v_base>v_sale_line.base_qty then raise exception 'sale return quantity exceeds sold quantity'; end if;
     v_cap:=phase65_sale_line_cap(v_sale_line.id);
     v_amount:=floor(v_cap::numeric*(v_prior_base+v_base)/v_sale_line.base_qty)::bigint-v_prior_amount;
     insert into sale_return_items(tenant_id,shop_id,sale_return_id,sale_invoice_item_id,item_id,line_no,
       item_name_snapshot,hsn_snapshot,tax_rate_bp_snapshot,unit_name_snapshot,unit_level,qty,base_qty,amount_paise,disposition,client_id)
     values(v_tenant,v_sale.shop_id,v_sale_return,v_sale_line.id,v_sale_line.item_id,v_ord,
       v_sale_line.item_name_snapshot,v_sale_line.hsn_snapshot,v_sale_line.tax_rate_bp_snapshot,
       v_sale_line.unit_name_snapshot,v_sale_line.unit_level,v_qty,v_base,v_amount,v_disposition,p_client_id||':line:'||v_ord::text);
     if v_disposition='RETURN_TO_SELLABLE' then
       insert into stock_movements(tenant_id,shop_id,item_id,source_type,source_id,qty_base,client_id)
       values(v_tenant,v_sale.shop_id,v_sale_line.item_id,'SALE_RETURN',v_sale_return,v_base,p_client_id||':stock:'||v_ord::text);
     end if;
     v_total:=v_total+v_amount;
   end loop;

   -- R0b (user decision 2026-10-02), rounded bills only: all returns of a bill together never exceed
   -- what was billed for its items (total - extra charges), and the return that completes the bill
   -- (every line fully returned, this one included) takes exactly what remains, i.e. it reverses the
   -- bill's round-off. A partial return carries item value, capped at what remains (a rounded-down
   -- bill's bigger item returned first cannot exceed the bill). A voided return frees its share.
   -- The adjustment is stored in round_off_paise; the bill's returns are serialized by the lock above.
   if v_sale.round_off_paise<>0 then
     select coalesce(sum(total_paise),0) into v_prior_total from sale_returns
       where tenant_id=v_tenant and sale_invoice_id=v_sale.id and status='POSTED' and id<>v_sale_return;
     v_remaining:=greatest(v_sale.total_paise-v_sale.extra_charges_paise-v_prior_total,0);
     if not exists(
     select 1 from sale_invoice_items li
     where li.tenant_id=v_tenant and li.sale_invoice_id=v_sale.id
       and li.base_qty>coalesce((select sum(sri.base_qty) from sale_return_items sri
         join sale_returns sr on sr.tenant_id=sri.tenant_id and sr.id=sri.sale_return_id
         where sri.tenant_id=v_tenant and sri.sale_invoice_item_id=li.id and sr.status in ('DRAFT','POSTED')),0))
     then
       v_round:=v_remaining-v_total;
     elsif v_total>v_remaining then
       v_round:=v_remaining-v_total;
     end if;
     v_total:=v_total+v_round;
   end if;

   select
     coalesce((select sum(pa.amount_paise) from payment_allocations pa join payments p on p.tenant_id=pa.tenant_id and p.id=pa.payment_id
       where pa.tenant_id=v_tenant and pa.sale_invoice_id=v_sale.id and pa.status='POSTED' and p.status='POSTED' and p.direction='in'),0)
     +coalesce((select sum(p.amount_paise) from payments p where p.tenant_id=v_tenant and p.source_sale_invoice_id=v_sale.id
       and p.kind='walkin' and p.status='POSTED' and p.direction='in'),0),
     coalesce((select sum(p.amount_paise) from payments p where p.tenant_id=v_tenant and p.source_sale_invoice_id=v_sale.id
       and p.status='POSTED' and p.direction='out'),0)
   into v_received,v_prior_refunds;
   v_refund:=least(v_total,greatest(v_received-v_prior_refunds,0));
   update sale_returns set status='POSTED',total_paise=v_total,round_off_paise=v_round,cash_refund_paise=v_refund,
     balance_credit_paise=v_total-v_refund,posted_at=clock_timestamp() where id=v_sale_return;
   if v_refund>0 then
     insert into payments(tenant_id,shop_id,kind,customer_id,party_id,source_sale_invoice_id,source_sale_return_id,
       business_date,amount_paise,direction,mode,reference,status,client_id)
     values(v_tenant,v_sale.shop_id,case when v_sale.customer_id is null then 'walkin' else 'customer' end,
       v_sale.customer_id,null,v_sale.id,v_sale_return,v_date,v_refund,'out','cash','Refund '||v_doc,'POSTED',p_client_id||':refund');
   end if;
   return v_sale_return;
 end if;

 v_seq:=next_doc_no(v_purchase.shop_id,'PURCHASE_RETURN'); v_doc:='PR-'||lpad(v_seq::text,6,'0');
 insert into purchase_returns(tenant_id,shop_id,purchase_bill_id,party_id,doc_no,doc_seq,business_date,notes,request_fingerprint,client_id)
 values(v_tenant,v_purchase.shop_id,v_purchase.id,v_purchase.party_id,v_doc,v_seq,v_date,p_notes,v_fingerprint,p_client_id)
 returning id into v_purchase_return;

 for v_line,v_ord in select value,ordinality from jsonb_array_elements(p_lines) with ordinality loop
   begin
     v_qty:=(v_line->>'qty')::numeric;
   exception when others then raise exception 'invalid return quantity'; end;
   v_disposition:=upper(btrim(coalesce(v_line->>'disposition','')));
   if v_qty<=0 or v_disposition not in ('RETURN_TO_SELLABLE','DAMAGED','EXPIRED','SUPPLIER_RETURN') then
     raise exception 'invalid purchase return line';
   end if;
   select * into v_purchase_line from purchase_bill_items
     where id=(v_line->>'purchase_bill_item_id')::uuid and tenant_id=v_tenant and purchase_bill_id=v_purchase.id
     for update;
   if not found then raise exception 'purchase line unavailable for return'; end if;
   v_base:=v_qty*v_purchase_line.base_qty/v_purchase_line.qty;
   select coalesce(sum(pri.base_qty),0),coalesce(sum(pri.amount_paise),0)
     into v_prior_base,v_prior_amount
   from purchase_return_items pri join purchase_returns pr on pr.tenant_id=pri.tenant_id and pr.id=pri.purchase_return_id
   where pri.tenant_id=v_tenant and pri.purchase_bill_item_id=v_purchase_line.id and pr.status in ('DRAFT','POSTED');
   if v_prior_base+v_base>v_purchase_line.base_qty then raise exception 'purchase return quantity exceeds purchased quantity'; end if;
   v_cap:=phase65_purchase_line_cap(v_purchase_line.id);
   v_amount:=floor(v_cap::numeric*(v_prior_base+v_base)/v_purchase_line.base_qty)::bigint-v_prior_amount;
   insert into purchase_return_items(tenant_id,shop_id,purchase_return_id,purchase_bill_item_id,item_id,line_no,
     item_name_snapshot,hsn_snapshot,tax_rate_bp_snapshot,unit_name_snapshot,unit_level,qty,base_qty,amount_paise,disposition,client_id)
   values(v_tenant,v_purchase.shop_id,v_purchase_return,v_purchase_line.id,v_purchase_line.item_id,v_ord,
     v_purchase_line.item_name_snapshot,v_purchase_line.hsn_snapshot,v_purchase_line.tax_rate_bp_snapshot,
     v_purchase_line.unit_name_snapshot,v_purchase_line.unit_level,v_qty,v_base,v_amount,v_disposition,p_client_id||':line:'||v_ord::text);
   if v_disposition<>'RETURN_TO_SELLABLE' then
     insert into stock_current(tenant_id,shop_id,item_id,on_hand,reserved)
       values(v_tenant,v_purchase.shop_id,v_purchase_line.item_id,0,0) on conflict do nothing;
     perform 1 from stock_current where tenant_id=v_tenant and shop_id=v_purchase.shop_id and item_id=v_purchase_line.item_id for update;
     if not exists(select 1 from stock_current where tenant_id=v_tenant and shop_id=v_purchase.shop_id
       and item_id=v_purchase_line.item_id and available>=v_base) then raise exception 'insufficient stock for purchase return'; end if;
     insert into stock_movements(tenant_id,shop_id,item_id,source_type,source_id,qty_base,client_id)
       values(v_tenant,v_purchase.shop_id,v_purchase_line.item_id,'PURCHASE_RETURN',v_purchase_return,-v_base,p_client_id||':stock:'||v_ord::text);
   end if;
   v_total:=v_total+v_amount;
 end loop;

 -- billextras (mirrors the sale R0b block above), rounded purchase bills only: all returns of a bill together
 -- never exceed what was billed for its items (total - extra charges); the return that completes the bill
 -- (every line fully returned, this one included) takes exactly what remains, i.e. it reverses the bill's
 -- round-off. A partial return carries item value, capped at what remains. A voided return frees its share.
 if v_purchase.round_off_paise<>0 then
   select coalesce(sum(total_paise),0) into v_prior_total from purchase_returns
     where tenant_id=v_tenant and purchase_bill_id=v_purchase.id and status='POSTED' and id<>v_purchase_return;
   v_remaining:=greatest(v_purchase.total_paise-v_purchase.extra_charges_paise-v_prior_total,0);
   if not exists(
   select 1 from purchase_bill_items li
   where li.tenant_id=v_tenant and li.purchase_bill_id=v_purchase.id
     and li.base_qty>coalesce((select sum(pri.base_qty) from purchase_return_items pri
       join purchase_returns pr on pr.tenant_id=pri.tenant_id and pr.id=pri.purchase_return_id
       where pri.tenant_id=v_tenant and pri.purchase_bill_item_id=li.id and pr.status in ('DRAFT','POSTED')),0))
   then
     v_round:=v_remaining-v_total;
   elsif v_total>v_remaining then
     v_round:=v_remaining-v_total;
   end if;
   v_total:=v_total+v_round;
 end if;
 update purchase_returns set status='POSTED',total_paise=v_total,round_off_paise=v_round,posted_at=clock_timestamp() where id=v_purchase_return;
 return v_purchase_return;
end
$function$;

-- check_invariants (from 0055), unchanged except: a purchase total and a purchase return total include their round-off.
CREATE OR REPLACE FUNCTION public.check_invariants()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_tenant uuid:=phase6_assert_report_access();
 bad_sales bigint; bad_purchases bigint; bad_stock bigint; bad_alloc bigint; bad_projection bigint; bad_voids bigint;
 bad_sale_returns bigint; bad_purchase_returns bigint; bad_return_qty bigint; bad_refunds bigint; bad_payment_direction bigint; bad_settlements bigint;
begin
 select count(*) into bad_sales from sale_invoices s where s.tenant_id=v_tenant and s.status='FINALIZED' and
  (s.subtotal_paise<>(select coalesce(sum(li.line_total_paise+li.discount_paise),0) from sale_invoice_items li where li.sale_invoice_id=s.id)
   or s.total_paise<>s.subtotal_paise-s.discount_paise+s.extra_charges_paise+s.round_off_paise);
 select count(*) into bad_purchases from purchase_bills b where b.tenant_id=v_tenant and b.status='POSTED' and
  (b.subtotal_paise<>(select coalesce(sum(li.line_total_paise),0) from purchase_bill_items li where li.purchase_bill_id=b.id)
   or b.total_paise<>b.subtotal_paise-b.discount_paise+b.extra_charges_paise+b.round_off_paise);
 select count(*) into bad_stock from stock_current sc where sc.tenant_id=v_tenant and sc.qty_base<0
  and not coalesce((select allow_negative_stock from shops where id=sc.shop_id),false);
 select count(*) into bad_alloc from payments p where p.tenant_id=v_tenant and
  o2_payment_assigned(p.tenant_id,p.id)>p.amount_paise;  -- O2: allocations + opening settlements
 -- O2: a POSTED settlement needs a POSTED payment of the right account/direction and a POSTED positive
 -- opening it does not overdraw.
 select count(*) into bad_settlements from opening_settlements st
  join payments p on p.tenant_id=st.tenant_id and p.id=st.payment_id
  join account_openings o on o.tenant_id=st.tenant_id and o.id=st.opening_id
  where st.tenant_id=v_tenant and st.status='POSTED' and (p.status<>'POSTED' or o.status<>'POSTED' or o.amount_paise<=0
   or not ((o.account_kind='CUSTOMER' and p.kind='customer' and p.direction='in' and p.customer_id=o.customer_id)
        or (o.account_kind='SUPPLIER' and p.kind='party' and p.direction='out' and p.party_id=o.party_id))
   or (select sum(x.amount_paise) from opening_settlements x where x.tenant_id=o.tenant_id and x.opening_id=o.id and x.status='POSTED')>o.amount_paise);
 select count(*) into bad_payment_direction from payment_allocations a join payments p on p.tenant_id=a.tenant_id and p.id=a.payment_id
  where a.tenant_id=v_tenant and a.status='POSTED' and (p.status<>'POSTED'
   or (a.sale_invoice_id is not null and p.direction<>'in')
   or (a.purchase_bill_id is not null and (p.direction<>'out' or p.party_id is null)));
 select count(*) into bad_projection from (
  select coalesce(sc.shop_id,m.shop_id) shop_id,coalesce(sc.item_id,m.item_id) item_id,coalesce(sc.qty_base,0) projected,coalesce(m.moved,0) moved
  from stock_current sc full join (select tenant_id,shop_id,item_id,sum(qty_base) moved from stock_movements where tenant_id=v_tenant group by tenant_id,shop_id,item_id) m
   on m.tenant_id=sc.tenant_id and m.shop_id=sc.shop_id and m.item_id=sc.item_id where coalesce(sc.tenant_id,m.tenant_id)=v_tenant
 ) q where q.projected<>q.moved;
 select count(*) into bad_voids from (
  select s.id,m.item_id,sum(m.qty_base) net from sale_invoices s join stock_movements m on m.tenant_id=s.tenant_id and m.source_id=s.id
   where s.tenant_id=v_tenant and s.status='VOID' and m.source_type in ('SALE','SALE_VOID') group by s.id,m.item_id having sum(m.qty_base)<>0
  union all
  select p.id,m.item_id,sum(m.qty_base) net from purchase_bills p join stock_movements m on m.tenant_id=p.tenant_id and m.source_id=p.id
   where p.tenant_id=v_tenant and p.status='VOID' and m.source_type in ('PURCHASE','PURCHASE_VOID') group by p.id,m.item_id having sum(m.qty_base)<>0
  union all
  select r.id,m.item_id,sum(m.qty_base) net from sale_returns r join stock_movements m on m.tenant_id=r.tenant_id and m.source_id=r.id
   where r.tenant_id=v_tenant and r.status='VOID' and m.source_type in ('SALE_RETURN','SALE_RETURN_VOID') group by r.id,m.item_id having sum(m.qty_base)<>0
  union all
  select r.id,m.item_id,sum(m.qty_base) net from purchase_returns r join stock_movements m on m.tenant_id=r.tenant_id and m.source_id=r.id
   where r.tenant_id=v_tenant and r.status='VOID' and m.source_type in ('PURCHASE_RETURN','PURCHASE_RETURN_VOID') group by r.id,m.item_id having sum(m.qty_base)<>0
 ) violations;
 select count(*) into bad_sale_returns from sale_returns r where r.tenant_id=v_tenant and r.status in ('POSTED','VOID') and
  (r.total_paise<>(select coalesce(sum(i.amount_paise),0) from sale_return_items i where i.sale_return_id=r.id)+r.round_off_paise
   or r.total_paise<>r.cash_refund_paise+r.balance_credit_paise);
 select count(*) into bad_purchase_returns from purchase_returns r where r.tenant_id=v_tenant and r.status in ('POSTED','VOID') and
  r.total_paise<>(select coalesce(sum(i.amount_paise),0) from purchase_return_items i where i.purchase_return_id=r.id)+r.round_off_paise;
 select count(*) into bad_return_qty from (
  select li.id from sale_invoice_items li left join sale_return_items ri on ri.tenant_id=li.tenant_id and ri.sale_invoice_item_id=li.id
   left join sale_returns r on r.tenant_id=ri.tenant_id and r.id=ri.sale_return_id and r.status='POSTED'
   where li.tenant_id=v_tenant group by li.id,li.base_qty having coalesce(sum(ri.base_qty) filter(where r.id is not null),0)>li.base_qty
  union all
  select li.id from purchase_bill_items li left join purchase_return_items ri on ri.tenant_id=li.tenant_id and ri.purchase_bill_item_id=li.id
   left join purchase_returns r on r.tenant_id=ri.tenant_id and r.id=ri.purchase_return_id and r.status='POSTED'
   where li.tenant_id=v_tenant group by li.id,li.base_qty having coalesce(sum(ri.base_qty) filter(where r.id is not null),0)>li.base_qty
 ) excess;
 select count(*) into bad_refunds from sale_returns r where r.tenant_id=v_tenant and (
  (r.status='POSTED' and ((r.cash_refund_paise=0 and exists(select 1 from payments p where p.source_sale_return_id=r.id and p.status='POSTED'))
    or (r.cash_refund_paise>0 and (select count(*) from payments p where p.source_sale_return_id=r.id and p.status='POSTED' and p.direction='out' and p.amount_paise=r.cash_refund_paise)<>1)))
  or (r.status='VOID' and exists(select 1 from payments p where p.source_sale_return_id=r.id and p.status<>'VOID'))
 );
 return jsonb_build_object('ok',bad_sales=0 and bad_purchases=0 and bad_stock=0 and bad_alloc=0 and bad_projection=0 and bad_voids=0
   and bad_sale_returns=0 and bad_purchase_returns=0 and bad_return_qty=0 and bad_refunds=0 and bad_payment_direction=0 and bad_settlements=0,
  'saleTotalViolations',bad_sales,'purchaseTotalViolations',bad_purchases,'negativeStock',bad_stock,
  'allocationViolations',bad_alloc,'stockProjectionViolations',bad_projection,'voidReversalViolations',bad_voids,
  'saleReturnViolations',bad_sale_returns,'purchaseReturnViolations',bad_purchase_returns,
  'returnQuantityViolations',bad_return_qty,'refundViolations',bad_refunds,'paymentDirectionViolations',bad_payment_direction,'settlementViolations',bad_settlements);
end
$function$;

-- Purchase register (from 0040) with the round-off column, so subtotal - discount + extra + round-off = total.
-- The return type changes, so the function is dropped and recreated with the same grants.
drop function get_purchase_register(uuid,date,date);
create function get_purchase_register(p_shop_id uuid,p_from date,p_to date)
returns table(bill_id uuid,doc_no text,business_date date,party_name text,subtotal_paise bigint,discount_paise bigint,
 extra_charges_paise bigint,round_off_paise bigint,total_paise bigint,status text)
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=phase6_assert_report_access();
begin
 perform phase3_assert_shop(p_shop_id);
 return query
 select b.id,coalesce(nullif(b.bill_no,''),b.id::text),b.business_date,p.name,
   b.subtotal_paise,b.discount_paise,b.extra_charges_paise,b.round_off_paise,b.total_paise,b.status
 from purchase_bills b left join parties p on p.tenant_id=b.tenant_id and p.id=b.party_id
 where b.tenant_id=v_tenant and b.shop_id=p_shop_id and b.deleted_at is null and b.business_date between p_from and p_to
 order by b.business_date,b.created_at;
end $$;
revoke all on function get_purchase_register(uuid,date,date) from public,anon;
grant execute on function get_purchase_register(uuid,date,date) to authenticated;

-- The business export carries the named charges and bill images (shop-scoped, like the bill lines).
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
  'purchaseImages',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from purchase_bill_images where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb)
 );
end $$;

revoke all on function bx_purchase_children_check() from public,anon,authenticated;
revoke all on function bx_purchase_line_total(numeric,bigint,integer,integer) from public,anon,authenticated;
revoke all on function post_purchase_v2(uuid,text,jsonb) from public,anon;
revoke all on function void_paid_purchase(uuid,text,text) from public,anon;
grant execute on function post_purchase_v2(uuid,text,jsonb) to authenticated;
grant execute on function void_paid_purchase(uuid,text,text) to authenticated;
