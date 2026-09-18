-- Plan §19.1 negative-stock override. Owner decision, recorded verbatim: when
-- enabled for a shop, a sale silently oversells (stock goes negative, sold
-- first, physical count reconciles it later) rather than being blocked or
-- requiring a per-sale confirmation. Per-shop, not per-tenant.
--
-- Scoped narrowly to sale-caused stock movements only. Purchase returns,
-- sale-return voids and stock counts already have their own explicit
-- "insufficient stock" guards and are left exactly as they were: going
-- negative there is much more likely a real bug (voiding more than was
-- posted, returning more than was bought) than a deliberate oversell, and
-- this override was never asked to cover them.
--
-- Two checks change:
--  1. post_sale's own pre-flight check (a clean early error) is skipped for
--     a shop with the override on, so the sale is even attempted.
--  2. apply_stock_movement()'s trigger -- the actual authority, since the
--     pre-flight check alone does nothing if the trigger still blocks the
--     insert. Its original condition (`on_hand<0 or on_hand<reserved`) is
--     mathematically just `on_hand<reserved` given reserved's `>=0` check
--     constraint (reserved>0 makes the on_hand<0 clause a strict subset;
--     reserved=0 makes the two clauses identical) -- there was never a
--     separate "went negative" invariant from "dipped below a reservation"
--     to begin with, they are the same formula. So the override, scoped to
--     source_type='SALE', overrides that single condition outright: with it
--     on, a sale is not blocked by stock for that shop, full stop, exactly
--     as asked ("silently allow it"), reservation included. Reservations
--     are Phase 8 work and server-side `reserved` is always 0 today, so in
--     production this always reduces to the plain "allow negative on_hand"
--     case; 0030's pgTAP test seeds `reserved` directly to prove the wider
--     rule ahead of Phase 8 actually setting it.

alter table shops add column if not exists allow_negative_stock boolean not null default false;

create or replace function apply_stock_movement() returns trigger
language plpgsql security definer set search_path=public as $$
declare v_on_hand numeric; v_reserved numeric; v_allow_negative boolean;
begin
 insert into stock_current(tenant_id,shop_id,item_id,on_hand,reserved,updated_at)
 values(new.tenant_id,new.shop_id,new.item_id,new.qty_base,0,(extract(epoch from clock_timestamp())*1000)::bigint)
 on conflict(tenant_id,shop_id,item_id) do update
 set on_hand=stock_current.on_hand+excluded.on_hand,
     updated_at=(extract(epoch from clock_timestamp())*1000)::bigint
 returning on_hand,reserved into v_on_hand,v_reserved;
 if v_on_hand < v_reserved then
   if new.source_type<>'SALE' then raise exception 'insufficient stock'; end if;
   select allow_negative_stock into v_allow_negative from shops where id=new.shop_id;
   if not coalesce(v_allow_negative,false) then raise exception 'insufficient stock'; end if;
 end if;
 return new;
end $$;
revoke all on function apply_stock_movement() from public;

-- Same body as phase4_post_sale_unlocked (0023, renamed by 0026), with the
-- pre-flight stock check made conditional on the shop's override.
create or replace function phase4_post_sale_unlocked(
 p_shop_id uuid,p_customer_id uuid,p_business_date date,p_discount_paise bigint,p_extra_charges_paise bigint,
 p_client_id text,p_lines jsonb,p_payments jsonb default '[]'::jsonb,p_notes text default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare
 v_tenant uuid; v_existing uuid; v_sale uuid; v_seq bigint; v_prefix text; v_doc text;
 v_line jsonb; v_pay jsonb; v_ord bigint; v_item items%rowtype;
 v_level int; v_qty numeric; v_base numeric; v_kind text; v_price bigint; v_gross bigint; v_line_discount bigint; v_line_total bigint;
 v_subtotal bigint:=0; v_line_discounts bigint:=0; v_total_discount bigint; v_total bigint; v_payment_total bigint:=0;
 v_item_ids uuid[]:='{}'; v_required numeric[]:='{}'; v_pos int; v_i int; v_payment_id uuid; v_amount bigint; v_mode text;
 v_allow_negative boolean;
begin
 if not has_perm('POST_SALES') then raise exception 'not permitted'; end if;
 v_tenant:=phase3_assert_shop(p_shop_id);
 if p_client_id is null or btrim(p_client_id)='' then raise exception 'client_id required'; end if;
 select id into v_existing from sale_invoices where tenant_id=v_tenant and client_id=p_client_id;
 if v_existing is not null then return v_existing; end if;
 if p_customer_id is not null and not exists(select 1 from customers where id=p_customer_id and tenant_id=v_tenant and deleted_at is null) then raise exception 'customer not in tenant'; end if;
 if coalesce(p_discount_paise,0)<0 or coalesce(p_extra_charges_paise,0)<0 then raise exception 'negative adjustment'; end if;
 if p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then raise exception 'sale requires lines'; end if;
 if p_payments is null or jsonb_typeof(p_payments)<>'array' then raise exception 'payments must be an array'; end if;

 for v_line,v_ord in select value,ordinality from jsonb_array_elements(p_lines) with ordinality loop
   select * into v_item from items where id=(v_line->>'item_id')::uuid and tenant_id=v_tenant and deleted_at is null and is_active for share;
   if not found then raise exception 'item not in tenant'; end if;
   v_level:=coalesce((v_line->>'unit_level')::int,1); v_qty:=(v_line->>'qty')::numeric;
   v_kind:=coalesce(nullif(v_line->>'price_kind',''),'retail');
   if v_qty<=0 or v_level not between 1 and 3 or v_kind not in ('retail','wholesale') then raise exception 'invalid sale line'; end if;
   if v_level=1 then v_base:=v_qty*coalesce(v_item.conv1,1)*coalesce(v_item.conv2,1);
   elsif v_level=2 and v_item.unit2 is not null then v_base:=v_qty*coalesce(v_item.conv2,1);
   elsif v_level=3 and v_item.unit3 is not null then v_base:=v_qty;
   else raise exception 'unit tier unavailable'; end if;
   v_price:=phase4_current_price(v_tenant,p_shop_id,v_item.id,v_kind,v_level);
   v_gross:=round(v_qty*v_price)::bigint;
   v_line_discount:=coalesce((v_line->>'discount_paise')::bigint,0);
   if v_line_discount<0 or v_line_discount>v_gross then raise exception 'invalid line discount'; end if;
   v_subtotal:=v_subtotal+v_gross; v_line_discounts:=v_line_discounts+v_line_discount;
   v_pos:=array_position(v_item_ids,v_item.id);
   if v_pos is null then v_item_ids:=array_append(v_item_ids,v_item.id); v_required:=array_append(v_required,v_base);
   else v_required[v_pos]:=v_required[v_pos]+v_base; end if;
 end loop;
 v_total_discount:=v_line_discounts+coalesce(p_discount_paise,0);
 if v_total_discount>v_subtotal then raise exception 'discount exceeds subtotal'; end if;
 v_total:=v_subtotal-v_total_discount+coalesce(p_extra_charges_paise,0);

 for v_pay in select value from jsonb_array_elements(p_payments) loop
   v_amount:=(v_pay->>'amount_paise')::bigint; v_mode:=v_pay->>'mode';
   if v_amount<=0 or v_mode not in ('cash','upi','card','bank','other') then raise exception 'invalid payment'; end if;
   v_payment_total:=v_payment_total+v_amount;
 end loop;
 if v_payment_total>v_total then raise exception 'payments exceed sale total'; end if;
 if p_customer_id is null and v_payment_total<>v_total then raise exception 'walk-in sale must be fully paid'; end if;

 -- Ensure every projection row exists, then lock all items in deterministic order.
 for v_i in 1..coalesce(array_length(v_item_ids,1),0) loop
   insert into stock_current(tenant_id,shop_id,item_id,on_hand,reserved)
   values(v_tenant,p_shop_id,v_item_ids[v_i],0,0) on conflict do nothing;
 end loop;
 perform 1 from stock_current where tenant_id=v_tenant and shop_id=p_shop_id and item_id=any(v_item_ids) order by item_id for update;
 select allow_negative_stock into v_allow_negative from shops where id=p_shop_id and tenant_id=v_tenant;
 if not coalesce(v_allow_negative,false) then
   for v_i in 1..coalesce(array_length(v_item_ids,1),0) loop
     if not exists(select 1 from stock_current where tenant_id=v_tenant and shop_id=p_shop_id and item_id=v_item_ids[v_i] and available>=v_required[v_i]) then
       raise exception 'insufficient stock';
     end if;
   end loop;
 end if;

 v_seq:=next_doc_no(p_shop_id,'SALE');
 select coalesce(nullif(invoice_prefix,''),'INV') into v_prefix from shops where id=p_shop_id and tenant_id=v_tenant;
 v_doc:=v_prefix||'-'||lpad(v_seq::text,6,'0');
 insert into sale_invoices(tenant_id,shop_id,customer_id,doc_no,doc_seq,business_date,status,subtotal_paise,discount_paise,extra_charges_paise,total_paise,notes,finalized_at,client_id)
 values(v_tenant,p_shop_id,p_customer_id,v_doc,v_seq,coalesce(p_business_date,shop_business_date(p_shop_id)),'FINALIZED',v_subtotal,v_total_discount,coalesce(p_extra_charges_paise,0),v_total,p_notes,now(),p_client_id)
 returning id into v_sale;

 for v_line,v_ord in select value,ordinality from jsonb_array_elements(p_lines) with ordinality loop
   select * into v_item from items where id=(v_line->>'item_id')::uuid and tenant_id=v_tenant;
   v_level:=coalesce((v_line->>'unit_level')::int,1); v_qty:=(v_line->>'qty')::numeric; v_kind:=coalesce(nullif(v_line->>'price_kind',''),'retail');
   if v_level=1 then v_base:=v_qty*coalesce(v_item.conv1,1)*coalesce(v_item.conv2,1);
   elsif v_level=2 then v_base:=v_qty*coalesce(v_item.conv2,1); else v_base:=v_qty; end if;
   v_price:=phase4_current_price(v_tenant,p_shop_id,v_item.id,v_kind,v_level); v_gross:=round(v_qty*v_price)::bigint;
   v_line_discount:=coalesce((v_line->>'discount_paise')::bigint,0); v_line_total:=v_gross-v_line_discount;
   insert into sale_invoice_items(tenant_id,shop_id,sale_invoice_id,item_id,line_no,item_name_snapshot,hsn_snapshot,tax_rate_bp_snapshot,unit_name_snapshot,conv1_snapshot,conv2_snapshot,unit_level,entry_mode,is_big_unit,qty,base_qty,price_kind,unit_price_paise,discount_paise,line_total_paise,client_id)
   values(v_tenant,p_shop_id,v_sale,v_item.id,v_ord,v_item.name,v_item.hsn,v_item.tax_rate_bp,
      case v_level when 1 then v_item.unit1 when 2 then v_item.unit2 else v_item.unit3 end,v_item.conv1,v_item.conv2,v_level,
      case v_level when 1 then 'big' when 2 then 'small' else 'piece' end,v_level=1,v_qty,v_base,v_kind,v_price,v_line_discount,v_line_total,p_client_id||':line:'||v_ord::text);
   insert into stock_movements(tenant_id,shop_id,item_id,source_type,source_id,qty_base,client_id)
   values(v_tenant,p_shop_id,v_item.id,'SALE',v_sale,-v_base,p_client_id||':stock:'||v_ord::text);
 end loop;

 for v_pay,v_ord in select value,ordinality from jsonb_array_elements(p_payments) with ordinality loop
   v_amount:=(v_pay->>'amount_paise')::bigint; v_mode:=v_pay->>'mode';
   if p_customer_id is null then
     -- Use no customer ledger row for walk-in tenders; the payment still belongs to the sale.
     insert into payments(tenant_id,shop_id,kind,customer_id,party_id,source_sale_invoice_id,business_date,amount_paise,mode,reference,status,client_id)
     values(v_tenant,p_shop_id,'customer',null,null,v_sale,coalesce(p_business_date,shop_business_date(p_shop_id)),v_amount,v_mode,v_pay->>'reference','POSTED',p_client_id||':pay:'||v_ord::text)
     returning id into v_payment_id;
   else
     insert into payments(tenant_id,shop_id,kind,customer_id,source_sale_invoice_id,business_date,amount_paise,mode,reference,status,client_id)
     values(v_tenant,p_shop_id,'customer',p_customer_id,v_sale,coalesce(p_business_date,shop_business_date(p_shop_id)),v_amount,v_mode,v_pay->>'reference','POSTED',p_client_id||':pay:'||v_ord::text)
     returning id into v_payment_id;
     insert into payment_allocations(tenant_id,payment_id,doc_type,sale_invoice_id,amount_paise,client_id)
     values(v_tenant,v_payment_id,'SALE',v_sale,v_amount,p_client_id||':alloc:'||v_ord::text);
   end if;
 end loop;
 return v_sale;
exception when unique_violation then
 select id into v_existing from sale_invoices where tenant_id=v_tenant and client_id=p_client_id;
 if v_existing is not null then return v_existing; end if;
 raise;
end $$;
revoke all on function phase4_post_sale_unlocked(uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text) from public;
revoke all on function phase4_post_sale_unlocked(uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text) from authenticated;

-- Extend the Settings screen's RPC with the new field. Dropped and recreated
-- (not create-or-replace) so the old 8-argument signature cannot linger as
-- an ambiguous second overload.
drop function update_shop_settings(uuid,text,text,text,text,text,text,smallint);
create function update_shop_settings(
  p_shop_id uuid, p_name text, p_address text, p_gstin text, p_invoice_prefix text,
  p_timezone text, p_printer_width text, p_fiscal_year_start_month smallint, p_allow_negative_stock boolean
) returns void language plpgsql security definer set search_path=public as $$
declare v_tenant uuid;
begin
  v_tenant:=phase3_assert_shop(p_shop_id);
  if "current_role"() not in ('owner','manager') then raise exception 'not permitted'; end if;
  if p_name is null or btrim(p_name)='' then raise exception 'shop name required'; end if;
  if p_timezone is null or btrim(p_timezone)='' then raise exception 'timezone required'; end if;
  if p_printer_width is null or p_printer_width not in ('58mm','80mm') then raise exception 'invalid printer width'; end if;
  if p_fiscal_year_start_month is null or p_fiscal_year_start_month<1 or p_fiscal_year_start_month>12
    then raise exception 'invalid fiscal year start month'; end if;
  if p_allow_negative_stock is null then raise exception 'allow_negative_stock required'; end if;
  update shops set
    name=btrim(p_name),
    address=nullif(btrim(coalesce(p_address,'')),''),
    gstin=nullif(btrim(coalesce(p_gstin,'')),''),
    invoice_prefix=nullif(btrim(coalesce(p_invoice_prefix,'')),''),
    timezone=btrim(p_timezone),
    printer_width=p_printer_width,
    fiscal_year_start_month=p_fiscal_year_start_month,
    allow_negative_stock=p_allow_negative_stock
  where id=p_shop_id and tenant_id=v_tenant and deleted_at is null;
  if not found then raise exception 'shop not found'; end if;
end $$;
revoke all on function update_shop_settings(uuid,text,text,text,text,text,text,smallint,boolean) from public,anon;
grant execute on function update_shop_settings(uuid,text,text,text,text,text,text,smallint,boolean) to authenticated;

-- The offline client has its own local "insufficient cached stock" check
-- (packages/sync/src/offlineSale.ts) that gives instant feedback without a
-- round-trip. It knows nothing about this override, so it would keep
-- blocking an oversell client-side even though the server would now accept
-- it. Teach phase5_sync_pull() to hand it the shop's flag alongside the
-- existing cashier-offline-finalization policy, both under the same
-- `policy` object the client already caches.
create or replace function phase5_sync_pull(
  p_device_id text,p_shop_id uuid,p_schema_version integer,p_cursors jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  v_tenant uuid;
  v_cutoff bigint:=(extract(epoch from (clock_timestamp()-interval '1 second'))*1000)::bigint;
  v_server_now bigint:=(extract(epoch from clock_timestamp())*1000)::bigint;
  v_settings jsonb; v_allow_negative_stock boolean;
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
  select allow_negative_stock into v_allow_negative_stock from shops where id=p_shop_id and tenant_id=v_tenant;

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
        then (v_settings->>'allow_cashier_offline_finalization')::boolean else false end,
      'allowNegativeStock',coalesce(v_allow_negative_stock,false)),
    'items',v_items,'barcodes',v_barcodes,'prices',v_prices,'customers',v_customers,'stock',v_stock
  );
end $$;
revoke all on function phase5_sync_pull(text,uuid,integer,jsonb) from public,anon;
grant execute on function phase5_sync_pull(text,uuid,integer,jsonb) to authenticated;

-- check_invariants() must not report a shop's own permitted policy as a
-- "negativeStock" violation -- that field exists to catch bugs, and crying
-- wolf on an intentional, owner-enabled state would train people to ignore
-- it. Every other computation in this function is untouched, copied
-- verbatim from 0036's create-or-replace.
create or replace function check_invariants()
returns jsonb language plpgsql stable security definer set search_path=public as $invariants$
declare v_tenant uuid:=phase6_assert_report_access();
 bad_sales bigint; bad_purchases bigint; bad_stock bigint; bad_alloc bigint; bad_projection bigint; bad_voids bigint;
 bad_sale_returns bigint; bad_purchase_returns bigint; bad_return_qty bigint; bad_refunds bigint; bad_payment_direction bigint;
begin
 select count(*) into bad_sales from sale_invoices s where s.tenant_id=v_tenant and s.status='FINALIZED' and
  (s.subtotal_paise<>(select coalesce(sum(li.line_total_paise+li.discount_paise),0) from sale_invoice_items li where li.sale_invoice_id=s.id)
   or s.total_paise<>s.subtotal_paise-s.discount_paise+s.extra_charges_paise);
 select count(*) into bad_purchases from purchase_bills b where b.tenant_id=v_tenant and b.status='POSTED' and
  (b.subtotal_paise<>(select coalesce(sum(li.line_total_paise),0) from purchase_bill_items li where li.purchase_bill_id=b.id)
   or b.total_paise<>b.subtotal_paise-b.discount_paise+b.extra_charges_paise);
 select count(*) into bad_stock from stock_current sc where sc.tenant_id=v_tenant and sc.qty_base<0
  and not coalesce((select allow_negative_stock from shops where id=sc.shop_id),false);
 select count(*) into bad_alloc from payments p where p.tenant_id=v_tenant and
  (select coalesce(sum(amount_paise),0) from payment_allocations a where a.payment_id=p.id and a.status='POSTED')>p.amount_paise;
 select count(*) into bad_payment_direction from payment_allocations a join payments p on p.tenant_id=a.tenant_id and p.id=a.payment_id
  where a.tenant_id=v_tenant and a.status='POSTED' and (p.status<>'POSTED' or p.direction<>'in');
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
  (r.total_paise<>(select coalesce(sum(i.amount_paise),0) from sale_return_items i where i.sale_return_id=r.id)
   or r.total_paise<>r.cash_refund_paise+r.balance_credit_paise);
 select count(*) into bad_purchase_returns from purchase_returns r where r.tenant_id=v_tenant and r.status in ('POSTED','VOID') and
  r.total_paise<>(select coalesce(sum(i.amount_paise),0) from purchase_return_items i where i.purchase_return_id=r.id);
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
   and bad_sale_returns=0 and bad_purchase_returns=0 and bad_return_qty=0 and bad_refunds=0 and bad_payment_direction=0,
  'saleTotalViolations',bad_sales,'purchaseTotalViolations',bad_purchases,'negativeStock',bad_stock,
  'allocationViolations',bad_alloc,'stockProjectionViolations',bad_projection,'voidReversalViolations',bad_voids,
  'saleReturnViolations',bad_sale_returns,'purchaseReturnViolations',bad_purchase_returns,
  'returnQuantityViolations',bad_return_qty,'refundViolations',bad_refunds,'paymentDirectionViolations',bad_payment_direction);
end
$invariants$;
