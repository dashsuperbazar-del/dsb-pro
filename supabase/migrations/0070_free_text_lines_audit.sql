-- backlog (0070): free-text sale lines, manager audit log with remark events and price overrides
-- (owner decisions 2026-10-22).
--
-- 1. Free-text (non-catalogue) sale line: a typed name, quantity, price and GST %, no item and NO stock.
--    DECIDED (safest): sale_invoice_items.item_id becomes nullable and a new line_kind column says what the line
--    is. A CHECK ties them together: an 'item' line always has an item; a 'free_text' line never has one, is
--    always a typed price (price_source 'manual', so overridden_by is set: owner/manager only, exactly like a
--    typed price), level 1, a 1-120 character name and a GST % 0-100. No hidden "Misc" item is created, so no
--    item list, stock report, purchase or adjustment can ever touch one, and no stock row can exist for it.
--    * Only the opt-in sale v2 path (sp_sync_post_sale, dsb.sale_v2) accepts a free-text line; every older path
--      refuses it as before (no item). The line rides in the stored sync request payload, so idempotency and the
--      payload-mismatch check cover it unchanged (phase5_sync_post_sale is NOT redefined: a free-text line always
--      carries manual_unit_price_paise, which already skips the offline list-price check).
--    * Totals: subtotal/total/round-off/tax are computed exactly as for an item line (GST-extra adds tax at the
--      typed rate). GST summary groups by tax_rate_bp_snapshot (the typed rate), so it is right with no change.
--    * Stock: no stock_current row, no stock movement, no stock check. Voiding the sale reverses only item
--      lines (c0_void_sale_body is redefined with that single filter).
--    * Profit (FIFO): a free-text line has no cost layer, so it is reported as UNKNOWN-cost revenue, never as
--      profit (the existing rule for any unknown cost); no change to the report.
--    * Returns: DECIDED refused (DSB_FREE_TEXT_NOT_RETURNABLE, BEFORE INSERT on sale_return_items, so every
--      return path, online and offline sync, is covered). There is no stock to dispose of and no item to credit.
--      A bill that has a free-text line is never "fully returned", so its round-off (at most 50 paise) stays.
-- 2. Audit log for the manager: permission VIEW_AUDIT_FEED (owner, manager) and a narrow read-only audit_feed
--    view (audit rows of the listed tables, typed-price sale lines, remark history). The raw audit_log stays
--    owner-only (it holds invite tokens and cost rows).
-- No money, stock or balance value is rewritten; existing rows get line_kind 'item'.

-- 1. Free-text sale lines -------------------------------------------------------------------------------------
alter table sale_invoice_items alter column item_id drop not null;
alter table sale_invoice_items
  add column line_kind text not null default 'item' check (line_kind in ('item','free_text'));
alter table sale_invoice_items add constraint sale_invoice_items_free_text_check check (
  (line_kind='item' and item_id is not null)
  or (line_kind='free_text' and item_id is null and price_source='manual' and unit_level=1 and hsn_snapshot is null
      and char_length(btrim(item_name_snapshot)) between 1 and 120 and tax_rate_bp_snapshot between 0 and 10000));

-- Returns of a free-text line are refused on every path (no item, no stock to dispose of).
create function ft_sale_return_guard() returns trigger language plpgsql set search_path=public as $$
begin
  if exists(select 1 from sale_invoice_items where id=new.sale_invoice_item_id and line_kind='free_text') then
    raise exception 'DSB_FREE_TEXT_NOT_RETURNABLE: a free-text item cannot be returned';
  end if;
  return new;
end $$;
revoke all on function ft_sale_return_guard() from public,anon,authenticated;
create trigger sale_return_items_free_text_guard before insert on sale_return_items
  for each row execute function ft_sale_return_guard();

-- Sale body (from 0065). Unchanged except: with dsb.sale_v2 a line may be a free-text line (free_text_name,
-- free_text_tax_rate_bp, a typed price, no item_id); it takes no part in stock.
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
 v_free boolean; v_ft_name text; v_ft_rate int; v_frees boolean[]:='{}'; v_ft_names text[]:='{}'; v_ft_rates int[]:='{}';
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
   v_free:=v_v2 and v_line ? 'free_text_name';
   v_ft_name:=null; v_ft_rate:=null;
   if v_free then
     -- Free-text line: no item, level 1, retail, a typed price and a GST % from the request.
     if (v_line ? 'item_id' and jsonb_typeof(v_line->'item_id')<>'null')
        or coalesce((v_line->>'unit_level')::int,1)<>1 or coalesce(nullif(v_line->>'price_kind',''),'retail')<>'retail'
        or jsonb_typeof(v_line->'free_text_name')<>'string'
        or jsonb_typeof(v_line->'free_text_tax_rate_bp')<>'number'
        or (v_line->>'free_text_tax_rate_bp')!~'^[0-9]+$' then
       raise exception 'DSB_FREE_TEXT_INVALID: invalid free-text item';
     end if;
     v_ft_name:=btrim(v_line->>'free_text_name'); v_ft_rate:=(v_line->>'free_text_tax_rate_bp')::int;
     if char_length(v_ft_name) not between 1 and 120 or v_ft_rate not between 0 and 10000 then
       raise exception 'DSB_FREE_TEXT_INVALID: invalid free-text item';
     end if;
     if jsonb_typeof(v_line->'manual_unit_price_paise')<>'number' or v_line->'manual_unit_price_paise' is null then
       raise exception 'DSB_FREE_TEXT_INVALID: a free-text item needs a typed price';
     end if;
     v_level:=1; v_qty:=(v_line->>'qty')::numeric; v_kind:='retail';
     if v_qty<=0 then raise exception 'invalid sale line'; end if;
     v_base:=v_qty;
   else
     select * into v_item from items where id=(v_line->>'item_id')::uuid and tenant_id=v_tenant and deleted_at is null and is_active for share;
     if not found then raise exception 'item not in tenant'; end if;
     v_level:=coalesce((v_line->>'unit_level')::int,1); v_qty:=(v_line->>'qty')::numeric;
     v_kind:=coalesce(nullif(v_line->>'price_kind',''),'retail');
     if v_qty<=0 or v_level not between 1 and 3 or v_kind not in ('retail','wholesale') then raise exception 'invalid sale line'; end if;
     if v_level=1 then v_base:=v_qty*coalesce(v_item.conv1,1)*coalesce(v_item.conv2,1);
     elsif v_level=2 and v_item.unit2 is not null then v_base:=v_qty*coalesce(v_item.conv2,1);
     elsif v_level=3 and v_item.unit3 is not null then v_base:=v_qty;
     else raise exception 'unit tier unavailable'; end if;
   end if;
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
     v_list:=case when v_free then null else sp_list_price(v_tenant,p_shop_id,v_item.id,v_kind,v_level) end;
     v_price:=v_manual;
   else
     v_price:=phase4_current_price(v_tenant,p_shop_id,v_item.id,v_kind,v_level);
     v_list:=v_price;
   end if;
   v_gross:=round(v_qty*v_price)::bigint;
   v_line_discount:=coalesce((v_line->>'discount_paise')::bigint,0);
   if v_line_discount<0 or v_line_discount>v_gross then raise exception 'invalid line discount'; end if;
   v_tax:=case when v_invoice_type='gst_extra' then sp_gst_extra_tax(v_gross-v_line_discount,case when v_free then v_ft_rate else v_item.tax_rate_bp end) else 0 end;
   v_subtotal:=v_subtotal+v_gross+v_tax; v_line_discounts:=v_line_discounts+v_line_discount; v_tax_total:=v_tax_total+v_tax;
   v_prices:=array_append(v_prices,v_price); v_lists:=array_append(v_lists,v_list);
   v_sources:=array_append(v_sources,case when v_manual is null then 'list' else 'manual' end); v_taxes:=array_append(v_taxes,v_tax);
   v_frees:=array_append(v_frees,v_free); v_ft_names:=array_append(v_ft_names,v_ft_name); v_ft_rates:=array_append(v_ft_rates,v_ft_rate);
   if not v_free then
     v_pos:=array_position(v_item_ids,v_item.id);
     if v_pos is null then v_item_ids:=array_append(v_item_ids,v_item.id); v_required:=array_append(v_required,v_base);
     else v_required[v_pos]:=v_required[v_pos]+v_base; end if;
   end if;
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

 -- Ensure every projection row exists, then lock all items in deterministic order (item lines only).
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
   v_qty:=(v_line->>'qty')::numeric;
   v_price:=v_prices[v_ord]; v_gross:=round(v_qty*v_price)::bigint; v_tax:=v_taxes[v_ord];
   v_line_discount:=coalesce((v_line->>'discount_paise')::bigint,0); v_line_total:=v_gross-v_line_discount+v_tax;
   if v_frees[v_ord] then
     insert into sale_invoice_items(tenant_id,shop_id,sale_invoice_id,item_id,line_no,item_name_snapshot,hsn_snapshot,tax_rate_bp_snapshot,unit_name_snapshot,conv1_snapshot,conv2_snapshot,unit_level,entry_mode,is_big_unit,qty,base_qty,price_kind,unit_price_paise,discount_paise,line_total_paise,client_id,
       price_source,list_price_snapshot_paise,overridden_by,tax_paise,line_kind)
     values(v_tenant,p_shop_id,v_sale,null,v_ord,v_ft_names[v_ord],null,v_ft_rates[v_ord],'unit',null,null,1,
        'big',true,v_qty,v_qty,'retail',v_price,v_line_discount,v_line_total,p_client_id||':line:'||v_ord::text,
        'manual',null,auth.uid(),v_tax,'free_text');
     continue;
   end if;
   select * into v_item from items where id=(v_line->>'item_id')::uuid and tenant_id=v_tenant;
   v_level:=coalesce((v_line->>'unit_level')::int,1); v_kind:=coalesce(nullif(v_line->>'price_kind',''),'retail');
   if v_level=1 then v_base:=v_qty*coalesce(v_item.conv1,1)*coalesce(v_item.conv2,1);
   elsif v_level=2 then v_base:=v_qty*coalesce(v_item.conv2,1); else v_base:=v_qty; end if;
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

-- Void body (from 0023, renamed by 0046). Unchanged except that only item lines are reversed in stock: a
-- free-text line never moved stock.
create or replace function c0_void_sale_body(p_sale_id uuid,p_client_id text) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_sale sale_invoices%rowtype; v_line sale_invoice_items%rowtype;
begin
 if not has_perm('VOID_SALES') then raise exception 'not permitted'; end if;
 if p_client_id is null or btrim(p_client_id)='' then raise exception 'client_id required'; end if;
 select * into v_sale from sale_invoices where id=p_sale_id and tenant_id=v_tenant for update;
 if not found then raise exception 'sale not found'; end if;
 if v_sale.status='VOID' then return v_sale.id; end if;
 perform phase3_assert_shop(v_sale.shop_id);
 for v_line in select * from sale_invoice_items where sale_invoice_id=v_sale.id and deleted_at is null and line_kind='item' order by line_no loop
   insert into stock_movements(tenant_id,shop_id,item_id,source_type,source_id,qty_base,client_id)
   values(v_sale.tenant_id,v_sale.shop_id,v_line.item_id,'SALE_VOID',v_sale.id,v_line.base_qty,p_client_id||':stock:'||v_line.line_no::text);
 end loop;
 update payment_allocations set status='VOID' where sale_invoice_id=v_sale.id and status='POSTED';
 update payments set status='VOID',voided_at=now() where source_sale_invoice_id=v_sale.id and status='POSTED';
 update sale_invoices set status='VOID',voided_at=now() where id=v_sale.id;
 return v_sale.id;
end $$;
revoke all on function c0_void_sale_body(uuid,text) from public,anon,authenticated;

-- 2. Audit log for the manager, through a narrow feed (review finding: granting VIEW_AUDIT_LOG would open the raw
--    audit_log table, which holds invite tokens and cost rows a manager must never read).
--    VIEW_AUDIT_LOG stays owner-only (raw table, unchanged). New permission VIEW_AUDIT_FEED (owner, manager)
--    gates audit_feed: a read-only view that runs with the view owner's rights but filters every row itself:
--    this tenant only, has_perm('VIEW_AUDIT_FEED'), and ONLY the tables the Audit log screen lists (sales,
--    purchase bills, payments, sale prices, items, customers, team, typed-price sale lines, remark history).
--    Never invites, devices, sync keys, purchase lines, stock movements or cost prices. Remark rows also keep
--    their own visibility rule (dr_can_see). Clients have SELECT only.
insert into permissions(code,description) values ('VIEW_AUDIT_FEED','Read the audit log screen (money and access events, no raw table)')
  on conflict(code) do nothing;
insert into role_permissions(role,code) values ('owner','VIEW_AUDIT_FEED'),('manager','VIEW_AUDIT_FEED') on conflict do nothing;

create view audit_feed with (security_invoker=false) as
 select a.id,a.tenant_id,a.created_at,a.user_id,a.table_name,a.row_id,a.action,a.before,a.after
 from audit_log a
 where a.tenant_id=current_tenant_id() and has_perm('VIEW_AUDIT_FEED')
   and a.table_name in ('sale_invoices','purchase_bills','payments','item_prices','items','customers','tenant_users')
 union all
 select a.id,a.tenant_id,a.created_at,a.user_id,a.table_name,a.row_id,a.action,a.before,a.after
 from audit_log a
 where a.tenant_id=current_tenant_id() and has_perm('VIEW_AUDIT_FEED')
   and a.table_name='sale_invoice_items' and a.action='INSERT' and a.after->>'price_source'='manual'
 union all
 select e.id,e.tenant_id,e.created_at,e.actor,'document_remark_events'::text,e.remark_id,'INSERT'::text,null::jsonb,
   jsonb_build_object('remark_action',e.action,'version',e.version,'body',e.body,'status',e.status,'doc_kind',e.doc_kind,
     'purchase_bill_id',r.purchase_bill_id,'sale_invoice_id',r.sale_invoice_id,'shop_id',e.shop_id)
 from document_remark_events e
 join document_remarks r on r.tenant_id=e.tenant_id and r.id=e.remark_id
 where e.tenant_id=current_tenant_id() and has_perm('VIEW_AUDIT_FEED') and dr_can_see(e.shop_id,e.doc_kind);
revoke all on audit_feed from public,anon,authenticated;
grant select on audit_feed to authenticated;
