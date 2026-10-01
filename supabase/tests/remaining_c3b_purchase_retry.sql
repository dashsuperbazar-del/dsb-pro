-- Packet C3b (mig 0050): a post_purchase retry returns the stored bill only for the same payload.
begin;
create extension if not exists pgtap with schema extensions;
select plan(11);
insert into auth.users(id) values ('c3b00000-0000-0000-0000-000000000001');
set role authenticated;
select set_config('request.jwt.claims','{"sub":"c3b00000-0000-0000-0000-000000000001","role":"authenticated"}',true);
select create_tenant('C3b Co','c3b-co','C3b Shop','c3b-tenant');
select set_config('t.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into items(tenant_id,name,unit1,client_id) values(current_tenant_id(),'C3b Item','piece','c3b-item');
insert into parties(tenant_id,name,client_id) values(current_tenant_id(),'C3b Supplier','c3b-party');
create function pg_temp.post(p_qty text,p_price bigint,p_bill text default 'B-1',p_disc bigint default 0,p_party boolean default true,p_date date default '2026-09-20') returns uuid language sql as $$
 select post_purchase(current_setting('t.shop')::uuid,case when p_party then (select id from parties where client_id='c3b-party') end,p_bill,p_date,p_disc,0,'c3b-buy',
  jsonb_build_array(jsonb_build_object('item_id',(select id from items where client_id='c3b-item'),'unit_level',1,'qty',p_qty,'unit_price_paise',p_price)),null) $$;
select lives_ok($$select pg_temp.post('4',100)$$,'first purchase posts');
select set_config('t.bill',(select id::text from purchase_bills where client_id='c3b-buy'),false);
select is(pg_temp.post('4',100),current_setting('t.bill')::uuid,'exact retry returns the stored bill');
select is(pg_temp.post('4.000',100),current_setting('t.bill')::uuid,'equal quantity in another spelling still matches');
select is(post_purchase(current_setting('t.shop')::uuid,(select id from parties where client_id='c3b-party'),'B-1',null,0,0,'c3b-buy',
  jsonb_build_array(jsonb_build_object('item_id',(select id from items where client_id='c3b-item'),'unit_level',1,'qty','4','unit_price_paise',100)),null),
  current_setting('t.bill')::uuid,'retry without a date still matches');
select throws_like($$select pg_temp.post('5',100)$$,'DSB_PAYLOAD_MISMATCH%','changed quantity is rejected, not silently returned');
select throws_like($$select pg_temp.post('4',101)$$,'DSB_PAYLOAD_MISMATCH%','changed price is rejected');
select throws_like($$select pg_temp.post('4',100,'B-2')$$,'DSB_PAYLOAD_MISMATCH%','changed bill number is rejected');
select throws_like($$select pg_temp.post('4',100,'B-1',5)$$,'DSB_PAYLOAD_MISMATCH%','changed discount is rejected');
select throws_like($$select pg_temp.post('4',100,'B-1',0,false)$$,'DSB_PAYLOAD_MISMATCH%','changed supplier is rejected');
select is(post_purchase(current_setting('t.shop')::uuid,(select id from parties where client_id='c3b-party'),'B-1','2026-09-20',0,0,'c3b-buy',
  jsonb_build_array(jsonb_build_object('item_id',(select id from items where client_id='c3b-item'),'qty','4','unit_price_paise',100)),null),
  current_setting('t.bill')::uuid,'a line without unit_level matches the stored default level 1');
select is((select count(*) from purchase_bills where client_id='c3b-buy'),1::bigint,'exactly one bill exists');
select * from finish();
rollback;
