-- Confirmed shop policy: cash up to receipts, remainder against balance.
-- Offline acceptance is provisional. Only this online transaction calculates
-- the refund and posts its deterministic outgoing payment via post_return().
create function phase65_sync_post_return(
 p_device_id text,p_schema_version integer,p_return_type text,p_source_id uuid,
 p_business_date date,p_client_id text,p_lines jsonb,p_notes text default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_id uuid; v_shop uuid; v_doc text; v_total bigint; v_status text;
 v_cash bigint:=0; v_balance bigint:=0; v_stock jsonb;
begin
 perform phase5_assert_schema(p_schema_version);
 perform phase5_assert_sync_device(p_device_id);
 v_tenant:=current_tenant_id();
 v_id:=post_return(p_return_type,p_source_id,p_business_date,p_client_id,p_lines,p_notes);
 if upper(p_return_type)='SALE' then
  select shop_id,doc_no,total_paise,cash_refund_paise,balance_credit_paise,status
   into v_shop,v_doc,v_total,v_cash,v_balance,v_status from sale_returns where tenant_id=v_tenant and id=v_id;
 else
  select shop_id,doc_no,total_paise,status into v_shop,v_doc,v_total,v_status
   from purchase_returns where tenant_id=v_tenant and id=v_id;
 end if;
 select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) into v_stock from (
  select (s.shop_id::text||':'||s.item_id::text) id,(s.shop_id::text||':'||s.item_id::text) key,
   s.tenant_id,s.shop_id,s.item_id,s.on_hand::double precision on_hand,
   s.reserved::double precision reserved,s.available::double precision available,
   s.qty_base::double precision qty_base,s.updated_at,null::bigint deleted_at
  from stock_current s where s.tenant_id=v_tenant and s.shop_id=v_shop and s.item_id in (
   select item_id from sale_return_items where tenant_id=v_tenant and sale_return_id=v_id
   union select item_id from purchase_return_items where tenant_id=v_tenant and purchase_return_id=v_id
  )
 ) q;
 return jsonb_build_object('returnId',v_id,'docNo',v_doc,'status',v_status,'totalPaise',v_total,
  'cashRefundPaise',v_cash,'balanceCreditPaise',v_balance,'stock',v_stock);
end $$;
revoke all on function phase65_sync_post_return(text,integer,text,uuid,date,text,jsonb,text) from public,anon;
grant execute on function phase65_sync_post_return(text,integer,text,uuid,date,text,jsonb,text) to authenticated;

-- A bounded, identity/shop scoped offline reference window. No payment or
-- allocation data is replicated: cash/balance decisions remain server-only.
create function phase65_sync_return_sources(p_device_id text,p_shop_id uuid,p_schema_version integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_sales jsonb:='[]'; v_purchases jsonb:='[]';
begin
 perform phase5_assert_schema(p_schema_version);
 perform phase5_assert_sync_device(p_device_id);
 v_tenant:=phase3_assert_shop(p_shop_id);
 if has_perm('POST_SALES') then
  select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) into v_sales from (
   select 'SALE'::text return_type,s.id,s.shop_id,s.doc_no,s.business_date,s.total_paise,
    c.name customer_name,null::text party_name,
    coalesce((select jsonb_agg(r.client_id) from sale_returns r where r.tenant_id=v_tenant and r.sale_invoice_id=s.id and r.status='POSTED'),'[]'::jsonb) posted_return_client_ids,
    coalesce((select jsonb_agg(to_jsonb(l) order by l.line_no) from (
     select i.id,i.line_no,i.item_id,i.item_name_snapshot,i.unit_name_snapshot,
      i.qty::double precision qty,i.base_qty::double precision base_qty,
      coalesce((select sum(ri.qty) from sale_return_items ri join sale_returns r on r.id=ri.sale_return_id
       and r.tenant_id=ri.tenant_id where ri.tenant_id=v_tenant and ri.sale_invoice_item_id=i.id and r.status='POSTED'),0)::double precision returned_qty
     from sale_invoice_items i where i.tenant_id=v_tenant and i.sale_invoice_id=s.id
    ) l),'[]'::jsonb) lines
   from sale_invoices s left join customers c on c.tenant_id=s.tenant_id and c.id=s.customer_id
   where s.tenant_id=v_tenant and s.shop_id=p_shop_id and s.status='FINALIZED' and s.deleted_at is null
   order by s.created_at desc,s.id limit 100
  ) q;
 end if;
 if has_perm('POST_PURCHASES') then
  select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) into v_purchases from (
   select 'PURCHASE'::text return_type,b.id,b.shop_id,coalesce(nullif(b.bill_no,''),b.id::text) doc_no,
    b.business_date,b.total_paise,null::text customer_name,p.name party_name,
    coalesce((select jsonb_agg(r.client_id) from purchase_returns r where r.tenant_id=v_tenant and r.purchase_bill_id=b.id and r.status='POSTED'),'[]'::jsonb) posted_return_client_ids,
    coalesce((select jsonb_agg(to_jsonb(l) order by l.line_no) from (
     select i.id,i.line_no,i.item_id,i.item_name_snapshot,i.unit_name_snapshot,
      i.qty::double precision qty,i.base_qty::double precision base_qty,
      coalesce((select sum(ri.qty) from purchase_return_items ri join purchase_returns r on r.id=ri.purchase_return_id
       and r.tenant_id=ri.tenant_id where ri.tenant_id=v_tenant and ri.purchase_bill_item_id=i.id and r.status='POSTED'),0)::double precision returned_qty
     from purchase_bill_items i where i.tenant_id=v_tenant and i.purchase_bill_id=b.id
    ) l),'[]'::jsonb) lines
   from purchase_bills b left join parties p on p.tenant_id=b.tenant_id and p.id=b.party_id
   where b.tenant_id=v_tenant and b.shop_id=p_shop_id and b.status='POSTED' and b.deleted_at is null
   order by b.created_at desc,b.id limit 100
  ) q;
 end if;
 return jsonb_build_object('sources',v_sales||v_purchases);
end $$;
revoke all on function phase65_sync_return_sources(text,uuid,integer) from public,anon;
grant execute on function phase65_sync_return_sources(text,uuid,integer) to authenticated;
