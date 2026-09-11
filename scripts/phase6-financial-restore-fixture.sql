-- Synthetic, non-production financial history used only by the portable DR round-trip.
-- Fixed IDs make the restored proof precise and idempotent.
set session_replication_role = replica;

do $fixture$
declare
  v_tenant uuid;
  v_shop uuid;
  v_user uuid;
  v_item uuid;
begin
  select t.id, s.id, t.created_by into v_tenant, v_shop, v_user
  from tenants t join shops s on s.tenant_id=t.id
  order by t.created_at, s.created_at limit 1;
  select id into v_item from items where tenant_id=v_tenant order by created_at limit 1;
  if v_tenant is null or v_shop is null or v_user is null or v_item is null then
    raise exception 'Phase 6 financial fixture requires an existing tenant, shop, user and item';
  end if;

  insert into parties(id,tenant_id,name,created_by,client_id)
  values('f6000000-0000-0000-0000-000000000001',v_tenant,'Phase 6 DR Fixture Supplier',v_user,'phase6-dr-party');
  insert into customers(id,tenant_id,name,created_by,client_id)
  values('f6000000-0000-0000-0000-000000000002',v_tenant,'Phase 6 DR Fixture Customer',v_user,'phase6-dr-customer');
  insert into purchase_bills(id,tenant_id,shop_id,party_id,bill_no,business_date,status,subtotal_paise,discount_paise,extra_charges_paise,total_paise,created_by,client_id)
  values('f6000000-0000-0000-0000-000000000003',v_tenant,v_shop,'f6000000-0000-0000-0000-000000000001','DR-PURCHASE-1','2026-09-11','POSTED',23456,0,0,23456,v_user,'phase6-dr-purchase');
  insert into purchase_bill_items(id,tenant_id,shop_id,purchase_bill_id,item_id,line_no,item_name_snapshot,tax_rate_bp_snapshot,unit_name_snapshot,unit_level,qty,base_qty,unit_price_paise,line_total_paise,created_by,client_id)
  values('f6000000-0000-0000-0000-000000000004',v_tenant,v_shop,'f6000000-0000-0000-0000-000000000003',v_item,1,'Phase 6 DR Fixture Item',0,'piece',3,3,3,7818,23456,v_user,'phase6-dr-purchase-line');
  insert into sale_invoices(id,tenant_id,shop_id,customer_id,doc_no,doc_seq,business_date,status,subtotal_paise,discount_paise,extra_charges_paise,total_paise,finalized_at,created_by,client_id)
  values('f6000000-0000-0000-0000-000000000005',v_tenant,v_shop,'f6000000-0000-0000-0000-000000000002','DR-SALE-1',900000001,'2026-09-11','FINALIZED',12345,0,0,12345,now(),v_user,'phase6-dr-sale');
  insert into sale_invoice_items(id,tenant_id,shop_id,sale_invoice_id,item_id,line_no,item_name_snapshot,tax_rate_bp_snapshot,unit_name_snapshot,unit_level,entry_mode,is_big_unit,qty,base_qty,price_kind,unit_price_paise,discount_paise,line_total_paise,created_by,client_id)
  values('f6000000-0000-0000-0000-000000000006',v_tenant,v_shop,'f6000000-0000-0000-0000-000000000005',v_item,1,'Phase 6 DR Fixture Item',0,'piece',3,'piece',false,1,1,'retail',12345,0,12345,v_user,'phase6-dr-sale-line');
  insert into payments(id,tenant_id,shop_id,kind,customer_id,source_sale_invoice_id,business_date,amount_paise,mode,reference,status,created_by,client_id)
  values('f6000000-0000-0000-0000-000000000007',v_tenant,v_shop,'customer','f6000000-0000-0000-0000-000000000002','f6000000-0000-0000-0000-000000000005','2026-09-11',12345,'cash','DR fixture','POSTED',v_user,'phase6-dr-payment');
  insert into expenses(id,tenant_id,shop_id,business_date,category,description,amount_paise,mode,status,created_by,client_id)
  values('f6000000-0000-0000-0000-000000000008',v_tenant,v_shop,'2026-09-11','DR fixture','Portable restore evidence',3456,'cash','POSTED',v_user,'phase6-dr-expense');
  insert into stock_movements(id,tenant_id,shop_id,item_id,source_type,source_id,qty_base,created_by,client_id)
  values
   ('f6000000-0000-0000-0000-000000000009',v_tenant,v_shop,v_item,'PURCHASE','f6000000-0000-0000-0000-000000000003',3,v_user,'phase6-dr-stock-purchase'),
   ('f6000000-0000-0000-0000-00000000000a',v_tenant,v_shop,v_item,'SALE','f6000000-0000-0000-0000-000000000005',-1,v_user,'phase6-dr-stock-sale');
  insert into stock_current(tenant_id,shop_id,item_id,on_hand,reserved)
  values(v_tenant,v_shop,v_item,2,0)
  on conflict(tenant_id,shop_id,item_id) do update set on_hand=stock_current.on_hand+2;
end
$fixture$;

set session_replication_role = origin;
