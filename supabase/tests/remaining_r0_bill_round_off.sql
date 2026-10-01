-- Packet R0 (mig 0051): bill total rounded to the nearest rupee (half up) for opted-in sales only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(21);
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

select is(r0_round_off(1049),-49::bigint,'10.49 rounds down by 49 paise');
select is(r0_round_off(1050),50::bigint,'10.50 rounds up by 50 paise (half up)');
select is(r0_round_off(1000),0::bigint,'whole rupees are unchanged');
select is(r0_round_off(0),0::bigint,'zero stays zero');

-- Opted-in sale: 10.49 -> 10.00, walk-in pays the rounded total.
select lives_ok($$select pg_temp.sale('r0_sync_post_sale','r0-a',0,1000)$$,'opted-in walk-in sale paying the rounded total posts');
select is((pg_temp.inv('r0-a')).total_paise,1000::bigint,'bill total rounded to 10.00');
select is((pg_temp.inv('r0-a')).round_off_paise,-49::bigint,'round-off stored separately');
select is((pg_temp.inv('r0-a')).subtotal_paise,1049::bigint,'item value stays exact paise');
select throws_like($$select pg_temp.sale('r0_sync_post_sale','r0-b',0,1049)$$,'%payments exceed sale total%','paying the unrounded amount on an opted-in sale is refused');
-- Half-up with an extra charge: 10.49 + 0.01 = 10.50 -> 11.00.
select lives_ok($$select pg_temp.sale('r0_sync_post_sale','r0-c',1,1100)$$,'10.50 rounds up to 11.00 and posts');
select is((pg_temp.inv('r0-c')).round_off_paise,50::bigint,'half rupee rounds up');
-- Old path (queued by an older client): exact paise, no rounding.
select lives_ok($$select pg_temp.sale('phase5_sync_post_sale','r0-old',0,1049)$$,'old sync path keeps exact paise');
select is((pg_temp.inv('r0-old')).total_paise,1049::bigint,'old-path total is not rounded');
-- Credit sale outstanding equals the rounded total.
select lives_ok($$select pg_temp.sale('r0_sync_post_sale','r0-credit',0,null,true)$$,'opted-in credit sale posts');
select is((select outstanding_paise from customer_invoice_outstanding where sale_invoice_id=(pg_temp.inv('r0-credit')).id),1000::bigint,'credit outstanding is the rounded total');
-- The rounding switch is scoped to one call: a later old-path sale in the same transaction is exact.
select lives_ok($$select pg_temp.sale('r0_sync_post_sale','r0-d',0,1000)$$,'opted-in sale posts');
select lives_ok($$select pg_temp.sale('phase5_sync_post_sale','r0-e',0,1049)$$,'old path right after it in the same transaction');
select is((pg_temp.inv('r0-e')).round_off_paise,0::bigint,'no round-off leaks to the next call');
select is((pg_temp.sale('r0_sync_post_sale','r0-a',0,1000))->>'roundOffPaise','-49','ack carries the server round-off (exact replay)');
reset role;
select throws_like($$update sale_invoices set round_off_paise=0 where client_id='r0-a'$$,'%immutable%','round-off cannot be changed after posting');
set role authenticated;
select set_config('request.jwt.claims','{"sub":"a0a00000-0000-0000-0000-000000000001","role":"authenticated"}',true);
select is((check_invariants()->>'ok')::boolean,true,'invariants hold with round-off');

select * from finish();
rollback;
