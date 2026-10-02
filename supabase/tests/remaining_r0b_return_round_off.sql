-- Packet R0b (mig 0053): the return that completes a rounded bill also reverses its round-off (user decision 2026-10-02).
begin;
create extension if not exists pgtap with schema extensions;
select plan(20);
insert into auth.users(id) values ('a0a00000-0000-0000-0000-000000000001');
set role authenticated;
select set_config('request.jwt.claims','{"sub":"a0a00000-0000-0000-0000-000000000001","role":"authenticated"}',true);
select create_tenant('R0 Co','r0-co','R0 Shop','r0-tenant');
select register_device('r0-phone','r0-test');
select set_config('r0.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'R0 Item','piece','r0-item');
select set_config('r0.item',(select id::text from items where client_id='r0-item'),false);
insert into customers(tenant_id,name,client_id) values(current_tenant_id(),'R0 Customer','r0-cust');
select set_item_price(current_setting('r0.item')::uuid,current_setting('r0.shop')::uuid,'retail',1::smallint,1049::bigint,'r0-price');
select post_purchase(current_setting('r0.shop')::uuid,null,'R0-SEED','2026-09-01',0,0,'r0-seed',
 jsonb_build_array(jsonb_build_object('item_id',current_setting('r0.item'),'unit_level',1,'qty',100,'unit_price_paise',500)),null);

-- helper: one line of qty 1 at 10.49, optional extra charge and line discount, paid p_paid (null = credit)
create function pg_temp.sale(p_fn text,p_client text,p_extra bigint,p_paid bigint,p_customer boolean default false) returns jsonb language plpgsql as $$
declare r jsonb;
begin
 execute format('select %s(%L,1,%L::uuid,%s,%L,0,%s,%L,%L::jsonb,%L::jsonb,null)',p_fn,'r0-phone',current_setting('r0.shop'),
   case when p_customer then quote_literal((select id from customers where client_id='r0-cust'))||'::uuid' else 'null' end,
   '2026-09-20',p_extra,p_client,
   jsonb_build_array(jsonb_build_object('item_id',current_setting('r0.item'),'unit_level',1,'qty',1,'price_kind','retail','discount_paise',0,'expected_unit_price_paise',1049)),
   case when p_paid is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('amount_paise',p_paid,'mode','cash')) end) into r;
 return r;
end $$;
create function pg_temp.inv(p_client text) returns sale_invoices language sql as $$ select * from sale_invoices where client_id=p_client $$;
create function pg_temp.ret(p_client text,p_rc text,p_qty numeric default 1) returns sale_returns language plpgsql as $$
declare r sale_returns;
begin
 perform post_return('SALE',(pg_temp.inv(p_client)).id,'2026-09-21',p_rc,jsonb_build_array(jsonb_build_object(
   'sale_invoice_item_id',(select id from sale_invoice_items where sale_invoice_id=(pg_temp.inv(p_client)).id),
   'qty',p_qty,'disposition','RETURN_TO_SELLABLE')),null);
 select * into r from sale_returns where client_id=p_rc; return r;
end $$;
create function pg_temp.bal() returns bigint language sql as
 $$ select coalesce(sum(debit_paise-credit_paise),0)::bigint from customer_ledger where customer_id=(select id from customers where client_id='r0-cust') $$;

-- A: walk-in, 10.49 -> 10.00 paid in cash, returned in full: refund exactly 10.00, no stray credit.
select pg_temp.sale('r0_sync_post_sale','A',0,1000);
select is((pg_temp.ret('A','A-r')).total_paise,1000::bigint,'full return of a rounded-down bill is valued at the bill total');
select is((select cash_refund_paise from sale_returns where client_id='A-r'),1000::bigint,'refund equals what was paid');
select is((select balance_credit_paise from sale_returns where client_id='A-r'),0::bigint,'no stray walk-in credit');
select is((select round_off_paise from sale_returns where client_id='A-r'),-49::bigint,'the completing return carries the bill round-off');

-- B: customer credit sale 10.00 owed, returned in full: balance back to exactly zero.
select pg_temp.sale('r0_sync_post_sale','B',0,null,true);
select is((pg_temp.ret('B','B-r')).total_paise,1000::bigint,'credit bill full return valued at the bill total');
select is(pg_temp.bal(),0::bigint,'customer balance returns to zero, no unpaid credit');

-- C: walk-in 10.50 -> 11.00 paid; full return refunds 11.00 minus the extra charge only.
select pg_temp.sale('r0_sync_post_sale','C',1,1100);
select is((pg_temp.ret('C','C-r')).total_paise,1099::bigint,'rounded-up bill: item value + round-off (extra charge stays with the shop as before)');
select is((select cash_refund_paise from sale_returns where client_id='C-r'),1099::bigint,'refund includes the round-up');

-- D: two units 2 x 10.49 = 20.98 -> 21.00; partial returns carry item value, the last one the round-off.
select lives_ok($$select r0_sync_post_sale('r0-phone',1,current_setting('r0.shop')::uuid,null,'2026-09-20',0,0,'D',
  jsonb_build_array(jsonb_build_object('item_id',current_setting('r0.item'),'unit_level',1,'qty',2,'price_kind','retail','discount_paise',0,'expected_unit_price_paise',1049)),
  jsonb_build_array(jsonb_build_object('amount_paise',2100,'mode','cash')),null)$$,'two-unit rounded sale posts');
select is((pg_temp.ret('D','D-r1')).total_paise,1049::bigint,'first partial return: item value only');
select is((select round_off_paise from sale_returns where client_id='D-r1'),0::bigint,'partial return carries no round-off');
select is((pg_temp.ret('D','D-r2')).total_paise,1051::bigint,'completing return adds the +2 round-off');
select is((select sum(total_paise) from sale_returns where sale_invoice_id=(pg_temp.inv('D')).id and status='POSTED')::bigint,2100::bigint,'all returns together equal the bill total');

-- E: a void of the completing return, then the same quantity returned again, carries it again (once).
select lives_ok($$select void_return('SALE',(select id from sale_returns where client_id='D-r2'),'D-r2-void')$$,'completing return can be voided');
select is((pg_temp.ret('D','D-r3')).round_off_paise,2::bigint,'the new completing return carries the round-off once');

-- F (review MAJOR): 1.40 + 0.09 = 1.49 -> 1.00. Returning the 1.40 line first may not exceed the
-- bill, and the completing 0.09 return must not go negative (it used to fail and block the last item).
insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'Big','piece','r0b-big'),(current_tenant_id(),'Small','piece','r0b-small');
select set_item_price((select id from items where client_id='r0b-big'),current_setting('r0.shop')::uuid,'retail',1::smallint,140::bigint,'r0b-p1');
select set_item_price((select id from items where client_id='r0b-small'),current_setting('r0.shop')::uuid,'retail',1::smallint,9::bigint,'r0b-p2');
select post_purchase(current_setting('r0.shop')::uuid,null,'R0B-SEED','2026-09-01',0,0,'r0b-seed',
 jsonb_build_array(jsonb_build_object('item_id',(select id from items where client_id='r0b-big'),'unit_level',1,'qty',5,'unit_price_paise',50),
                   jsonb_build_object('item_id',(select id from items where client_id='r0b-small'),'unit_level',1,'qty',5,'unit_price_paise',5)),null);
select lives_ok($$select r0_sync_post_sale('r0-phone',1,current_setting('r0.shop')::uuid,null,'2026-09-20',0,0,'F',
  jsonb_build_array(
    jsonb_build_object('item_id',(select id from items where client_id='r0b-big'),'unit_level',1,'qty',1,'price_kind','retail','discount_paise',0,'expected_unit_price_paise',140),
    jsonb_build_object('item_id',(select id from items where client_id='r0b-small'),'unit_level',1,'qty',1,'price_kind','retail','discount_paise',0,'expected_unit_price_paise',9)),
  jsonb_build_array(jsonb_build_object('amount_paise',100,'mode','cash')),null)$$,'1.49 -> 1.00 two-line sale posts');
create function pg_temp.retline(p_item text,p_rc text) returns sale_returns language plpgsql as $$
declare r sale_returns;
begin
 perform post_return('SALE',(pg_temp.inv('F')).id,'2026-09-21',p_rc,jsonb_build_array(jsonb_build_object(
   'sale_invoice_item_id',(select li.id from sale_invoice_items li join items i on i.id=li.item_id where li.sale_invoice_id=(pg_temp.inv('F')).id and i.client_id=p_item),
   'qty',1,'disposition','RETURN_TO_SELLABLE')),null);
 select * into r from sale_returns where client_id=p_rc; return r;
end $$;
select is((pg_temp.retline('r0b-big','F-r1')).total_paise,100::bigint,'bigger line returned first is capped at the bill (1.00)');
select is((pg_temp.retline('r0b-small','F-r2')).total_paise,0::bigint,'completing return takes what remains (0), never negative');

select is((check_invariants()->>'ok')::boolean,true,'invariants hold with return round-off');

reset role;
select throws_like($$update sale_returns set round_off_paise=0 where client_id='A-r'$$,'%immutable%','return round-off cannot be changed after posting');
set role authenticated;
select set_config('request.jwt.claims','{"sub":"a0a00000-0000-0000-0000-000000000001","role":"authenticated"}',true);

select * from finish();
rollback;
