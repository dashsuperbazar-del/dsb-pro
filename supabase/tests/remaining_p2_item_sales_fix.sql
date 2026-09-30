-- P2 (COMPLETE_REMAINING_BUILD_22 §5a): item-wise net sales must use the
-- header-discount-allocated line value, not the pre-allocation line total.
-- Every expected figure is hand-derived from the fixture prices (100 paise
-- per piece), never by calling phase65_sale_line_cap in the expectation.
begin;
create extension if not exists pgtap with schema extensions;
select plan(22);

insert into auth.users(id) values('b6550000-0000-0000-0000-000000000001');
set role authenticated;
select set_config('request.jwt.claims','{"sub":"b6550000-0000-0000-0000-000000000001","role":"authenticated"}',true);
select create_tenant('P2 Co','p2-co','P2 Shop','p2-tenant');
select set_config('p2.tenant',current_tenant_id()::text,false);
select set_config('p2.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into items(tenant_id,name,unit1,client_id)
 select current_tenant_id(),'P2 Item '||n,'piece','p2-item-'||n from generate_series(1,8) n;
select set_config('p2.i'||substr(client_id,9),id::text,false) from items where client_id like 'p2-item-%';
select set_item_price(id,current_setting('p2.shop')::uuid,'retail',1::smallint,100::bigint,'p2-price-'||client_id) from items where client_id like 'p2-item-%';
select post_purchase(current_setting('p2.shop')::uuid,null,'P2-SEED','2026-09-01',0,0,'p2-seed',
 (select jsonb_agg(jsonb_build_object('item_id',id,'unit_level',1,'qty',1000,'unit_price_paise',50)) from items where client_id like 'p2-item-%'),null);

-- 1. 10000 merchandise, 1000 header discount, fully returned: nets 0.
select post_sale(current_setting('p2.shop')::uuid,null,'2026-09-10',1000,0,'p2-s1',jsonb_build_array(jsonb_build_object('item_id',current_setting('p2.i1'),'unit_level',1,'qty',100,'price_kind','retail')),jsonb_build_array(jsonb_build_object('amount_paise',9000,'mode','cash')),null);
select post_return('SALE',(select id from sale_invoices where client_id='p2-s1'),'2026-09-10','p2-r1',jsonb_build_array(jsonb_build_object('sale_invoice_item_id',(select sii.id from sale_invoice_items sii join sale_invoices si on si.id=sii.sale_invoice_id where si.client_id='p2-s1' and sii.item_id=current_setting('p2.i1')::uuid),'qty',100,'disposition','RETURN_TO_SELLABLE')),null);
-- 2. Line discount 100 plus header discount 90 on 1000 gross: 810 net.
select post_sale(current_setting('p2.shop')::uuid,null,'2026-09-11',90,0,'p2-s2',jsonb_build_array(jsonb_build_object('item_id',current_setting('p2.i2'),'unit_level',1,'qty',10,'price_kind','retail','discount_paise',100)),jsonb_build_array(jsonb_build_object('amount_paise',810,'mode','cash')),null);
-- 3. Three 100-paise lines, header discount 10: 290 split 96/96/98 (last line absorbs rounding).
select post_sale(current_setting('p2.shop')::uuid,null,'2026-09-12',10,0,'p2-s3',jsonb_build_array(jsonb_build_object('item_id',current_setting('p2.i3'),'unit_level',1,'qty',1,'price_kind','retail'),jsonb_build_object('item_id',current_setting('p2.i4'),'unit_level',1,'qty',1,'price_kind','retail'),jsonb_build_object('item_id',current_setting('p2.i5'),'unit_level',1,'qty',1,'price_kind','retail')),jsonb_build_array(jsonb_build_object('amount_paise',290,'mode','cash')),null);
-- 4. 1000 gross, 100 header discount, half returned a week later: 900 sold, 450 returned.
select post_sale(current_setting('p2.shop')::uuid,null,'2026-09-13',100,0,'p2-s4',jsonb_build_array(jsonb_build_object('item_id',current_setting('p2.i6'),'unit_level',1,'qty',10,'price_kind','retail')),jsonb_build_array(jsonb_build_object('amount_paise',900,'mode','cash')),null);
select post_return('SALE',(select id from sale_invoices where client_id='p2-s4'),'2026-09-20','p2-r4',jsonb_build_array(jsonb_build_object('sale_invoice_item_id',(select sii.id from sale_invoice_items sii join sale_invoices si on si.id=sii.sale_invoice_id where si.client_id='p2-s4' and sii.item_id=current_setting('p2.i6')::uuid),'qty',5,'disposition','RETURN_TO_SELLABLE')),null);
-- 5. Extra charges 50 stay out of merchandise net.
select post_sale(current_setting('p2.shop')::uuid,null,'2026-09-14',0,50,'p2-s5',jsonb_build_array(jsonb_build_object('item_id',current_setting('p2.i7'),'unit_level',1,'qty',10,'price_kind','retail')),jsonb_build_array(jsonb_build_object('amount_paise',1050,'mode','cash')),null);
-- 6. A voided return no longer reduces net sales.
select post_sale(current_setting('p2.shop')::uuid,null,'2026-09-15',0,0,'p2-s6',jsonb_build_array(jsonb_build_object('item_id',current_setting('p2.i8'),'unit_level',1,'qty',10,'price_kind','retail')),jsonb_build_array(jsonb_build_object('amount_paise',1000,'mode','cash')),null);
select post_return('SALE',(select id from sale_invoices where client_id='p2-s6'),'2026-09-15','p2-r6',jsonb_build_array(jsonb_build_object('sale_invoice_item_id',(select sii.id from sale_invoice_items sii join sale_invoices si on si.id=sii.sale_invoice_id where si.client_id='p2-s6' and sii.item_id=current_setting('p2.i8')::uuid),'qty',3,'disposition','RETURN_TO_SELLABLE')),null);
select void_return('SALE',(select id from sale_returns where client_id='p2-r6'),'p2-r6-void');
select is((select net_sales_paise from get_item_sales_report(current_setting('p2.shop')::uuid,'2026-09-10','2026-09-10') where item_id=current_setting('p2.i1')::uuid),0::bigint,'fully returned header-discounted invoice nets 0');
select is((select gross_sales_paise from get_item_sales_report(current_setting('p2.shop')::uuid,'2026-09-10','2026-09-10') where item_id=current_setting('p2.i1')::uuid),10000::bigint,'gross stays after-line-discount, before header allocation');
select is((select net_qty from get_item_sales_report(current_setting('p2.shop')::uuid,'2026-09-10','2026-09-10') where item_id=current_setting('p2.i1')::uuid),0::numeric,'fully returned quantity nets 0');
select is((select net_sales_paise from get_item_sales_report(current_setting('p2.shop')::uuid,'2026-09-11','2026-09-11') where item_id=current_setting('p2.i2')::uuid),810::bigint,'line plus header discount both reduce net');
select is((select gross_sales_paise from get_item_sales_report(current_setting('p2.shop')::uuid,'2026-09-11','2026-09-11') where item_id=current_setting('p2.i2')::uuid),900::bigint,'gross is after line discount only');
select is((select net_sales_paise from get_item_sales_report(current_setting('p2.shop')::uuid,'2026-09-12','2026-09-12') where item_id=current_setting('p2.i3')::uuid),96::bigint,'first of three lines gets floor share');
select is((select net_sales_paise from get_item_sales_report(current_setting('p2.shop')::uuid,'2026-09-12','2026-09-12') where item_id=current_setting('p2.i4')::uuid),96::bigint,'second of three lines gets floor share');
select is((select net_sales_paise from get_item_sales_report(current_setting('p2.shop')::uuid,'2026-09-12','2026-09-12') where item_id=current_setting('p2.i5')::uuid),98::bigint,'last line absorbs the rounding residual');
select is((select sum(net_sales_paise) from get_item_sales_report(current_setting('p2.shop')::uuid,'2026-09-12','2026-09-12'))::bigint,290::bigint,'three-line invoice nets exactly subtotal minus discount');
select is((select net_sales_paise from get_item_sales_report(current_setting('p2.shop')::uuid,'2026-09-13','2026-09-13') where item_id=current_setting('p2.i6')::uuid),900::bigint,'sale period shows the allocated sold value');
select is((select qty_returned from get_item_sales_report(current_setting('p2.shop')::uuid,'2026-09-13','2026-09-13') where item_id=current_setting('p2.i6')::uuid),0::numeric,'later return does not leak into the sale period');
select is((select net_sales_paise from get_item_sales_report(current_setting('p2.shop')::uuid,'2026-09-20','2026-09-20') where item_id=current_setting('p2.i6')::uuid),-450::bigint,'return-only period shows the stored return amount as negative net');
select is((select qty_sold from get_item_sales_report(current_setting('p2.shop')::uuid,'2026-09-20','2026-09-20') where item_id=current_setting('p2.i6')::uuid),0::numeric,'return-only period has zero sold qty');
select is((select qty_returned from get_item_sales_report(current_setting('p2.shop')::uuid,'2026-09-20','2026-09-20') where item_id=current_setting('p2.i6')::uuid),5::numeric,'return-only period row is present');
select is((select net_sales_paise from get_item_sales_report(current_setting('p2.shop')::uuid,'2026-09-13','2026-09-20') where item_id=current_setting('p2.i6')::uuid),450::bigint,'spanning period nets sold minus returned');
select is((select net_sales_paise from get_item_sales_report(current_setting('p2.shop')::uuid,'2026-09-14','2026-09-14') where item_id=current_setting('p2.i7')::uuid),1000::bigint,'extra charges excluded from merchandise net');
select is((select net_sales_paise from get_item_sales_report(current_setting('p2.shop')::uuid,'2026-09-15','2026-09-15') where item_id=current_setting('p2.i8')::uuid),1000::bigint,'voided return does not reduce net sales');
select is((select qty_returned from get_item_sales_report(current_setting('p2.shop')::uuid,'2026-09-15','2026-09-15') where item_id=current_setting('p2.i8')::uuid),0::numeric,'voided return quantity is not counted');

-- Different shops: a sale of item 1 in a second shop does not leak into shop 1.
reset role;
insert into shops(id,tenant_id,name,created_by) values('b6550000-0000-0000-0000-000000000050',current_setting('p2.tenant')::uuid,'P2 Shop Two','b6550000-0000-0000-0000-000000000001');
set role authenticated;
select set_config('request.jwt.claims','{"sub":"b6550000-0000-0000-0000-000000000001","role":"authenticated"}',true);
select set_item_price(current_setting('p2.i1')::uuid,'b6550000-0000-0000-0000-000000000050'::uuid,'retail',1::smallint,100::bigint,'p2-price-shop2');
select post_purchase('b6550000-0000-0000-0000-000000000050'::uuid,null,'P2-SEED2','2026-09-01',0,0,'p2-seed2',jsonb_build_array(jsonb_build_object('item_id',current_setting('p2.i1'),'unit_level',1,'qty',10,'unit_price_paise',50)),null);
select post_sale('b6550000-0000-0000-0000-000000000050'::uuid,null,'2026-09-10',0,0,'p2-s-shop2',jsonb_build_array(jsonb_build_object('item_id',current_setting('p2.i1'),'unit_level',1,'qty',2,'price_kind','retail')),jsonb_build_array(jsonb_build_object('amount_paise',200,'mode','cash')),null);
select is((select qty_sold from get_item_sales_report(current_setting('p2.shop')::uuid,'2026-09-10','2026-09-10') where item_id=current_setting('p2.i1')::uuid),100::numeric,'other shop sale not counted in shop 1');
select is((select net_sales_paise from get_item_sales_report(current_setting('p2.shop')::uuid,'2026-09-10','2026-09-10') where item_id=current_setting('p2.i1')::uuid),0::bigint,'other shop sale does not change shop 1 net');
select is((select net_sales_paise from get_item_sales_report('b6550000-0000-0000-0000-000000000050'::uuid,'2026-09-10','2026-09-10') where item_id=current_setting('p2.i1')::uuid),200::bigint,'shop 2 reports its own sale');
select ok(not has_function_privilege('anon','get_item_sales_report(uuid,date,date)','execute'),'anon still cannot execute');

select * from finish();
rollback;
