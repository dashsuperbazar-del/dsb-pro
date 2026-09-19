begin;
create extension if not exists pgtap with schema extensions;
select plan(35);

insert into auth.users(id) values ('b6540000-0000-0000-0000-000000000001');

set role authenticated;
select set_config('request.jwt.claims','{"sub":"b6540000-0000-0000-0000-000000000001","role":"authenticated"}',true);
select lives_ok($$select create_tenant('Stock Recovery Co','stock-recovery-co','Recovery Shop','sr-tenant')$$,'create stock-recovery tenant');
select set_config('sr.tenant',current_tenant_id()::text,false);
select set_config('sr.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
select lives_ok($$insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'Recovery Item','piece','sr-item')$$,'create recovery item');
select set_config('sr.item',(select id::text from items where client_id='sr-item'),false);
select lives_ok($$select set_item_price(current_setting('sr.item')::uuid,current_setting('sr.shop')::uuid,'retail',1::smallint,100::bigint,'sr-price')$$,'set recovery retail price');
select lives_ok($$select update_shop_settings(current_setting('sr.shop')::uuid,'Recovery Shop','','','','Asia/Kolkata','80mm',4::smallint,true)$$,'owner enables sale-only negative-stock override');
select lives_ok($$select post_purchase(current_setting('sr.shop')::uuid,null,'SR-SEED','2026-09-19',0,0,'sr-seed',jsonb_build_array(jsonb_build_object('item_id',current_setting('sr.item'),'unit_level',1,'qty',2,'unit_price_paise',50)),null)$$,'seed two recovery units');
select lives_ok($$select post_sale(current_setting('sr.shop')::uuid,null,'2026-09-19',0,0,'sr-oversell',jsonb_build_array(jsonb_build_object('item_id',current_setting('sr.item'),'unit_level',1,'qty',5,'price_kind','retail')),jsonb_build_array(jsonb_build_object('amount_paise',500,'mode','cash')),null)$$,'authorized override creates the test balance');
select is((select on_hand from stock_current where tenant_id=current_tenant_id() and shop_id=current_setting('sr.shop')::uuid and item_id=current_setting('sr.item')::uuid),(-3)::numeric,'test balance starts at negative three');

select lives_ok($$select post_purchase(current_setting('sr.shop')::uuid,null,'SR-REC-1','2026-09-19',0,0,'sr-rec-1',jsonb_build_array(jsonb_build_object('item_id',current_setting('sr.item'),'unit_level',1,'qty',1,'unit_price_paise',50)),null)$$,'first incremental purchase succeeds');
select is((select on_hand from stock_current where tenant_id=current_tenant_id() and shop_id=current_setting('sr.shop')::uuid and item_id=current_setting('sr.item')::uuid),(-2)::numeric,'first purchase improves negative three to negative two');
select lives_ok($$select post_purchase(current_setting('sr.shop')::uuid,null,'SR-REC-2','2026-09-19',0,0,'sr-rec-2',jsonb_build_array(jsonb_build_object('item_id',current_setting('sr.item'),'unit_level',1,'qty',1,'unit_price_paise',50)),null)$$,'second incremental purchase succeeds');
select is((select on_hand from stock_current where tenant_id=current_tenant_id() and shop_id=current_setting('sr.shop')::uuid and item_id=current_setting('sr.item')::uuid),(-1)::numeric,'second purchase improves negative two to negative one');
select lives_ok($$select post_purchase(current_setting('sr.shop')::uuid,null,'SR-REC-3','2026-09-19',0,0,'sr-rec-3',jsonb_build_array(jsonb_build_object('item_id',current_setting('sr.item'),'unit_level',1,'qty',1,'unit_price_paise',50)),null)$$,'third incremental purchase succeeds');
select is((select on_hand from stock_current where tenant_id=current_tenant_id() and shop_id=current_setting('sr.shop')::uuid and item_id=current_setting('sr.item')::uuid),0::numeric,'three one-unit purchases recover exactly to zero');
select throws_ok($$select void_purchase((select id from purchase_bills where client_id='sr-seed'),'sr-seed-void')$$,null,'insufficient stock','purchase void cannot deepen an unavailable balance');
select is((select status from purchase_bills where client_id='sr-seed'),'POSTED','blocked purchase void preserves source status');
select is((select on_hand from stock_current where tenant_id=current_tenant_id() and shop_id=current_setting('sr.shop')::uuid and item_id=current_setting('sr.item')::uuid),0::numeric,'blocked purchase void preserves stock');
select throws_ok($$select post_return('PURCHASE',(select id from purchase_bills where client_id='sr-rec-1'),'2026-09-19','sr-purchase-return-blocked',jsonb_build_array(jsonb_build_object('purchase_bill_item_id',(select id from purchase_bill_items where purchase_bill_id=(select id from purchase_bills where client_id='sr-rec-1')),'qty',1,'disposition','SUPPLIER_RETURN')),null)$$,null,'insufficient stock for purchase return','purchase return cannot deepen an unavailable balance');
select is((select count(*) from purchase_returns where client_id='sr-purchase-return-blocked'),0::bigint,'blocked purchase return leaves no financial document');

-- A sellable customer return is a positive recovery movement. Damaged goods
-- carry the financial return but create no sellable movement.
insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'Return Recovery Item','piece','sr-return-item');
select set_config('sr.return_item',(select id::text from items where client_id='sr-return-item'),false);
select set_item_price(current_setting('sr.return_item')::uuid,current_setting('sr.shop')::uuid,'retail',1::smallint,100::bigint,'sr-return-price');
select post_purchase(current_setting('sr.shop')::uuid,null,'SR-RETURN-SEED','2026-09-19',0,0,'sr-return-seed',jsonb_build_array(jsonb_build_object('item_id',current_setting('sr.return_item'),'unit_level',1,'qty',2,'unit_price_paise',50)),null);
select post_sale(current_setting('sr.shop')::uuid,null,'2026-09-19',0,0,'sr-return-sale',jsonb_build_array(jsonb_build_object('item_id',current_setting('sr.return_item'),'unit_level',1,'qty',5,'price_kind','retail')),jsonb_build_array(jsonb_build_object('amount_paise',500,'mode','cash')),null);
select set_config('sr.return_sale',(select id::text from sale_invoices where client_id='sr-return-sale'),false);
select set_config('sr.return_line',(select id::text from sale_invoice_items where sale_invoice_id=current_setting('sr.return_sale')::uuid),false);
select lives_ok(format($q$select post_return('SALE',%L::uuid,'2026-09-19','sr-sellable-return',jsonb_build_array(jsonb_build_object('sale_invoice_item_id',%L::uuid,'qty',1,'disposition','RETURN_TO_SELLABLE')),null)$q$,current_setting('sr.return_sale'),current_setting('sr.return_line')),'sellable return improves negative stock');
select is((select on_hand from stock_current where tenant_id=current_tenant_id() and shop_id=current_setting('sr.shop')::uuid and item_id=current_setting('sr.return_item')::uuid),(-2)::numeric,'sellable return improves negative three to negative two');
select lives_ok(format($q$select post_return('SALE',%L::uuid,'2026-09-19','sr-damaged-return',jsonb_build_array(jsonb_build_object('sale_invoice_item_id',%L::uuid,'qty',1,'disposition','DAMAGED')),null)$q$,current_setting('sr.return_sale'),current_setting('sr.return_line')),'damaged customer return posts financially');
select is((select on_hand from stock_current where tenant_id=current_tenant_id() and shop_id=current_setting('sr.shop')::uuid and item_id=current_setting('sr.return_item')::uuid),(-2)::numeric,'damaged return does not increase sellable stock');
select lives_ok($$select post_sale(current_setting('sr.shop')::uuid,null,'2026-09-19',0,0,'sr-return-resold',jsonb_build_array(jsonb_build_object('item_id',current_setting('sr.return_item'),'unit_level',1,'qty',1,'price_kind','retail')),jsonb_build_array(jsonb_build_object('amount_paise',100,'mode','cash')),null)$$,'override permits returned stock to be sold before return void');
select throws_ok($$select void_return('SALE',(select id from sale_returns where client_id='sr-sellable-return'),'sr-sellable-return-void')$$,null,'insufficient stock to void sale return','sale-return void cannot manufacture stock after returned unit was sold');
select is((select status from sale_returns where client_id='sr-sellable-return'),'POSTED','blocked sale-return void preserves posted return');

-- Stock counts retain their absolute, nonnegative correction model. A count
-- from negative stock to zero is a positive recovery and succeeds. A negative
-- adjustment that would consume a reservation remains blocked.
select set_config('sr.negative_count',(select create_stock_count(current_setting('sr.shop')::uuid,'2026-09-19',jsonb_build_array(jsonb_build_object('item_id',current_setting('sr.return_item'),'counted_qty',0,'reason','physical zero')),'recover negative count','sr-negative-count')::text),false);
select lives_ok($$select post_stock_count(current_setting('sr.negative_count')::uuid)$$,'absolute count reconciles negative stock to zero');
select is((select on_hand from stock_current where tenant_id=current_tenant_id() and shop_id=current_setting('sr.shop')::uuid and item_id=current_setting('sr.return_item')::uuid),0::numeric,'negative stock count lands exactly at nonnegative counted quantity');
select is((select status from stock_counts where id=current_setting('sr.negative_count')::uuid),'POSTED','recovery count is posted through the append-only ledger');

insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'Reserved Count Item','piece','sr-count-item');
select set_config('sr.count_item',(select id::text from items where client_id='sr-count-item'),false);
select post_purchase(current_setting('sr.shop')::uuid,null,'SR-COUNT-SEED','2026-09-19',0,0,'sr-count-seed',jsonb_build_array(jsonb_build_object('item_id',current_setting('sr.count_item'),'unit_level',1,'qty',2,'unit_price_paise',50)),null);
reset role;
update stock_current set reserved=1 where tenant_id=current_setting('sr.tenant')::uuid and shop_id=current_setting('sr.shop')::uuid and item_id=current_setting('sr.count_item')::uuid;
set role authenticated;
select set_config('request.jwt.claims','{"sub":"b6540000-0000-0000-0000-000000000001","role":"authenticated"}',true);
select set_config('sr.blocked_count',(select create_stock_count(current_setting('sr.shop')::uuid,'2026-09-19',jsonb_build_array(jsonb_build_object('item_id',current_setting('sr.count_item'),'counted_qty',0,'reason','would consume reservation')),'blocked negative count','sr-blocked-count')::text),false);
select throws_ok($$select post_stock_count(current_setting('sr.blocked_count')::uuid)$$,null,'insufficient stock','negative count adjustment cannot consume reserved stock');
select is((select status from stock_counts where id=current_setting('sr.blocked_count')::uuid),'DRAFT','blocked count remains draft for correction');
select is((select on_hand from stock_current where tenant_id=current_tenant_id() and shop_id=current_setting('sr.shop')::uuid and item_id=current_setting('sr.count_item')::uuid),2::numeric,'blocked negative adjustment leaves projection unchanged');
select is((select available from stock_current where tenant_id=current_tenant_id() and shop_id=current_setting('sr.shop')::uuid and item_id=current_setting('sr.count_item')::uuid),1::numeric,'available remains the derived on-hand-minus-reserved balance');

select lives_ok($$select update_shop_settings(current_setting('sr.shop')::uuid,'Recovery Shop','','','','Asia/Kolkata','80mm',4::smallint,false)$$,'owner disables negative-stock override');
select throws_ok($$select post_sale(current_setting('sr.shop')::uuid,null,'2026-09-19',0,0,'sr-no-override',jsonb_build_array(jsonb_build_object('item_id',current_setting('sr.item'),'unit_level',1,'qty',1,'price_kind','retail')),jsonb_build_array(jsonb_build_object('amount_paise',100,'mode','cash')),null)$$,null,'insufficient stock','sale without override still fails at zero stock');
select is((select on_hand from stock_current where tenant_id=current_tenant_id() and shop_id=current_setting('sr.shop')::uuid and item_id=current_setting('sr.item')::uuid),0::numeric,'blocked non-override sale leaves stock unchanged');

select * from finish();
rollback;
