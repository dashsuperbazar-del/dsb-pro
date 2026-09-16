begin;
create extension if not exists pgtap with schema extensions;
select plan(69);

insert into auth.users(id) values
 ('b6500000-0000-0000-0000-000000000001'),
 ('b6500000-0000-0000-0000-000000000002'),
 ('b6500000-0000-0000-0000-000000000003') on conflict do nothing;

set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','b6500000-0000-0000-0000-000000000001','role','authenticated')::text,true);
select lives_ok($$select create_tenant('Returns A','returns-a','Returns Shop','r65-tenant')$$,'create returns tenant');
select set_config('r65.tenant',current_tenant_id()::text,false);
select set_config('r65.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
select lives_ok($$insert into customers(tenant_id,name,client_id) values(current_tenant_id(),'Return Customer','r65-customer')$$,'create return customer');
select set_config('r65.customer',(select id::text from customers where client_id='r65-customer'),false);
select lives_ok($$insert into parties(tenant_id,name,client_id) values(current_tenant_id(),'Return Supplier','r65-party')$$,'create return supplier');
select set_config('r65.party',(select id::text from parties where client_id='r65-party'),false);
select lives_ok($$insert into items(tenant_id,name,unit1,tax_rate_bp,client_id) values(current_tenant_id(),'Return Item','piece',0,'r65-item')$$,'create return item');
select set_config('r65.item',(select id::text from items where client_id='r65-item'),false);
select lives_ok(format($q$select set_item_price(%L::uuid,%L::uuid,'retail',1::smallint,100::bigint,'r65-price')$q$,current_setting('r65.item'),current_setting('r65.shop')),'set return item price');
select lives_ok(format($q$select post_purchase(%L::uuid,%L::uuid,'R65-BILL','2026-09-15',0,0,'r65-purchase',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',1,'qty',20,'unit_price_paise',50)),null)$q$,current_setting('r65.shop'),current_setting('r65.party'),current_setting('r65.item')),'seed twenty pieces from a supplier bill');
select set_config('r65.purchase',(select id::text from purchase_bills where client_id='r65-purchase'),false);
select is((select qty_base from stock_current where shop_id=current_setting('r65.shop')::uuid and item_id=current_setting('r65.item')::uuid),20::numeric,'opening stock is twenty pieces');

select lives_ok(format($q$select post_sale(%L::uuid,%L::uuid,'2026-09-15',0,0,'r65-part-paid',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',1,'qty',4,'price_kind','retail')),jsonb_build_array(jsonb_build_object('amount_paise',150,'mode','cash')),null)$q$,current_setting('r65.shop'),current_setting('r65.customer'),current_setting('r65.item')),'post partly paid four-piece sale');
select set_config('r65.sale',(select id::text from sale_invoices where client_id='r65-part-paid'),false);
select set_config('r65.sale_line',(select id::text from sale_invoice_items where sale_invoice_id=current_setting('r65.sale')::uuid),false);
select is((select direction from payments where client_id='r65-part-paid:pay:1'),'in','existing receipt defaults to incoming direction');

select lives_ok(format($q$select post_return('SALE',%L::uuid,'2026-09-15','r65-return-1',jsonb_build_array(jsonb_build_object('sale_invoice_item_id',%L,'qty',2,'disposition','RETURN_TO_SELLABLE')),'part-paid return')$q$,current_setting('r65.sale'),current_setting('r65.sale_line')),'post a partly-paid sale return');
select set_config('r65.return1',(select id::text from sale_returns where client_id='r65-return-1'),false);
select is((select total_paise from sale_returns where id=current_setting('r65.return1')::uuid),200::bigint,'sale return value is server-calculated from original line');
select is((select cash_refund_paise from sale_returns where id=current_setting('r65.return1')::uuid),150::bigint,'cash refund is capped at amount received against invoice');
select is((select balance_credit_paise from sale_returns where id=current_setting('r65.return1')::uuid),50::bigint,'unpaid remainder credits customer balance');
select is((select count(*) from payments where source_sale_return_id=current_setting('r65.return1')::uuid and direction='out' and amount_paise=150 and status='POSTED'),1::bigint,'one outgoing refund payment is linked to return');
select is((select client_id from payments where source_sale_return_id=current_setting('r65.return1')::uuid),'r65-return-1:refund','refund client id is derived deterministically');
select is((select qty_base from stock_current where shop_id=current_setting('r65.shop')::uuid and item_id=current_setting('r65.item')::uuid),18::numeric,'sellable return restores exact stock');
select is((select balance_paise from customer_balances where customer_id=current_setting('r65.customer')::uuid),200::bigint,'return, receipt and refund net to correct customer balance');
select lives_ok(format($q$select post_return('SALE',%L::uuid,'2026-09-15','r65-return-1',jsonb_build_array(jsonb_build_object('sale_invoice_item_id',%L,'qty',2,'disposition','RETURN_TO_SELLABLE')),'part-paid return')$q$,current_setting('r65.sale'),current_setting('r65.sale_line')),'same return replay resolves idempotently');
select is((select count(*) from payments where source_sale_return_id=current_setting('r65.return1')::uuid),1::bigint,'return replay never refunds twice');
select throws_ok(format($q$select post_return('SALE',%L::uuid,'2026-09-15','r65-return-1',jsonb_build_array(jsonb_build_object('sale_invoice_item_id',%L,'qty',1,'disposition','RETURN_TO_SELLABLE')),'changed payload')$q$,current_setting('r65.sale'),current_setting('r65.sale_line')),null,'client_id already used with different return payload','same client id with changed payload is rejected');

select lives_ok(format($q$select post_return('SALE',%L::uuid,'2026-09-15','r65-return-2',jsonb_build_array(jsonb_build_object('sale_invoice_item_id',%L,'qty',2,'disposition','DAMAGED')),null)$q$,current_setting('r65.sale'),current_setting('r65.sale_line')),'post remaining quantity as damaged');
select set_config('r65.return2',(select id::text from sale_returns where client_id='r65-return-2'),false);
select is((select cash_refund_paise from sale_returns where id=current_setting('r65.return2')::uuid),0::bigint,'second return pays no cash after received amount was refunded');
select is((select balance_credit_paise from sale_returns where id=current_setting('r65.return2')::uuid),200::bigint,'second return is entirely a balance credit');
select is((select qty_base from stock_current where shop_id=current_setting('r65.shop')::uuid and item_id=current_setting('r65.item')::uuid),18::numeric,'damaged sale return does not enter sellable stock');
select is((select balance_paise from customer_balances where customer_id=current_setting('r65.customer')::uuid),0::bigint,'full return clears partly-paid invoice without overpaying cash');
select throws_ok(format($q$select post_return('SALE',%L::uuid,'2026-09-15','r65-return-over',jsonb_build_array(jsonb_build_object('sale_invoice_item_id',%L,'qty',1,'disposition','RETURN_TO_SELLABLE')),null)$q$,current_setting('r65.sale'),current_setting('r65.sale_line')),null,'sale return quantity exceeds sold quantity','cumulative sale returns cannot exceed sold quantity');
select throws_ok(format($q$select void_sale(%L::uuid,'r65-source-void-blocked')$q$,current_setting('r65.sale')),null,'void posted returns before voiding the sale','source sale cannot be voided while a return is posted');

reset role;
select throws_ok(format($q$insert into payment_allocations(tenant_id,payment_id,doc_type,sale_invoice_id,amount_paise,status,client_id) values(%L::uuid,(select id from payments where client_id='r65-return-1:refund'),'SALE',%L::uuid,1,'POSTED','r65-out-allocation')$q$,current_setting('r65.tenant'),current_setting('r65.sale')),null,'payment unavailable','outgoing refund cannot be allocated as incoming money');
set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','b6500000-0000-0000-0000-000000000001','role','authenticated')::text,true);

select lives_ok(format($q$select void_return('SALE',%L::uuid,'r65-void-return-2')$q$,current_setting('r65.return2')),'void damaged return');
select is((select status from sale_returns where id=current_setting('r65.return2')::uuid),'VOID','sale return remains as voided history');
select lives_ok(format($q$select void_return('SALE',%L::uuid,'r65-void-return-1')$q$,current_setting('r65.return1')),'void sellable/refunded return');
select is((select status from payments where client_id='r65-return-1:refund'),'VOID','voiding return reverses its refund payment');
select is((select qty_base from stock_current where shop_id=current_setting('r65.shop')::uuid and item_id=current_setting('r65.item')::uuid),16::numeric,'voiding sellable return reverses returned stock');
select lives_ok(format($q$select void_sale(%L::uuid,'r65-source-void')$q$,current_setting('r65.sale')),'source sale can be voided after every return is voided');
select is((select qty_base from stock_current where shop_id=current_setting('r65.shop')::uuid and item_id=current_setting('r65.item')::uuid),20::numeric,'sale and return void movements net exactly');

select lives_ok(format($q$select post_sale(%L::uuid,null,'2026-09-15',0,0,'r65-walkin',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',1,'qty',2,'price_kind','retail')),jsonb_build_array(jsonb_build_object('amount_paise',200,'mode','cash')),null)$q$,current_setting('r65.shop'),current_setting('r65.item')),'post paid walk-in sale');
select set_config('r65.walkin',(select id::text from sale_invoices where client_id='r65-walkin'),false);
select lives_ok(format($q$select post_return('SALE',%L::uuid,'2026-09-15','r65-walkin-return',jsonb_build_array(jsonb_build_object('sale_invoice_item_id',(select id from sale_invoice_items where sale_invoice_id=%L::uuid),'qty',1,'disposition','RETURN_TO_SELLABLE')),null)$q$,current_setting('r65.walkin'),current_setting('r65.walkin')),'walk-in return posts');
select is((select cash_refund_paise from sale_returns where client_id='r65-walkin-return'),100::bigint,'paid walk-in receives full cash refund');

select lives_ok(format($q$select post_sale(%L::uuid,%L::uuid,'2026-09-15',0,0,'r65-unpaid',jsonb_build_array(jsonb_build_object('item_id',%L,'unit_level',1,'qty',1,'price_kind','retail')),'[]'::jsonb,null)$q$,current_setting('r65.shop'),current_setting('r65.customer'),current_setting('r65.item')),'post wholly unpaid credit sale');
select set_config('r65.unpaid',(select id::text from sale_invoices where client_id='r65-unpaid'),false);
select lives_ok(format($q$select post_return('SALE',%L::uuid,'2026-09-15','r65-unpaid-return',jsonb_build_array(jsonb_build_object('sale_invoice_item_id',(select id from sale_invoice_items where sale_invoice_id=%L::uuid),'qty',1,'disposition','DAMAGED')),null)$q$,current_setting('r65.unpaid'),current_setting('r65.unpaid')),'unpaid sale return posts');
select is((select cash_refund_paise from sale_returns where client_id='r65-unpaid-return'),0::bigint,'unpaid credit return never pays cash');

select lives_ok(format($q$select post_return('PURCHASE',%L::uuid,'2026-09-15','r65-purchase-return',jsonb_build_array(jsonb_build_object('purchase_bill_item_id',(select id from purchase_bill_items where purchase_bill_id=%L::uuid),'qty',2,'disposition','SUPPLIER_RETURN')),null)$q$,current_setting('r65.purchase'),current_setting('r65.purchase')),'post supplier purchase return');
select set_config('r65.purchase_return',(select id::text from purchase_returns where client_id='r65-purchase-return'),false);
select is((select total_paise from purchase_returns where id=current_setting('r65.purchase_return')::uuid),100::bigint,'purchase return uses original purchase value');
select is((select qty_base from stock_current where shop_id=current_setting('r65.shop')::uuid and item_id=current_setting('r65.item')::uuid),16::numeric,'purchase return removes sellable stock');
select is((select credit_paise from get_party_ledger(current_setting('r65.party')::uuid,'2026-09-15','2026-09-15') where entry_type='PURCHASE_RETURN'),100::bigint,'purchase return credits supplier ledger');
select throws_ok(format($q$select void_purchase(%L::uuid,'r65-purchase-void-blocked')$q$,current_setting('r65.purchase')),null,'void posted returns before voiding the purchase','source purchase cannot be voided while return is posted');
select lives_ok(format($q$select void_return('PURCHASE',%L::uuid,'r65-purchase-return-void')$q$,current_setting('r65.purchase_return')),'void purchase return');
select is((select qty_base from stock_current where shop_id=current_setting('r65.shop')::uuid and item_id=current_setting('r65.item')::uuid),18::numeric,'purchase return void restores stock');

select is((select sales_paise from get_day_book(current_setting('r65.shop')::uuid,'2026-09-15','2026-09-15')),100::bigint,'day book nets active sale returns from sales');
select is((select receipts_paise from get_day_book(current_setting('r65.shop')::uuid,'2026-09-15','2026-09-15')),100::bigint,'day book permits net receipts after cash refund');
select is((select gross_sales_paise from get_gst_summary(current_setting('r65.shop')::uuid,'2026-09-15','2026-09-15') where tax_rate_bp=0),100::bigint,'GST summary nets return snapshots');
select is((get_shop_day_reconciliation(current_setting('r65.shop')::uuid,'2026-09-15')->>'saleReturnTotalPaise')::bigint,200::bigint,'day reconciliation exposes active return total');
select is((get_shop_day_reconciliation(current_setting('r65.shop')::uuid,'2026-09-15')->'paymentModes'->>'cash')::bigint,100::bigint,'day reconciliation cash can net refunds');
select ok((check_invariants()->>'ok')::boolean,'all return, refund, stock and ledger invariants pass');
select ok(phase6_export_tenant(current_setting('r65.shop')::uuid) ?& array['saleReturns','saleReturnLines','purchaseReturns','purchaseReturnLines'],'portable export contains all four return tables');

reset role;
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id)
 values(current_setting('r65.tenant')::uuid,'b6500000-0000-0000-0000-000000000002','cashier',array[current_setting('r65.shop')::uuid],'active','r65-cashier');
set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','b6500000-0000-0000-0000-000000000002','role','authenticated')::text,true);
select throws_ok(format($q$select post_return('PURCHASE',%L::uuid,'2026-09-15','r65-cashier-purchase-return',jsonb_build_array(jsonb_build_object('purchase_bill_item_id',(select id from purchase_bill_items where purchase_bill_id=%L::uuid),'qty',1,'disposition','SUPPLIER_RETURN')),null)$q$,current_setting('r65.purchase'),current_setting('r65.purchase')),null,'not permitted','cashier cannot post purchase return');
select throws_ok(format($q$select void_return('SALE',%L::uuid,'r65-cashier-void')$q$,(select id from sale_returns where client_id='r65-walkin-return')),null,'not permitted','cashier cannot void sale return');

-- Return yesterday's remaining walk-in piece on a day with zero sales.
-- Restore owner identity after the preceding cashier permission assertions.
select set_config('request.jwt.claims',json_build_object('sub','b6500000-0000-0000-0000-000000000001','role','authenticated')::text,true);
select lives_ok(format($q$select post_return('SALE',%L::uuid,'2026-09-16','r65-next-day-return',jsonb_build_array(jsonb_build_object('sale_invoice_item_id',(select id from sale_invoice_items where sale_invoice_id=%L::uuid),'qty',1,'disposition','RETURN_TO_SELLABLE')),null)$q$,current_setting('r65.walkin'),current_setting('r65.walkin')),'return previous-day item with no sales today');
select set_config('r65.nextday',get_shop_day_reconciliation(current_setting('r65.shop')::uuid,'2026-09-16')::text,false);
select is((current_setting('r65.nextday')::jsonb->>'invoiceCount')::bigint,0::bigint,'refund-only day has zero sales');
select is(jsonb_array_length(current_setting('r65.nextday')::jsonb->'soldItems'),1,'return-only item remains in reconciliation');
select is((current_setting('r65.nextday')::jsonb->'soldItems'->0->>'soldQtySmallest')::numeric,-1::numeric,'return-only item shows negative net quantity');
select is((current_setting('r65.nextday')::jsonb->'soldItems'->0->>'saleLines')::bigint,0::bigint,'return-only item has zero sale lines');
select is((current_setting('r65.nextday')::jsonb->'paymentModes'->>'cash')::bigint,-100::bigint,'refund-only day permits negative cash');
select is((select receipts_paise from get_day_book(current_setting('r65.shop')::uuid,'2026-09-16','2026-09-16')),-100::bigint,'day book preserves negative net receipts');
-- Exercise the other outer-join side: another item sold today, never returned.
insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'Sold Only Item','piece','r65-sold-only');
select set_config('r65.other_item',(select id::text from items where client_id='r65-sold-only'),false);
select set_item_price(current_setting('r65.other_item')::uuid,current_setting('r65.shop')::uuid,'retail',1::smallint,10::bigint,'r65-other-price');
select post_purchase(current_setting('r65.shop')::uuid,null,'OTHER-SEED','2026-09-16',0,0,'r65-other-purchase',jsonb_build_array(jsonb_build_object('item_id',current_setting('r65.other_item'),'unit_level',1,'qty',5,'unit_price_paise',5)),null);
select post_sale(current_setting('r65.shop')::uuid,null,'2026-09-16',0,0,'r65-other-sale',jsonb_build_array(jsonb_build_object('item_id',current_setting('r65.other_item'),'unit_level',1,'qty',1,'price_kind','retail')),jsonb_build_array(jsonb_build_object('amount_paise',10,'mode','cash')),null);
select is(jsonb_array_length(get_shop_day_reconciliation(current_setting('r65.shop')::uuid,'2026-09-16')->'soldItems'),2,'full outer join retains sold-only and return-only items');
select is((select (x->>'soldQtySmallest')::numeric from jsonb_array_elements(get_shop_day_reconciliation(current_setting('r65.shop')::uuid,'2026-09-16')->'soldItems') x where x->>'itemId'=current_setting('r65.other_item')),1::numeric,'sold-only item retains positive quantity');

reset role;
insert into tenants(id,name,slug,created_by) values('b6500000-0000-0000-0000-000000000099','Returns B','returns-b','b6500000-0000-0000-0000-000000000003');
insert into shops(id,tenant_id,name,is_default,created_by) values('b6500000-0000-0000-0000-000000000098','b6500000-0000-0000-0000-000000000099','Other Shop',true,'b6500000-0000-0000-0000-000000000003');
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id) values('b6500000-0000-0000-0000-000000000099','b6500000-0000-0000-0000-000000000003','owner',array['b6500000-0000-0000-0000-000000000098'::uuid],'active','r65-other-owner');
set role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','b6500000-0000-0000-0000-000000000003','role','authenticated')::text,true);
select is((select count(*) from sale_returns where client_id like 'r65-%'),0::bigint,'second tenant cannot read first tenant sale returns');
select is((select count(*) from purchase_returns where client_id like 'r65-%'),0::bigint,'second tenant cannot read first tenant purchase returns');
select throws_ok(format($q$select post_return('SALE',%L::uuid,'2026-09-15','r65-cross-return',jsonb_build_array(jsonb_build_object('sale_invoice_item_id',%L::uuid,'qty',1,'disposition','RETURN_TO_SELLABLE')),null)$q$,current_setting('r65.sale'),current_setting('r65.sale_line')),null,'sale unavailable for return','cross-tenant attempt is rejected before mutation');

select * from finish();
rollback;
