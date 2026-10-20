-- salepricing: typed sale prices, GST-extra invoices and customer credit limits (owner decisions 2026-10-20).
--  * Every sale line records how its price was chosen: price_source 'list' (the active item price) or 'manual'
--    (typed at the counter by an owner/manager), the list price seen at posting (list_price_snapshot_paise, null
--    when the item had none) and who typed it (overridden_by). Lines are immutable (existing trigger), so the
--    record is permanent and audited. Cashiers cannot type a price: an unpriced item needs an owner/manager.
--  * Invoice type: 'gst_included' (default, today's meaning: prices include GST) or 'gst_extra' (GST is added on
--    top of each item at the item's rate). A GST-extra line stores tax_paise = round_half_up(net x rate / 10000)
--    and its line_total_paise INCLUDES that tax (like a purchase line with GST added, 0064), so subtotal, the
--    invariant, returns (refund includes the GST paid), ledgers and the profit report need no change. A bill
--    discount is refused on a GST-extra invoice (item discounts only), so the tax shown is the tax charged.
--  * Customer credit limit: customers.sale_credit_limit_paise (null = no limit; the legacy credit_limit_paise
--    column, which old app versions still write as 0 on every edit, is ignored). Set by owner/manager only.
--    A credit sale whose outstanding + unpaid part exceeds the limit is refused (DSB_CREDIT_LIMIT_EXCEEDED) on
--    EVERY sale path (post_sale, phase5/r0/sp sync) unless an owner/manager sends the override through
--    sp_sync_post_sale; the override (the syncing user), the limit and the outstanding seen are stored.
--  * set_item_tax_rate: owner/manager sets an item's GST % (audited by the items audit trigger).
--  * All of this is opt-in per request through sp_sync_post_sale (it sets dsb.sale_v2 for its transaction,
--    like r0_sync_post_sale sets dsb.round_bill). phase5_sync_post_sale / r0_sync_post_sale requests from older
--    app versions post as before (no manual price, no GST-extra; only the new credit limit applies), same payload,
--    same response. The client sends its expected total; a first post that differs is refused
--    (DSB_TOTAL_MISMATCH) and nothing is written. A replay of a posted sale returns that sale.

alter table sale_invoices
  add column invoice_type text not null default 'gst_included' check (invoice_type in ('gst_included','gst_extra')),
  add column tax_paise bigint not null default 0 check (tax_paise >= 0),
  add column credit_limit_snapshot_paise bigint check (credit_limit_snapshot_paise >= 0),
  add column credit_outstanding_snapshot_paise bigint,
  add column credit_override_by uuid,
  add constraint sale_invoices_tax_type_check check (invoice_type = 'gst_extra' or tax_paise = 0);

alter table sale_invoice_items
  add column price_source text not null default 'list' check (price_source in ('list','manual')),
  add column list_price_snapshot_paise bigint check (list_price_snapshot_paise >= 0),
  add column overridden_by uuid,
  add column tax_paise bigint not null default 0 check (tax_paise >= 0),
  add constraint sale_invoice_items_manual_by_check check ((price_source = 'manual') = (overridden_by is not null));

alter table customers add column sale_credit_limit_paise bigint check (sale_credit_limit_paise >= 0);
grant update(sale_credit_limit_paise) on customers to authenticated;

-- The new invoice fields never change after posting (status/void columns keep their own guard).
create function sp_sale_fields_immutable() returns trigger language plpgsql set search_path=public as $$
begin
  if new.invoice_type is distinct from old.invoice_type or new.tax_paise is distinct from old.tax_paise
     or new.credit_limit_snapshot_paise is distinct from old.credit_limit_snapshot_paise
     or new.credit_outstanding_snapshot_paise is distinct from old.credit_outstanding_snapshot_paise
     or new.credit_override_by is distinct from old.credit_override_by then
    raise exception 'sale pricing fields are immutable';
  end if;
  return new;
end $$;
revoke all on function sp_sale_fields_immutable() from public,anon,authenticated;
create trigger sp_sale_fields_immutable before update on sale_invoices for each row execute function sp_sale_fields_immutable();

-- Only an owner/manager sets a credit limit. Updates are already owner/manager only (customers_update policy,
-- MANAGE_MASTER_DATA); a cashier may create a customer, but without a limit.
create function sp_customer_credit_limit_guard() returns trigger language plpgsql set search_path=public as $$
begin
  if new.sale_credit_limit_paise is not null and (tg_op='INSERT' or new.sale_credit_limit_paise is distinct from old.sale_credit_limit_paise)
     and coalesce("current_role"(),'') not in ('owner','manager')
     and current_user in ('authenticated','anon') then
    raise exception 'DSB_CREDIT_LIMIT_NOT_PERMITTED: only an owner or manager can set a credit limit';
  end if;
  return new;
end $$;
revoke all on function sp_customer_credit_limit_guard() from public,anon,authenticated;
create trigger sp_customer_credit_limit_guard before insert or update on customers
  for each row execute function sp_customer_credit_limit_guard();

-- The active list price, or null when there is none (phase4_current_price raises instead).
create function sp_list_price(p_tenant uuid,p_shop uuid,p_item uuid,p_kind text,p_level int) returns bigint
language sql stable security definer set search_path=public as $$
 select price_paise from item_prices
 where tenant_id=p_tenant and item_id=p_item and kind=p_kind and unit_level=p_level and deleted_at is null
   and effective_from<=clock_timestamp() and (effective_to is null or effective_to>clock_timestamp())
   and (shop_id=p_shop or shop_id is null)
 order by (shop_id is not null) desc,effective_from desc limit 1
$$;
revoke all on function sp_list_price(uuid,uuid,uuid,text,int) from public,anon,authenticated;

-- GST added on top of a line's net value: round half up, integers only. packages/core saleGstExtraTax mirrors it.
create function sp_gst_extra_tax(p_net bigint,p_rate_bp integer) returns bigint
language sql immutable set search_path=public as $$
 select case when p_net is null or p_rate_bp is null or p_net<0 or p_rate_bp<0 then null
   else div(2*p_net::numeric*p_rate_bp+10000,20000)::bigint end
$$;
revoke all on function sp_gst_extra_tax(bigint,integer) from public,anon;
grant execute on function sp_gst_extra_tax(bigint,integer) to authenticated;

-- Sale body (from 0051). Unchanged for callers without dsb.sale_v2 except that every new line also records
-- price_source='list' and the list price it used. Prices are resolved once in the first loop and reused.
create or replace function phase4_post_sale_unlocked(
 p_shop_id uuid,p_customer_id uuid,p_business_date date,p_discount_paise bigint,p_extra_charges_paise bigint,
 p_client_id text,p_lines jsonb,p_payments jsonb default '[]'::jsonb,p_notes text default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare
 v_tenant uuid; v_existing uuid; v_sale uuid; v_seq bigint; v_prefix text; v_doc text;
 v_line jsonb; v_pay jsonb; v_ord bigint; v_item items%rowtype;
 v_level int; v_qty numeric; v_base numeric; v_kind text; v_price bigint; v_gross bigint; v_line_discount bigint; v_line_total bigint;
 v_subtotal bigint:=0; v_line_discounts bigint:=0; v_total_discount bigint; v_total bigint; v_round_off bigint:=0; v_payment_total bigint:=0;
 v_item_ids uuid[]:='{}'; v_required numeric[]:='{}'; v_pos int; v_i int; v_payment_id uuid; v_amount bigint; v_mode text;
 v_allow_negative boolean;
 v_v2 boolean:=coalesce(current_setting('dsb.sale_v2',true),'')='on';
 v_invoice_type text:='gst_included'; v_role text:="current_role"();
 v_list bigint; v_manual bigint; v_tax bigint; v_tax_total bigint:=0;
 v_prices bigint[]:='{}'; v_lists bigint[]:='{}'; v_sources text[]:='{}'; v_taxes bigint[]:='{}';
 v_limit bigint; v_outstanding bigint; v_credit bigint; v_override_by uuid;
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
 if v_v2 then
   v_invoice_type:=coalesce(nullif(current_setting('dsb.sale_invoice_type',true),''),'gst_included');
   if v_invoice_type not in ('gst_included','gst_extra') then raise exception 'invalid invoice type'; end if;
   if v_invoice_type='gst_extra' and coalesce(p_discount_paise,0)<>0 then
     raise exception 'DSB_GST_EXTRA_BILL_DISCOUNT: a bill discount is not allowed on a GST-extra invoice; use item discounts';
   end if;
 end if;

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
   v_manual:=null;
   if v_v2 and jsonb_typeof(v_line->'manual_unit_price_paise')='number' then
     v_manual:=(v_line->>'manual_unit_price_paise')::bigint;
   elsif v_v2 and v_line ? 'manual_unit_price_paise' and jsonb_typeof(v_line->'manual_unit_price_paise')<>'null' then
     raise exception 'invalid sale line';
   end if;
   if v_manual is not null then
     if coalesce(v_role,'') not in ('owner','manager') then
       raise exception 'DSB_PRICE_OVERRIDE_NOT_PERMITTED: price override not permitted; ask the owner or a manager';
     end if;
     if v_manual<=0 or v_manual>9007199254740991 then raise exception 'invalid sale line'; end if;
     v_list:=sp_list_price(v_tenant,p_shop_id,v_item.id,v_kind,v_level);
     v_price:=v_manual;
   else
     v_price:=phase4_current_price(v_tenant,p_shop_id,v_item.id,v_kind,v_level);
     v_list:=v_price;
   end if;
   v_gross:=round(v_qty*v_price)::bigint;
   v_line_discount:=coalesce((v_line->>'discount_paise')::bigint,0);
   if v_line_discount<0 or v_line_discount>v_gross then raise exception 'invalid line discount'; end if;
   v_tax:=case when v_invoice_type='gst_extra' then sp_gst_extra_tax(v_gross-v_line_discount,v_item.tax_rate_bp) else 0 end;
   v_subtotal:=v_subtotal+v_gross+v_tax; v_line_discounts:=v_line_discounts+v_line_discount; v_tax_total:=v_tax_total+v_tax;
   v_prices:=array_append(v_prices,v_price); v_lists:=array_append(v_lists,v_list);
   v_sources:=array_append(v_sources,case when v_manual is null then 'list' else 'manual' end); v_taxes:=array_append(v_taxes,v_tax);
   v_pos:=array_position(v_item_ids,v_item.id);
   if v_pos is null then v_item_ids:=array_append(v_item_ids,v_item.id); v_required:=array_append(v_required,v_base);
   else v_required[v_pos]:=v_required[v_pos]+v_base; end if;
 end loop;
 v_total_discount:=v_line_discounts+coalesce(p_discount_paise,0);
 if v_total_discount>v_subtotal then raise exception 'discount exceeds subtotal'; end if;
 v_total:=v_subtotal-v_total_discount+coalesce(p_extra_charges_paise,0);
 -- R0 (user decision B1): only callers that opted in (r0_sync_post_sale sets dsb.round_bill for this
 -- transaction) round the BILL total to the nearest rupee, half up. Line values stay exact paise.
 if coalesce(current_setting('dsb.round_bill',true),'')='on' then
   v_round_off:=r0_round_off(v_total);
   v_total:=v_total+v_round_off;
 end if;

 for v_pay in select value from jsonb_array_elements(p_payments) loop
   v_amount:=(v_pay->>'amount_paise')::bigint; v_mode:=v_pay->>'mode';
   if v_amount<=0 or v_mode not in ('cash','upi','card','bank','other') then raise exception 'invalid payment'; end if;
   v_payment_total:=v_payment_total+v_amount;
 end loop;
 if v_payment_total>v_total then raise exception 'payments exceed sale total'; end if;
 if p_customer_id is null and v_payment_total<>v_total then raise exception 'walk-in sale must be fully paid'; end if;

 -- Credit limit: EVERY sale path (old app versions included) is refused over a customer's limit; only the
 -- new entry point can carry an owner/manager override. One lock per customer serializes its credit sales.
 if p_customer_id is not null then
   select sale_credit_limit_paise into v_limit from customers where id=p_customer_id and tenant_id=v_tenant;
   v_credit:=v_total-v_payment_total;
   if v_limit is not null and v_credit>0 then
     perform pg_advisory_xact_lock(hashtextextended(v_tenant::text||':sp:credit:'||p_customer_id::text,0));
     select coalesce(sum(balance_paise),0)::bigint into v_outstanding from customer_balances
       where tenant_id=v_tenant and customer_id=p_customer_id;
     if v_outstanding+v_credit>v_limit then
       if not v_v2 or coalesce(current_setting('dsb.sale_credit_override',true),'')<>'on' then
         raise exception 'DSB_CREDIT_LIMIT_EXCEEDED: credit limit exceeded (outstanding %, this sale % on credit, limit %)',
           v_outstanding,v_credit,v_limit;
       end if;
       if coalesce(v_role,'') not in ('owner','manager') then
         raise exception 'DSB_CREDIT_OVERRIDE_NOT_PERMITTED: credit limit override not permitted; ask the owner or a manager';
       end if;
       v_override_by:=auth.uid();
       if v_override_by is null then raise exception 'not permitted'; end if;
     end if;
   end if;
 end if;

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
 insert into sale_invoices(tenant_id,shop_id,customer_id,doc_no,doc_seq,business_date,status,subtotal_paise,discount_paise,extra_charges_paise,round_off_paise,total_paise,notes,finalized_at,client_id,
   invoice_type,tax_paise,credit_limit_snapshot_paise,credit_outstanding_snapshot_paise,credit_override_by)
 values(v_tenant,p_shop_id,p_customer_id,v_doc,v_seq,coalesce(p_business_date,shop_business_date(p_shop_id)),'FINALIZED',v_subtotal,v_total_discount,coalesce(p_extra_charges_paise,0),v_round_off,v_total,p_notes,now(),p_client_id,
   v_invoice_type,v_tax_total,v_limit,v_outstanding,v_override_by)
 returning id into v_sale;

 for v_line,v_ord in select value,ordinality from jsonb_array_elements(p_lines) with ordinality loop
   select * into v_item from items where id=(v_line->>'item_id')::uuid and tenant_id=v_tenant;
   v_level:=coalesce((v_line->>'unit_level')::int,1); v_qty:=(v_line->>'qty')::numeric; v_kind:=coalesce(nullif(v_line->>'price_kind',''),'retail');
   if v_level=1 then v_base:=v_qty*coalesce(v_item.conv1,1)*coalesce(v_item.conv2,1);
   elsif v_level=2 then v_base:=v_qty*coalesce(v_item.conv2,1); else v_base:=v_qty; end if;
   v_price:=v_prices[v_ord]; v_gross:=round(v_qty*v_price)::bigint; v_tax:=v_taxes[v_ord];
   v_line_discount:=coalesce((v_line->>'discount_paise')::bigint,0); v_line_total:=v_gross-v_line_discount+v_tax;
   insert into sale_invoice_items(tenant_id,shop_id,sale_invoice_id,item_id,line_no,item_name_snapshot,hsn_snapshot,tax_rate_bp_snapshot,unit_name_snapshot,conv1_snapshot,conv2_snapshot,unit_level,entry_mode,is_big_unit,qty,base_qty,price_kind,unit_price_paise,discount_paise,line_total_paise,client_id,
     price_source,list_price_snapshot_paise,overridden_by,tax_paise)
   values(v_tenant,p_shop_id,v_sale,v_item.id,v_ord,v_item.name,v_item.hsn,v_item.tax_rate_bp,
      case v_level when 1 then v_item.unit1 when 2 then v_item.unit2 else v_item.unit3 end,v_item.conv1,v_item.conv2,v_level,
      case v_level when 1 then 'big' when 2 then 'small' else 'piece' end,v_level=1,v_qty,v_base,v_kind,v_price,v_line_discount,v_line_total,p_client_id||':line:'||v_ord::text,
      v_sources[v_ord],v_lists[v_ord],case when v_sources[v_ord]='manual' then auth.uid() end,v_tax);
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
revoke all on function phase4_post_sale_unlocked(uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text) from public,anon,authenticated;

-- Sync sale (from 0043). Unchanged for callers without dsb.sale_v2. With it: the stored request also binds the
-- invoice type and the credit override; a line with a typed price skips the offline list-price check (the server
-- checks the role instead); the answer adds invoiceType, taxPaise and per-line taxPaise/priceSource.
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
  v_v2 boolean:=coalesce(current_setting('dsb.sale_v2',true),'')='on';
  v_request jsonb:=jsonb_build_object(
    'shop_id',p_shop_id,'customer_id',p_customer_id,'business_date',p_business_date,
    'discount_paise',p_discount_paise,'extra_charges_paise',p_extra_charges_paise,
    'lines',coalesce(p_lines,'[]'::jsonb),'payments',coalesce(p_payments,'[]'::jsonb),'notes',p_notes
  );
  v_result jsonb;
begin
  perform phase5_assert_schema(p_schema_version);
  perform phase5_assert_sync_device(p_device_id);
  if p_client_id is null or btrim(p_client_id)='' then raise exception 'client_id required'; end if;
  if p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then
    raise exception 'sale requires lines';
  end if;
  if v_v2 then
    v_request:=v_request||jsonb_build_object('sale_v2',jsonb_build_object(
      'invoice_type',coalesce(nullif(current_setting('dsb.sale_invoice_type',true),''),'gst_included'),
      'credit_override',coalesce(current_setting('dsb.sale_credit_override',true),'')='on'));
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
      where not coalesce(v_v2 and jsonb_typeof(line->'manual_unit_price_paise')='number',false)
        and (not (line ? 'expected_unit_price_paise')
         or (line->>'expected_unit_price_paise') is null
         or (line->>'expected_unit_price_paise')::bigint <> phase4_current_price(
           current_tenant_id(),p_shop_id,(line->>'item_id')::uuid,
           coalesce(nullif(line->>'price_kind',''),'retail'),
           coalesce((line->>'unit_level')::int,1)
         ))
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
  )||case when v_v2 then jsonb_build_object('taxPaise',sii.tax_paise,'priceSource',sii.price_source) else '{}'::jsonb end
  order by sii.line_no),'[]'::jsonb) into v_lines
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

  v_result:=jsonb_build_object(
    'saleId',v_sale,'docNo',v_doc,'clientId',p_client_id,'intentFingerprint',v_intent_fingerprint,
    'subtotalPaise',v_invoice.subtotal_paise,'discountPaise',v_invoice.discount_paise,
    'extraChargesPaise',v_invoice.extra_charges_paise,'totalPaise',v_invoice.total_paise,
    'lines',v_lines,'payments',v_authoritative_payments,'stock',v_stock
  );
  if v_v2 then
    v_result:=v_result||jsonb_build_object('invoiceType',v_invoice.invoice_type,'taxPaise',v_invoice.tax_paise,
      'creditOverride',v_invoice.credit_override_by is not null);
  end if;
  return v_result;
end $$;
revoke all on function phase5_sync_post_sale(text,integer,uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text) from public,anon;
grant execute on function phase5_sync_post_sale(text,integer,uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text) to authenticated;

-- Opt-in entry point for this app version. Same core as r0_sync_post_sale (rounded bill) plus typed prices,
-- invoice type, credit override and the client's expected total. All switches are local to this transaction
-- and switched off again before returning.
create function sp_sync_post_sale(
  p_device_id text,p_schema_version integer,p_shop_id uuid,p_customer_id uuid,p_business_date date,
  p_discount_paise bigint,p_extra_charges_paise bigint,p_client_id text,p_lines jsonb,p_payments jsonb,p_notes text,
  p_invoice_type text,p_credit_override boolean,p_expected_total_paise bigint
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_result jsonb; v_existed boolean; v_total bigint;
begin
  if p_invoice_type is null or p_invoice_type not in ('gst_included','gst_extra') then raise exception 'invalid invoice type'; end if;
  if p_expected_total_paise is null or p_expected_total_paise<0 then raise exception 'expected total required'; end if;
  if p_client_id is null or btrim(p_client_id)='' then raise exception 'client_id required'; end if;
  v_existed:=exists(select 1 from sale_invoices where tenant_id=current_tenant_id() and client_id=p_client_id);
  perform set_config('dsb.round_bill','on',true);
  perform set_config('dsb.sale_v2','on',true);
  perform set_config('dsb.sale_invoice_type',p_invoice_type,true);
  perform set_config('dsb.sale_credit_override',case when coalesce(p_credit_override,false) then 'on' else 'off' end,true);
  v_result:=phase5_sync_post_sale(p_device_id,p_schema_version,p_shop_id,p_customer_id,p_business_date,
    p_discount_paise,p_extra_charges_paise,p_client_id,p_lines,p_payments,p_notes);
  perform set_config('dsb.round_bill','off',true);
  perform set_config('dsb.sale_v2','off',true);
  perform set_config('dsb.sale_invoice_type','',true);
  perform set_config('dsb.sale_credit_override','off',true);
  v_total:=(v_result->>'totalPaise')::bigint;
  -- A first post whose server total differs from the device's is refused and rolled back (nothing written).
  -- A replay of an already posted sale returns it: the device then takes the server's figures.
  if not v_existed and v_total<>p_expected_total_paise then
    raise exception 'DSB_TOTAL_MISMATCH: server total % differs from the device total %',v_total,p_expected_total_paise;
  end if;
  return v_result||jsonb_build_object('roundOffPaise',
    (select round_off_paise from sale_invoices where id=(v_result->>'saleId')::uuid));
end $$;
revoke all on function sp_sync_post_sale(text,integer,uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text,text,boolean,bigint) from public,anon;
grant execute on function sp_sync_post_sale(text,integer,uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text,text,boolean,bigint) to authenticated;

-- GST summary (from 0036). GST-included lines (every line before this packet) are unchanged: their value is
-- treated as GST-inclusive and the taxable value is derived per rate. A GST-extra line's taxable value is exact:
-- line value - its tax (a return of it: the returned amount less its share of the tax).
create or replace function get_gst_summary(p_shop_id uuid,p_from date,p_to date)
returns table(tax_rate_bp integer,taxable_sales_paise bigint,gross_sales_paise bigint,taxable_purchases_paise bigint,gross_purchases_paise bigint)
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=phase6_assert_report_access();
begin
 perform phase3_assert_shop(p_shop_id);
 return query
 with sale_lines as (
  select rate,phase65_sale_line_cap(line_id) adjusted,extra_taxable from (
   select sii.id line_id,sii.tax_rate_bp_snapshot rate,
    case when si.invoice_type='gst_extra' then sii.line_total_paise-sii.tax_paise end extra_taxable
    from sale_invoice_items sii
    join sale_invoices si on si.tenant_id=sii.tenant_id and si.id=sii.sale_invoice_id
    where sii.tenant_id=v_tenant and sii.shop_id=p_shop_id and si.status='FINALIZED' and si.business_date between p_from and p_to
  ) original_lines
  union all
  select sri.tax_rate_bp_snapshot,-sri.amount_paise,
   case when si.invoice_type='gst_extra' then
     -(sri.amount_paise-case when sii.line_total_paise>0 then round(sri.amount_paise::numeric*sii.tax_paise/sii.line_total_paise)::bigint else 0 end)
   end
   from sale_return_items sri
   join sale_returns sr on sr.tenant_id=sri.tenant_id and sr.id=sri.sale_return_id
   join sale_invoice_items sii on sii.tenant_id=sri.tenant_id and sii.id=sri.sale_invoice_item_id
   join sale_invoices si on si.tenant_id=sii.tenant_id and si.id=sii.sale_invoice_id
   where sri.tenant_id=v_tenant and sri.shop_id=p_shop_id and sr.status='POSTED' and sr.business_date between p_from and p_to
 ), purchase_lines as (
  select pbi.tax_rate_bp_snapshot rate,
   phase65_purchase_line_cap(pbi.id) adjusted
  from purchase_bill_items pbi join purchase_bills pb on pb.tenant_id=pbi.tenant_id and pb.id=pbi.purchase_bill_id
  where pbi.tenant_id=v_tenant and pbi.shop_id=p_shop_id and pb.status='POSTED' and pb.business_date between p_from and p_to
  union all
  select pri.tax_rate_bp_snapshot,-pri.amount_paise from purchase_return_items pri
   join purchase_returns pr on pr.tenant_id=pri.tenant_id and pr.id=pri.purchase_return_id
   where pri.tenant_id=v_tenant and pri.shop_id=p_shop_id and pr.status='POSTED' and pr.business_date between p_from and p_to
 ), s as (
  select rate,sum(adjusted)::bigint gross,
   sum(case when extra_taxable is null then adjusted else 0 end)::bigint incl_gross,
   sum(coalesce(extra_taxable,0))::bigint extra_taxable
  from sale_lines group by rate
 ),
 p as (select rate,sum(adjusted)::bigint gross from purchase_lines group by rate),rates as (select rate from s union select rate from p)
 select r.rate,(round(coalesce(s.incl_gross,0)*10000.0/(10000+r.rate))+coalesce(s.extra_taxable,0))::bigint,coalesce(s.gross,0)::bigint,
  round(coalesce(p.gross,0)*10000.0/(10000+r.rate))::bigint,coalesce(p.gross,0)::bigint
 from rates r left join s using(rate) left join p using(rate) order by r.rate;
end $$;
revoke all on function get_gst_summary(uuid,date,date) from public,anon;
grant execute on function get_gst_summary(uuid,date,date) to authenticated;

-- Item GST % (basis points 0..10000), owner/manager only. Server-side write; the items audit trigger records it.
create function set_item_tax_rate(p_item_id uuid,p_tax_rate_bp integer) returns integer
language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_rate integer;
begin
 if coalesce("current_role"(),'') not in ('owner','manager') then raise exception 'not permitted'; end if;
 if p_tax_rate_bp is null or p_tax_rate_bp<0 or p_tax_rate_bp>10000 then raise exception 'invalid tax rate'; end if;
 update items set tax_rate_bp=p_tax_rate_bp where id=p_item_id and tenant_id=v_tenant and deleted_at is null
   returning tax_rate_bp into v_rate;
 if v_rate is null then raise exception 'item not in tenant'; end if;
 return v_rate;
end $$;
revoke all on function set_item_tax_rate(uuid,integer) from public,anon;
grant execute on function set_item_tax_rate(uuid,integer) to authenticated;
