-- Packet billextras (mig 0064): old-DSB purchase-bill fields. Payment type (a cash/UPI bill posts the bill and
-- a full supplier payment atomically and idempotently), notes, per-line discount/GST with exact server totals,
-- named extra charges, several bill images, and an atomic void of a paid bill.
begin;
create extension if not exists pgtap with schema extensions;
select plan(130);
insert into auth.users(id) values
 ('e3000000-0000-0000-0000-000000000001'),  -- owner
 ('e3000000-0000-0000-0000-000000000002'),  -- manager
 ('e3000000-0000-0000-0000-000000000003');  -- cashier
create function pg_temp.act(p_user text) returns void language sql as
 $$ select set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true) $$;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select current_setting('e3.'||p_key)::uuid $$;
create function pg_temp.bal(p_party text) returns numeric language sql as $$
 select coalesce((select (e->>'netLedgerBalance')::numeric from jsonb_array_elements(get_supplier_outstanding(pg_temp.id('shop'))->'parties') e
   where e->>'partyId'=pg_temp.id(p_party)::text),0) $$;
create function pg_temp.line(p_qty text,p_price bigint,p_disc int,p_gst int,p_total bigint) returns jsonb language sql as $$
 select jsonb_build_object('item_id',pg_temp.id('item'),'qty',p_qty,'unit_price_paise',p_price,'discount_bp',p_disc,
   'gst_bp',p_gst,'line_total_paise',p_total) $$;
create function pg_temp.post(p_client text,p_bill jsonb) returns jsonb language sql as $$
 -- Most fixtures are whole rupees: round-off 0 unless the case sets it (round-off tests call the RPC directly).
 select post_purchase_v2(pg_temp.id('shop'),p_client,
   case when p_bill ? 'round_off_paise' then p_bill else p_bill||'{"round_off_paise":0}'::jsonb end) $$;
set role authenticated;
select pg_temp.act('e3000000-0000-0000-0000-000000000001');
select create_tenant('E3 Co','e3-co','E3 Shop','e3-tenant');
select set_config('e3.tenant',current_tenant_id()::text,false);
select set_config('e3.shop',(select id::text from shops where tenant_id=current_tenant_id() and is_default limit 1),false);
insert into items(tenant_id,name,unit1,tax_rate_bp,client_id) values(current_tenant_id(),'E3 Item','piece',1200,'e3-item');
select set_config('e3.item',(select id::text from items where client_id='e3-item'),false);
insert into parties(tenant_id,name,client_id) values(current_tenant_id(),'Shankar Traders','e3-sup');
select set_config('e3.sup',(select id::text from parties where client_id='e3-sup'),false);
reset role;
insert into tenant_users(tenant_id,user_id,role,shop_ids,status,client_id) values
 (pg_temp.id('tenant'),'e3000000-0000-0000-0000-000000000003','cashier',array[pg_temp.id('shop')],'active','e3-cash'),
 (pg_temp.id('tenant'),'e3000000-0000-0000-0000-000000000002','manager',array[pg_temp.id('shop')],'active','e3-mgr');
insert into parties(tenant_id,name,client_id) values
 (pg_temp.id('tenant'),'Archived Supplier','e3-arch'),(pg_temp.id('tenant'),'Dup Supplier','e3-dupe'),(pg_temp.id('tenant'),'Kept Supplier','e3-keep'),
 (pg_temp.id('tenant'),'Merge From','e3-m1'),(pg_temp.id('tenant'),'Merge Into','e3-m2');
select set_config('e3.m1',(select id::text from parties where client_id='e3-m1'),false);
select set_config('e3.m2',(select id::text from parties where client_id='e3-m2'),false);
select set_config('e3.arch',(select id::text from parties where client_id='e3-arch'),false);
select set_config('e3.dupe',(select id::text from parties where client_id='e3-dupe'),false);
select set_config('e3.keep',(select id::text from parties where client_id='e3-keep'),false);

-- Server rounding equals the client golden cases (packages/core/src/purchaseBill.test.ts).
select is(array[bx_purchase_line_total(5,115000,0,null),bx_purchase_line_total(20,871,0,500),bx_purchase_line_total(3,9999,1000,1800),
  bx_purchase_line_total(2.5,4000,250,1200),bx_purchase_line_total(1.333,7550,700,500),bx_purchase_line_total(12,50,10000,1800),
  bx_purchase_line_total(7,12345,0,2800),bx_purchase_line_total(0.25,158000,120,0),bx_purchase_line_total(1,3,5000,null),
  bx_purchase_line_total(1,10,0,500),bx_purchase_line_total(0.145,100,0,null)],
  array[575000,18291,31857,10920,9828,0,110611,39026,2,11,15]::bigint[],'server line totals match the old-DSB golden cases');
select is(array[bx_purchase_line_total(5555777.77778,9,1,1),bx_purchase_line_total(999999.999999,999999,333,1800),
  bx_purchase_line_total(123456.123456,98765,1234,2800)],array[50001999,1140704859293,13681292876]::bigint[],
  'large quantities round exactly (integer half-up, no numeric division)');

-- Table hygiene
select ok((select relrowsecurity from pg_class where relname='purchase_bill_charges')
  and (select relrowsecurity from pg_class where relname='purchase_bill_images'),'RLS is on for both new tables');
select ok(not has_table_privilege('authenticated','purchase_bill_charges','insert')
  and not has_table_privilege('authenticated','purchase_bill_charges','update')
  and not has_table_privilege('authenticated','purchase_bill_charges','delete')
  and not has_table_privilege('authenticated','purchase_bill_images','insert')
  and not has_table_privilege('authenticated','purchase_bill_images','update')
  and not has_table_privilege('authenticated','purchase_bill_images','delete'),'clients cannot write charges or images');
select ok(has_table_privilege('authenticated','purchase_bill_charges','select')
  and has_table_privilege('authenticated','purchase_bill_images','select'),'clients can read through RLS');
select ok(not has_function_privilege('anon','post_purchase_v2(uuid,text,jsonb)','execute')
  and not has_function_privilege('anon','void_paid_purchase(uuid,text,text)','execute')
  and not has_function_privilege('authenticated','bx_purchase_line_total(numeric,bigint,integer,integer)','execute'),
  'anon cannot post; the rounding helper is internal');

set role authenticated;
select pg_temp.act('e3000000-0000-0000-0000-000000000001');

-- v1 is unchanged: credit, no notes, no discount, item master rate snapshot.
select set_config('e3.v1',post_purchase(pg_temp.id('shop'),pg_temp.id('sup'),'V1',null,0,0,'e3-v1',
  jsonb_build_array(jsonb_build_object('item_id',pg_temp.id('item'),'qty','2','unit_price_paise',1000)))::text,false);
select is((select row(payment_type,notes,total_paise)::text from purchase_bills where id=pg_temp.id('v1')),'(credit,,2000)','v1 bill defaults to credit with no notes');
select is((select row(discount_bp,gst_bp,tax_rate_bp_snapshot,line_total_paise)::text from purchase_bill_items where purchase_bill_id=pg_temp.id('v1')),
  '(0,,1200,2000)','v1 line keeps price-as-entered and the item master rate');
select set_config('e3.bal0',pg_temp.bal('sup')::text,false);

-- v2 credit bill with discount/GST lines, named charges and a bill discount.
select set_config('e3.b1json',jsonb_build_object('party_id',pg_temp.id('sup'),'bill_no','S-1','business_date','2026-10-01',
  'payment_type','credit','notes','  check rate  ','discount_paise',500,'total_paise',74600,'round_off_paise',-48,
  'lines',jsonb_build_array(pg_temp.line('20',871,0,500,18291),pg_temp.line('3',9999,1000,1800,31857)),
  'charges',jsonb_build_array(jsonb_build_object('label',' Freight ','amount_paise',20000),jsonb_build_object('label','Loading','amount_paise',5000)))::text,false);
select set_config('e3.b1',(pg_temp.post('e3000000-0000-0000-0000-0000000000b1',current_setting('e3.b1json')::jsonb)->>'billId'),false);
select is((select row(subtotal_paise,discount_paise,extra_charges_paise,total_paise,payment_type,notes)::text from purchase_bills where id=pg_temp.id('b1')),
  '(50148,500,25000,74600,credit,"check rate")','credit bill totals (rounded to the rupee), notes trimmed');
select is((select round_off_paise from purchase_bills where id=pg_temp.id('b1')),-48::bigint,'₹746.48 rounds down to ₹746: round-off -48 paise');
select is((select string_agg(row(line_no,discount_bp,gst_bp,tax_rate_bp_snapshot,line_total_paise)::text,';' order by line_no) from purchase_bill_items where purchase_bill_id=pg_temp.id('b1')),
  '(1,0,500,500,18291);(2,1000,1800,1800,31857)','lines store discount, GST and GST as the line rate');
select is((select string_agg(label||'='||amount_paise,',' order by line_no) from purchase_bill_charges where purchase_bill_id=pg_temp.id('b1')),
  'Freight=20000,Loading=5000','named charges stored in order, trimmed');
select is(pg_temp.bal('sup')-current_setting('e3.bal0')::numeric,74600::numeric,'credit bill raises the supplier balance by its rounded total');
select is((select count(*) from payments where party_id=pg_temp.id('sup')),0::bigint,'credit bill posts no payment');
select is((select qty_base from stock_movements where source_id=pg_temp.id('b1') order by client_id limit 1),20.000000::numeric,'stock received');

-- Exact replay returns the same answer; a different payload with the same id is refused.
select is(pg_temp.post('e3000000-0000-0000-0000-0000000000b1',current_setting('e3.b1json')::jsonb)->>'billId',
  current_setting('e3.b1'),'exact retry returns the same bill');
select throws_like($$select pg_temp.post('e3000000-0000-0000-0000-0000000000b1',
  jsonb_set(current_setting('e3.b1json')::jsonb,'{notes}','"other"'))$$,'%DSB_PAYLOAD_MISMATCH%','changed notes on the same id is refused');
select throws_like($$select pg_temp.post('e3-v1',current_setting('e3.b1json')::jsonb)$$,'%DSB_INVALID_REQUEST_ID%','request id must be a UUID');
select is((select count(*) from purchase_bills where tenant_id=pg_temp.id('tenant')),2::bigint,'no extra bill from retries');

-- Server recomputes: wrong line or bill totals are refused.
select throws_like($$select pg_temp.post('e3000000-0000-0000-0000-0000000000c1',jsonb_build_object('party_id',pg_temp.id('sup'),
  'total_paise',18290,'lines',jsonb_build_array(pg_temp.line('20',871,0,500,18290))))$$,'%DSB_TOTAL_MISMATCH%','a wrong line total is refused');
select throws_like($$select pg_temp.post('e3000000-0000-0000-0000-0000000000c2',jsonb_build_object('party_id',pg_temp.id('sup'),
  'total_paise',18292,'lines',jsonb_build_array(pg_temp.line('20',871,0,500,18291))))$$,'%DSB_TOTAL_MISMATCH%','a wrong bill total is refused');
select throws_like($$select pg_temp.post('e3000000-0000-0000-0000-0000000000c3',jsonb_build_object('party_id',pg_temp.id('sup'),
  'lines',jsonb_build_array(pg_temp.line('20',871,0,500,18291))))$$,'%DSB_TOTAL_MISMATCH%','the bill total is required');
select throws_like($$select pg_temp.post('e3000000-0000-0000-0000-0000000000c4',jsonb_build_object('party_id',pg_temp.id('sup'),
  'total_paise',1000,'lines',jsonb_build_array(jsonb_build_object('item_id',pg_temp.id('item'),'qty','1','unit_price_paise',1000))))$$,
  '%DSB_TOTAL_MISMATCH%','every line needs its total');
select throws_like($$select pg_temp.post('e3000000-0000-0000-0000-0000000000c5',jsonb_build_object('party_id',pg_temp.id('sup'),
  'total_paise',0,'lines',jsonb_build_array(pg_temp.line('1',1000,10001,null,0))))$$,'%between 0%','discount over 100% is refused');
select throws_like($$select pg_temp.post('e3000000-0000-0000-0000-0000000000c6',jsonb_build_object('party_id',pg_temp.id('sup'),
  'payment_type','cheque','total_paise',1000,'lines',jsonb_build_array(pg_temp.line('1',1000,0,null,1000))))$$,
  '%DSB_INVALID_PAYMENT_TYPE%','cheque is not a payment type');
select throws_like($$select pg_temp.post('e3000000-0000-0000-0000-0000000000c7',jsonb_build_object(
  'payment_type','cash','total_paise',1000,'lines',jsonb_build_array(pg_temp.line('1',1000,0,null,1000))))$$,
  '%DSB_PAYMENT_NEEDS_SUPPLIER%','a cash bill needs a supplier');
select throws_like($$select pg_temp.post('e3000000-0000-0000-0000-0000000000c8',jsonb_build_object('party_id',pg_temp.id('sup'),
  'payment_type','cash','business_date',(shop_business_date(pg_temp.id('shop'))+1)::text,'total_paise',1000,
  'lines',jsonb_build_array(pg_temp.line('1',1000,0,null,1000))))$$,'%DSB_FUTURE_DATE%','a paid bill cannot be future-dated');
select throws_like($$select pg_temp.post('e3000000-0000-0000-0000-0000000000c9',jsonb_build_object('party_id',pg_temp.id('sup'),
  'notes',repeat('x',501),'total_paise',1000,'lines',jsonb_build_array(pg_temp.line('1',1000,0,null,1000))))$$,
  '%DSB_INVALID_NOTES%','notes over 500 characters are refused');
select throws_like($$select pg_temp.post('e3000000-0000-0000-0000-0000000000ca',jsonb_build_object('party_id',pg_temp.id('sup'),
  'total_paise',1000,'lines',jsonb_build_array(pg_temp.line('1',1000,0,null,1000)),
  'charges',jsonb_build_array(jsonb_build_object('label','  ','amount_paise',100))))$$,'%DSB_INVALID_CHARGES%','a charge needs a name');
select throws_like($$select pg_temp.post('e3000000-0000-0000-0000-0000000000cb',jsonb_build_object('party_id',pg_temp.id('sup'),
  'total_paise',1000,'lines',jsonb_build_array(pg_temp.line('1',1000,0,null,1000)),
  'charges',jsonb_build_array(jsonb_build_object('label','Freight','amount_paise',0))))$$,'%DSB_INVALID_CHARGES%','a charge needs a positive amount');
select is((select count(*) from purchase_bills where tenant_id=pg_temp.id('tenant')),2::bigint,'refused requests wrote nothing');

-- GST: blank (null) = price as entered at the item's rate; explicit 0 = "0% added" (rate 0).
select set_config('e3.g',pg_temp.post('e3000000-0000-0000-0000-0000000000b2',jsonb_build_object('party_id',pg_temp.id('sup'),
  'total_paise',2000,'lines',jsonb_build_array(pg_temp.line('1',1000,0,null,1000),pg_temp.line('1',1000,0,0,1000))))->>'billId',false);
select is((select string_agg(coalesce(gst_bp::text,'null')||'/'||tax_rate_bp_snapshot,',' order by line_no) from purchase_bill_items
  where purchase_bill_id=pg_temp.id('g')),'null/1200,0/0','blank GST keeps the item rate; explicit 0 is a 0% line');

-- v1 <-> v2 client id reuse.
select post_purchase(pg_temp.id('shop'),pg_temp.id('sup'),'V1U',null,0,0,'e3000000-0000-0000-0000-0000000000b3',
  jsonb_build_array(jsonb_build_object('item_id',pg_temp.id('item'),'qty','1','unit_price_paise',100)));
select throws_like($$select pg_temp.post('e3000000-0000-0000-0000-0000000000b3',jsonb_build_object('party_id',pg_temp.id('sup'),
  'bill_no','V1U','total_paise',100,'lines',jsonb_build_array(pg_temp.line('1',100,0,null,100))))$$,'%DSB_PAYLOAD_MISMATCH%',
  'v2 refuses an id already used by a v1 bill');
select is(post_purchase(pg_temp.id('shop'),pg_temp.id('sup'),'S-1','2026-10-01',500,25000,'e3000000-0000-0000-0000-0000000000b1',
  jsonb_build_array(jsonb_build_object('item_id',pg_temp.id('item'),'qty','20','unit_price_paise',871),
    jsonb_build_object('item_id',pg_temp.id('item'),'qty','3','unit_price_paise',9999))),pg_temp.id('b1'),
  'accepted risk: a v1 retry with the same lines acknowledges the v2 bill (no new bill)');
select throws_like($$select post_purchase(pg_temp.id('shop'),pg_temp.id('sup'),'S-1','2026-10-01',500,25000,'e3000000-0000-0000-0000-0000000000b1',
  jsonb_build_array(jsonb_build_object('item_id',pg_temp.id('item'),'qty','20','unit_price_paise',870),
    jsonb_build_object('item_id',pg_temp.id('item'),'qty','3','unit_price_paise',9999)))$$,'%DSB_PAYLOAD_MISMATCH%',
  'v1 reusing a v2 id with other lines is refused');
select is((select count(*) from purchase_bills where tenant_id=pg_temp.id('tenant')),4::bigint,'reuse created no extra bill');

-- A paid bill for an archived or merged-away supplier is refused (nothing written).
select archive_party(pg_temp.id('arch'));
select merge_parties(pg_temp.id('dupe'),pg_temp.id('keep'),'e3-merge');
select throws_like($$select pg_temp.post('e3000000-0000-0000-0000-0000000000b4',jsonb_build_object('party_id',pg_temp.id('arch'),
  'payment_type','cash','total_paise',100,'lines',jsonb_build_array(pg_temp.line('1',100,0,null,100))))$$,'%party not in tenant%',
  'a paid bill for an archived supplier is refused');
select throws_like($$select pg_temp.post('e3000000-0000-0000-0000-0000000000b5',jsonb_build_object('party_id',pg_temp.id('dupe'),
  'payment_type','cash','total_paise',100,'lines',jsonb_build_array(pg_temp.line('1',100,0,null,100))))$$,'%party not in tenant%',
  'a paid bill for a merged-away supplier is refused');
select is((select count(*) from payments where tenant_id=pg_temp.id('tenant')),0::bigint,'refused paid bills wrote no payment');

-- Cash bill: bill + full payment (mode cash) allocated to it, atomically; balance unchanged.
select set_config('e3.bal1',pg_temp.bal('sup')::text,false);
select set_config('e3.cjson',jsonb_build_object('party_id',pg_temp.id('sup'),'bill_no','C-1','business_date','2026-10-02',
  'payment_type','cash','total_paise',12000,'lines',jsonb_build_array(pg_temp.line('2',6000,0,null,12000)))::text,false);
select set_config('e3.cres',pg_temp.post('e3000000-0000-0000-0000-0000000000d1',current_setting('e3.cjson')::jsonb)::text,false);
select set_config('e3.cash',current_setting('e3.cres')::jsonb->>'billId',false);
select set_config('e3.cpay',current_setting('e3.cres')::jsonb->>'paymentId',false);
select is((select row(kind,party_id=pg_temp.id('sup'),amount_paise,mode,direction,status,business_date)::text from payments where id=pg_temp.id('cpay')),
  '(party,t,12000,cash,out,POSTED,2026-10-02)','cash bill records a full cash payment to the supplier');
select is((select string_agg(row(purchase_bill_id=pg_temp.id('cash'),amount_paise,status)::text,',') from payment_allocations where payment_id=pg_temp.id('cpay')),
  '(t,12000,POSTED)','the payment is allocated in full to the bill');
select is((select outstanding_paise from purchase_bill_outstanding where purchase_bill_id=pg_temp.id('cash')),0::bigint,'the cash bill has nothing outstanding');
select is(pg_temp.bal('sup'),current_setting('e3.bal1')::numeric,'a cash bill leaves the supplier balance unchanged');
select is(pg_temp.post('e3000000-0000-0000-0000-0000000000d1',current_setting('e3.cjson')::jsonb)::text,current_setting('e3.cres'),
  'lost-reply replay returns the same bill and payment ids');
select is((select count(*) from payments where party_id=pg_temp.id('sup')),1::bigint,'a retry never creates a second payment');
reset role;
select is((select count(*) from financial_requests where operation='supplier.record.v1'
  and client_id=md5('dsb.purchase.v2.payment:'||pg_temp.id('cash')::text)::uuid::text),1::bigint,'the payment request id is derived from the bill');
set role authenticated;
select pg_temp.act('e3000000-0000-0000-0000-000000000001');

-- UPI bill and a zero-total paid bill.
select set_config('e3.ujson',jsonb_build_object('party_id',pg_temp.id('sup'),
  'payment_type','upi','total_paise',5000,'lines',jsonb_build_array(pg_temp.line('1',5000,0,null,5000)))::text,false);
select set_config('e3.ures',pg_temp.post('e3000000-0000-0000-0000-0000000000d2',current_setting('e3.ujson')::jsonb)::text,false);
select is((select mode from payments where id=(current_setting('e3.ures')::jsonb->>'paymentId')::uuid),'upi','UPI bill pays by UPI');
select is(pg_temp.post('e3000000-0000-0000-0000-0000000000d3',jsonb_build_object('party_id',pg_temp.id('sup'),
  'payment_type','cash','total_paise',0,'lines',jsonb_build_array(pg_temp.line('1',5000,10000,null,0))))->'paymentId','null'::jsonb,
  'a fully discounted paid bill needs no payment');

-- Bill images: two uploaded originals; first also becomes bill_image_path.
reset role;
select set_config('e3.img1',pg_temp.id('tenant')||'/'||pg_temp.id('shop')||'/e3000000-0000-0000-0000-0000000000e1/e3000000-0000-0000-0000-0000000000f1.jpg',false);
select set_config('e3.img2',pg_temp.id('tenant')||'/'||pg_temp.id('shop')||'/e3000000-0000-0000-0000-0000000000e1/e3000000-0000-0000-0000-0000000000f2.pdf',false);
select set_config('e3.img3',pg_temp.id('tenant')||'/'||pg_temp.id('shop')||'/e3000000-0000-0000-0000-0000000000e9/e3000000-0000-0000-0000-0000000000f3.jpg',false);
insert into storage.objects(bucket_id,name,metadata) values
 ('bill-documents',current_setting('e3.img1'),'{"mimetype":"image/jpeg","size":100}'),
 ('bill-documents',current_setting('e3.img2'),'{"mimetype":"application/pdf","size":100}'),
 ('bill-documents',current_setting('e3.img3'),'{"mimetype":"image/jpeg","size":100}');
set role authenticated;
select pg_temp.act('e3000000-0000-0000-0000-000000000001');
select throws_like($$select pg_temp.post('e3000000-0000-0000-0000-0000000000e1',jsonb_build_object('party_id',pg_temp.id('sup'),
  'total_paise',1000,'lines',jsonb_build_array(pg_temp.line('1',1000,0,null,1000)),
  'images',jsonb_build_array(current_setting('e3.img1'),current_setting('e3.img1'))))$$,'%DSB_BILL_DOCUMENT_INVALID%','the same image twice is refused');
select throws_like($$select pg_temp.post('e3000000-0000-0000-0000-0000000000e1',jsonb_build_object('party_id',pg_temp.id('sup'),
  'total_paise',1000,'lines',jsonb_build_array(pg_temp.line('1',1000,0,null,1000)),
  'images',jsonb_build_array(current_setting('e3.img1'),current_setting('e3.img3'))))$$,'%DSB_BILL_DOCUMENT_INVALID%','another purchase''s upload is refused');
select set_config('e3.ibill',pg_temp.post('e3000000-0000-0000-0000-0000000000e1',jsonb_build_object('party_id',pg_temp.id('sup'),
  'total_paise',1000,'lines',jsonb_build_array(pg_temp.line('1',1000,0,null,1000)),
  'images',jsonb_build_array(current_setting('e3.img1'),current_setting('e3.img2'))))->>'billId',false);
select is((select bill_image_path from purchase_bills where id=pg_temp.id('ibill')),current_setting('e3.img1'),'first image is the bill document');
select is((select string_agg(sort_order||':'||storage_path,',' order by sort_order) from purchase_bill_images where purchase_bill_id=pg_temp.id('ibill')),
  '0:'||current_setting('e3.img1')||',1:'||current_setting('e3.img2'),'all images stored in order');

-- Cashier: cannot read supplier documents' children nor void paid bills.
select pg_temp.act('e3000000-0000-0000-0000-000000000003');
select is((select count(*) from purchase_bill_charges)+(select count(*) from purchase_bill_images),0::bigint,'cashier cannot read bill charges or images');
select throws_like(format($$select void_paid_purchase(%L::uuid,'wrong','e3000000-0000-0000-0000-0000000000a9')$$,pg_temp.id('cash')),
  '%not permitted%','cashier cannot void a paid bill');
select throws_like($$select pg_temp.post('e3000000-0000-0000-0000-0000000000ab',current_setting('e3.cjson')::jsonb)$$,'%not permitted%','cashier cannot post purchases');
select pg_temp.act('e3000000-0000-0000-0000-000000000001');

-- Voids stay consistent.
select throws_like(format($$select void_purchase(%L::uuid,'e3-void-plain')$$,pg_temp.id('cash')),'%active allocations%',
  'the plain void refuses a paid bill (its payment would be stranded)');
select throws_like(format($$select void_paid_purchase(%L::uuid,'wrong','e3000000-0000-0000-0000-0000000000a1')$$,pg_temp.id('b1')),
  '%DSB_NOT_PAID_BILL%','a credit bill uses the normal void');
select throws_like(format($$select void_paid_purchase(%L::uuid,'  ','e3000000-0000-0000-0000-0000000000a2')$$,pg_temp.id('cash')),
  '%DSB_INVALID_REASON%','a reason is required');
select set_config('e3.vres',void_paid_purchase(pg_temp.id('cash'),'entered twice','e3000000-0000-0000-0000-0000000000a3')::text,false);
select is((select status from purchase_bills where id=pg_temp.id('cash')),'VOID','paid bill voided');
select is((select status from payments where id=pg_temp.id('cpay')),'VOID','its automatic payment voided with it');
select is((select count(*) from payment_allocations where payment_id=pg_temp.id('cpay') and status='POSTED'),0::bigint,'no live allocation remains');
select is((select coalesce(sum(qty_base),0) from stock_movements where source_id=pg_temp.id('cash')),0::numeric,'stock reversed');
select is(pg_temp.bal('sup'),current_setting('e3.bal1')::numeric+1000,'voiding a paid bill leaves the balance as before it (only the later 10 rupee credit bill added)');
select is(void_paid_purchase(pg_temp.id('cash'),'entered twice','e3000000-0000-0000-0000-0000000000a3')::text,current_setting('e3.vres'),'void retry returns the same answer');
select throws_like(format($$select void_paid_purchase(%L::uuid,'other reason','e3000000-0000-0000-0000-0000000000a3')$$,pg_temp.id('cash')),
  '%DSB_PAYLOAD_MISMATCH%','void id reused for another reason is refused');
select is((select count(*) from payments where id=pg_temp.id('cpay')),1::bigint,'the voided payment row is kept (history)');

-- The auto payment voided separately (owner, supplier screen): replay still returns the stored ids and creates
-- nothing; the bill then shows honestly unpaid; void_paid_purchase still voids the bill.
select set_config('e3.upay',current_setting('e3.ures')::jsonb->>'paymentId',false);
select set_config('e3.ubill',current_setting('e3.ures')::jsonb->>'billId',false);
select void_supplier_payment(pg_temp.id('upay'),'paid by mistake','e3000000-0000-0000-0000-0000000000a5');
select is(pg_temp.post('e3000000-0000-0000-0000-0000000000d2',current_setting('e3.ujson')::jsonb)::text,current_setting('e3.ures'),
  'replay after the payment was voided returns the same ids');
select is((select count(*) from payments where tenant_id=pg_temp.id('tenant') and mode='upi'),1::bigint,
  'no new payment after the separate void');
select is((select outstanding_paise from purchase_bill_outstanding where purchase_bill_id=pg_temp.id('ubill')),5000::bigint,
  'the bill shows unpaid once its payment is voided');
select is(void_paid_purchase(pg_temp.id('ubill'),'cancelled','e3000000-0000-0000-0000-0000000000a6')->>'paymentVoided','false',
  'void of a paid bill whose payment is already void voids only the bill');

-- Payment reassigned elsewhere: the void refuses rather than voiding another bill's money.
select set_config('e3.rres',pg_temp.post('e3000000-0000-0000-0000-0000000000d4',jsonb_build_object('party_id',pg_temp.id('sup'),
  'payment_type','cash','total_paise',3000,'lines',jsonb_build_array(pg_temp.line('1',3000,0,null,3000))))::text,false);
select set_config('e3.t',pg_temp.post('e3000000-0000-0000-0000-0000000000d5',jsonb_build_object('party_id',pg_temp.id('sup'),
  'total_paise',3000,'lines',jsonb_build_array(pg_temp.line('1',3000,0,null,3000))))->>'billId',false);
select release_supplier_allocation((select id from payment_allocations where payment_id=(current_setting('e3.rres')::jsonb->>'paymentId')::uuid),
  'moved','e3000000-0000-0000-0000-0000000000a7');
select allocate_supplier_payment((current_setting('e3.rres')::jsonb->>'paymentId')::uuid,
  jsonb_build_array(jsonb_build_object('purchase_bill_id',pg_temp.id('t'),'amount_paise',3000)),'e3000000-0000-0000-0000-0000000000a8');
select throws_like(format($$select void_paid_purchase(%L::uuid,'x','e3000000-0000-0000-0000-0000000000a9')$$,
  current_setting('e3.rres')::jsonb->>'billId'),'%DSB_PAYMENT_REASSIGNED%','a payment reassigned to another bill blocks the paid void');

-- A paid bill with a posted return cannot be voided; nothing changes.
select set_config('e3.qres',pg_temp.post('e3000000-0000-0000-0000-0000000000d6',jsonb_build_object('party_id',pg_temp.id('sup'),
  'business_date','2026-10-03','payment_type','cash','total_paise',2000,'lines',jsonb_build_array(pg_temp.line('2',1000,0,null,2000))))::text,false);
select post_return('PURCHASE',(current_setting('e3.qres')::jsonb->>'billId')::uuid,'2026-10-04','e3-ret',jsonb_build_array(jsonb_build_object(
  'purchase_bill_item_id',(select id from purchase_bill_items where purchase_bill_id=(current_setting('e3.qres')::jsonb->>'billId')::uuid),
  'qty',1,'disposition','SUPPLIER_RETURN')),null);
select throws_like(format($$select void_paid_purchase(%L::uuid,'x','e3000000-0000-0000-0000-0000000000aa')$$,
  current_setting('e3.qres')::jsonb->>'billId'),'%void posted returns%','a paid bill with a return cannot be voided');
select is((select status from payments where id=(current_setting('e3.qres')::jsonb->>'paymentId')::uuid),'POSTED',
  'the refused void left the payment posted');

-- Round-off (old DSB Math.round on every bill, half up), checked against the client's figures.
select throws_like($$select post_purchase_v2(pg_temp.id('shop'),'e3000000-0000-0000-0000-0000000000c1',jsonb_build_object('party_id',pg_temp.id('sup'),
  'total_paise',18300,'lines',jsonb_build_array(pg_temp.line('20',871,0,500,18291))))$$,'%DSB_TOTAL_MISMATCH%','the round-off is required');
select throws_like($$select pg_temp.post('e3000000-0000-0000-0000-0000000000c1',jsonb_build_object('party_id',pg_temp.id('sup'),
  'total_paise',18291,'round_off_paise',0,'lines',jsonb_build_array(pg_temp.line('20',871,0,500,18291))))$$,'%DSB_TOTAL_MISMATCH%',
  'an unrounded total is refused');
select throws_like($$select pg_temp.post('e3000000-0000-0000-0000-0000000000c1',jsonb_build_object('party_id',pg_temp.id('sup'),
  'total_paise',18200,'round_off_paise',-91,'lines',jsonb_build_array(pg_temp.line('20',871,0,500,18291))))$$,'%DSB_TOTAL_MISMATCH%',
  'a wrongly rounded total is refused');
select set_config('e3.bal_r',pg_temp.bal('sup')::text,false);
select set_config('e3.r1',pg_temp.post('e3000000-0000-0000-0000-0000000000c1',jsonb_build_object('party_id',pg_temp.id('sup'),
  'payment_type','cash','business_date','2026-10-05','total_paise',18300,'round_off_paise',9,
  'lines',jsonb_build_array(pg_temp.line('20',871,0,500,18291))))::text,false);
select is((select row(subtotal_paise,round_off_paise,total_paise)::text from purchase_bills where id=(current_setting('e3.r1')::jsonb->>'billId')::uuid),
  '(18291,9,18300)','₹182.91 -> ₹183 (+9 paise), as old DSB');
select is((select amount_paise from payments where id=(current_setting('e3.r1')::jsonb->>'paymentId')::uuid),18300::bigint,
  'the cash payment is the rounded total exactly');
select is(current_setting('e3.r1')::jsonb->>'roundOffPaise','9','the answer carries the server round-off');
select is((select outstanding_paise from purchase_bill_outstanding where purchase_bill_id=(current_setting('e3.r1')::jsonb->>'billId')::uuid),0::bigint,
  'a rounded cash bill is fully paid');
select is(pg_temp.post('e3000000-0000-0000-0000-0000000000c2',jsonb_build_object('party_id',pg_temp.id('sup'),'business_date','2026-10-05',
  'total_paise',10100,'round_off_paise',50,'lines',jsonb_build_array(pg_temp.line('1',10050,0,null,10050))))->>'roundOffPaise','50',
  'exactly half a rupee rounds up (₹100.50 -> ₹101)');
select is(pg_temp.post('e3000000-0000-0000-0000-0000000000c3',jsonb_build_object('party_id',pg_temp.id('sup'),'business_date','2026-10-05',
  'total_paise',18200,'round_off_paise',-40,'lines',jsonb_build_array(pg_temp.line('1',18240,0,null,18240))))->>'roundOffPaise','-40',
  '₹182.40 rounds down to ₹182 (-40)');
select is(pg_temp.bal('sup')-current_setting('e3.bal_r')::numeric,10100+18200::numeric,'the ledger carries rounded totals (cash bill nets to zero)');
select is((select row(taxable_purchases_paise,gross_purchases_paise)::text from get_gst_summary(pg_temp.id('shop'),'2026-10-05','2026-10-05') where tax_rate_bp=500),
  '(17420,18291)','GST summary uses item values, never the round-off');
select is((select (e->>'round_off_paise')::bigint from jsonb_array_elements(phase6_export_tenant(pg_temp.id('shop'))->'purchases') e
  where e->>'id'=current_setting('e3.r1')::jsonb->>'billId'),9::bigint,'the export carries the round-off');
select is((select string_agg(round_off_paise::text,',' order by total_paise) from get_purchase_register(pg_temp.id('shop'),'2026-10-05','2026-10-05')
  where subtotal_paise-discount_paise+extra_charges_paise+round_off_paise=total_paise),'50,-40,9','the purchase register shows the round-off and adds up');
select set_config('e3.vr',void_paid_purchase((current_setting('e3.r1')::jsonb->>'billId')::uuid,'test void','e3000000-0000-0000-0000-0000000000ac')::text,false);
select is(pg_temp.bal('sup')-current_setting('e3.bal_r')::numeric,10100+18200::numeric,'voiding the rounded cash bill restores the ledger exactly');
select is((select round_off_paise from purchase_bills where id=(current_setting('e3.r1')::jsonb->>'billId')::uuid),9::bigint,'a void keeps the round-off');
reset role;
select throws_like(format($$update purchase_bills set round_off_paise=0 where id=%L$$,current_setting('e3.r1')::jsonb->>'billId'),
  '%round-off is immutable%','the round-off cannot be changed');
set role authenticated;
select pg_temp.act('e3000000-0000-0000-0000-000000000001');

-- Returns reverse the round-off like sales (0053): partial returns carry item value (capped), the
-- completing return takes exactly what remains, so a fully returned bill nets to zero.
create function pg_temp.ret_line(p_bill uuid,p_client text,p_qty text,p_line int) returns jsonb language plpgsql as $$
declare v_id uuid;
begin
 v_id:=post_return('PURCHASE',p_bill,'2026-10-06',p_client,jsonb_build_array(jsonb_build_object(
  'purchase_bill_item_id',(select id from purchase_bill_items where purchase_bill_id=p_bill and line_no=p_line),'qty',p_qty,
  'disposition','SUPPLIER_RETURN')),null);
 return (select to_jsonb(r) from purchase_returns r where r.id=v_id);
end $$;
create function pg_temp.ret(p_bill uuid,p_client text,p_qty text) returns jsonb language sql as $$
 select pg_temp.ret_line(p_bill,p_client,p_qty,1) $$;
create function pg_temp.net(p_bill uuid) returns bigint language sql as $$
 select net_outstanding_paise from purchase_bill_outstanding where purchase_bill_id=p_bill $$;
select set_config('e3.up',pg_temp.post('e3000000-0000-0000-0000-0000000000c4',jsonb_build_object('party_id',pg_temp.id('sup'),
  'business_date','2026-10-05','total_paise',10100,'round_off_paise',50,'lines',jsonb_build_array(pg_temp.line('2',5025,0,null,10050))))->>'billId',false);
select is((select (r->>'total_paise')||'/'||(r->>'round_off_paise') from (select pg_temp.ret(pg_temp.id('up'),'e3-ret-up1','1') r) x),'5025/0',
  'a partial return of a rounded-up bill carries item value only');
select is((select (r->>'total_paise')||'/'||(r->>'round_off_paise') from (select pg_temp.ret(pg_temp.id('up'),'e3-ret-up2','1') r) x),'5075/50',
  'the completing return takes the +50 round-off too');
select is(pg_temp.net(pg_temp.id('up')),0::bigint,'a fully returned +50 bill leaves exactly nothing outstanding');
select set_config('e3.down',pg_temp.post('e3000000-0000-0000-0000-0000000000c5',jsonb_build_object('party_id',pg_temp.id('sup'),
  'business_date','2026-10-05','total_paise',10000,'round_off_paise',-49,'lines',jsonb_build_array(pg_temp.line('1',10049,0,null,10049))))->>'billId',false);
select is((select (r->>'total_paise')||'/'||(r->>'round_off_paise') from (select pg_temp.ret(pg_temp.id('down'),'e3-ret-dn','1') r) x),'10000/-49',
  'a full return of a −49 bill returns what was billed, not the item value');
select is(pg_temp.net(pg_temp.id('down')),0::bigint,'a fully returned −49 bill leaves exactly nothing outstanding');
select set_config('e3.down2',pg_temp.post('e3000000-0000-0000-0000-0000000000c6',jsonb_build_object('party_id',pg_temp.id('sup'),
  'business_date','2026-10-05','total_paise',10000,'round_off_paise',-49,
  'lines',jsonb_build_array(pg_temp.line('1',10000,0,null,10000),pg_temp.line('1',49,0,null,49))))->>'billId',false);
select is((select (r->>'total_paise')||'/'||(r->>'round_off_paise') from (select pg_temp.ret_line(pg_temp.id('down2'),'e3-ret-dn2','1',1) r) y),'10000/0',
  'a partial return is capped by what was billed');
select is((select (r->>'total_paise')||'/'||(r->>'round_off_paise') from (select pg_temp.ret_line(pg_temp.id('down2'),'e3-ret-dn3','1',2) r) y),'0/-49',
  'the completing return takes what remains (nothing): returns never exceed the bill');
select is(pg_temp.net(pg_temp.id('down2')),0::bigint,'partial then completing return nets the −49 bill to zero');
reset role;
select throws_like($$update purchase_returns set round_off_paise=0 where client_id='e3-ret-up2'$$,'%immutable%','a return round-off cannot be changed');
set role authenticated;
select pg_temp.act('e3000000-0000-0000-0000-000000000001');

-- Deferred (bill-card packet): a replayed completing return answers with the same return and round-off; voiding
-- the completing return frees the round-off for the next completing return; a rounded bill with named extra
-- charges, fully returned, leaves exactly the extra charges outstanding (charges stay with the shop).
select is((select (r->>'id')||'/'||(r->>'total_paise')||'/'||(r->>'round_off_paise') from (select pg_temp.ret(pg_temp.id('up'),'e3-ret-up2','1') r) x),
  (select id::text||'/5075/50' from purchase_returns where client_id='e3-ret-up2'),
  'a replayed completing return returns the same return with the same round-off');
select is((select count(*) from purchase_returns where purchase_bill_id=pg_temp.id('up')),2::bigint,'the replay adds no return');
select is(pg_temp.net(pg_temp.id('up')),0::bigint,'after the replay the bill still nets to zero');
select set_config('e3.vr2',pg_temp.post('e3000000-0000-0000-0000-0000000000c8',jsonb_build_object('party_id',pg_temp.id('sup'),
  'business_date','2026-10-05','total_paise',10100,'round_off_paise',50,'lines',jsonb_build_array(pg_temp.line('2',5025,0,null,10050))))->>'billId',false);
select is((select (r->>'total_paise')||'/'||(r->>'round_off_paise') from (select pg_temp.ret(pg_temp.id('vr2'),'e3-ret-vr1','1') r) x),'5025/0',
  'partial return before the completing one');
select is((select (r->>'total_paise')||'/'||(r->>'round_off_paise') from (select pg_temp.ret(pg_temp.id('vr2'),'e3-ret-vr2','1') r) x),'5075/50',
  'the completing return takes the round-off');
select is(void_return('PURCHASE',(select id from purchase_returns where client_id='e3-ret-vr2'),'e3-ret-vr2-void'),
  (select id from purchase_returns where client_id='e3-ret-vr2'),'the completing return is voided');
select is((select row(status,round_off_paise)::text from purchase_returns where client_id='e3-ret-vr2'),'(VOID,50)',
  'a voided return keeps its round-off on record');
select is(pg_temp.net(pg_temp.id('vr2')),5075::bigint,'the void puts the item value and the round-off back on the bill');
select is((select (r->>'total_paise')||'/'||(r->>'round_off_paise') from (select pg_temp.ret(pg_temp.id('vr2'),'e3-ret-vr3','1') r) x),'5075/50',
  're-completing after the void takes the round-off again (never twice)');
select is(pg_temp.net(pg_temp.id('vr2')),0::bigint,'the re-completed bill nets to zero');
select set_config('e3.xc',pg_temp.post('e3000000-0000-0000-0000-0000000000c9',jsonb_build_object('party_id',pg_temp.id('sup'),
  'business_date','2026-10-05','total_paise',10100,'round_off_paise',25,'lines',jsonb_build_array(pg_temp.line('1',10050,0,null,10050)),
  'charges',jsonb_build_array(jsonb_build_object('label','Transport','amount_paise',25))))->>'billId',false);
select is((select row(subtotal_paise,extra_charges_paise,round_off_paise,total_paise)::text from purchase_bills where id=pg_temp.id('xc')),
  '(10050,25,25,10100)','₹100.50 + ₹0.25 transport = ₹100.75 -> ₹101 (+25)');
select is((select (r->>'total_paise')||'/'||(r->>'round_off_paise') from (select pg_temp.ret(pg_temp.id('xc'),'e3-ret-xc','1') r) x),'10075/25',
  'the full return gives back what was billed for the items (total - extra), round-off included');
select is(pg_temp.net(pg_temp.id('xc')),25::bigint,'a fully returned rounded bill leaves exactly its extra charges outstanding');

-- Party merge moves a rounded bill unchanged; the v1 void works on a rounded credit bill.
select set_config('e3.mb',pg_temp.post('e3000000-0000-0000-0000-0000000000c7',jsonb_build_object('party_id',pg_temp.id('m1'),
  'business_date','2026-10-05','total_paise',18300,'round_off_paise',9,'lines',jsonb_build_array(pg_temp.line('20',871,0,500,18291))))->>'billId',false);
select merge_parties(pg_temp.id('m1'),pg_temp.id('m2'),'e3-merge-2');
select is((select row(party_id=pg_temp.id('m2'),round_off_paise,total_paise)::text from purchase_bills where id=pg_temp.id('mb')),'(t,9,18300)',
  'a merge moves a rounded bill with its round-off unchanged');
select is(pg_temp.bal('m2'),18300::numeric,'the kept supplier owes the rounded total');
select is(void_purchase(pg_temp.id('mb'),'e3-void-mb'),pg_temp.id('mb'),'the v1 void works on a rounded credit bill');
select is((select row(status,round_off_paise)::text from purchase_bills where id=pg_temp.id('mb')),'(VOID,9)','void keeps the round-off');
select is(pg_temp.bal('m2'),0::numeric,'and the balance is gone');

-- Manager may post purchases but not void a paid bill (voiding a supplier payment is owner-only).
select pg_temp.act('e3000000-0000-0000-0000-000000000002');
select throws_like(format($$select void_paid_purchase(%L::uuid,'x','e3000000-0000-0000-0000-0000000000ab')$$,
  current_setting('e3.qres')::jsonb->>'billId'),'%not permitted%','manager cannot void a paid bill');
select pg_temp.act('e3000000-0000-0000-0000-000000000001');

-- Outcome reconciliation reads the stored answer.
select is(get_financial_request(pg_temp.id('shop'),'purchase.post.v2','e3000000-0000-0000-0000-0000000000d1')->'result',
  current_setting('e3.cres')::jsonb,'get_financial_request returns a v2 purchase answer');
select is(get_financial_request(pg_temp.id('shop'),'purchase.post.v2','e3000000-0000-0000-0000-0000000000ff')->>'state','NOT_FOUND',
  'an unknown v2 request is NOT_FOUND');

-- Database-level guards behind the RPC.
reset role;
select throws_like(format($$insert into purchase_bill_charges(tenant_id,shop_id,purchase_bill_id,line_no,label,amount_paise,client_id)
  values(%L,%L,%L,3,'Extra',1,'e3-x'); set constraints all immediate$$,pg_temp.id('tenant'),pg_temp.id('shop'),pg_temp.id('b1')),
  '%DSB_CHARGES_MISMATCH%','named charges must add up to the header (checked at commit)');
select throws_like(format($$update purchase_bill_charges set amount_paise=1 where purchase_bill_id=%L$$,pg_temp.id('b1')),
  '%immutable%','charges are immutable');
select throws_like(format($$delete from purchase_bill_images where purchase_bill_id=%L$$,pg_temp.id('ibill')),
  '%immutable%','images cannot be deleted');
select throws_like(format($$insert into purchase_bill_images(tenant_id,shop_id,purchase_bill_id,sort_order,storage_path,client_id)
  values(%L,%L,%L,0,%L,'e3-y'); set constraints all immediate$$,pg_temp.id('tenant'),pg_temp.id('shop'),pg_temp.id('b1'),current_setting('e3.img3')),
  '%DSB_BILL_DOCUMENT_INVALID%','an image row must match the bill''s document');
select throws_like($$update purchase_bills set payment_type='cheque' where client_id='e3-v1'$$,'%check%','cheque cannot be stored');
select is((select updated_at>0 from purchase_bill_charges where purchase_bill_id=pg_temp.id('b1') limit 1),true,'server sets updated_at');

-- GST summary: a GST-added line is reported at its own rate, gross includes the GST.
set role authenticated;
select pg_temp.act('e3000000-0000-0000-0000-000000000001');
select is((select row(taxable_purchases_paise,gross_purchases_paise)::text from get_gst_summary(pg_temp.id('shop'),'2026-10-01','2026-10-01') where tax_rate_bp=500),
  '(17246,18108)','GST summary uses the line''s GST rate (gross shares the bill discount)');

-- Business export carries the new tables.
select ok((phase6_export_tenant(pg_temp.id('shop')) ? 'purchaseCharges') and jsonb_array_length(phase6_export_tenant(pg_temp.id('shop'))->'purchaseCharges')=3,
  'export carries named charges');
select is(jsonb_array_length(phase6_export_tenant(pg_temp.id('shop'))->'purchaseImages'),2,'export carries bill images');
select is((select count(*) from purchase_bills where tenant_id=pg_temp.id('tenant') and status='POSTED'),16::bigint,'posted bill count is exact (20 bills, 4 voided)');
select is(check_invariants()->>'ok','true','financial invariants hold after paid, credit, voided and multi-image bills');

select * from finish();
rollback;
