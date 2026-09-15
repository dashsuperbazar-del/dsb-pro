-- Phase 6.5: sale and purchase returns are immutable financial documents.
-- Refunds remain positive money magnitudes and use payments.direction='out'.
set local search_path = public, pg_temp;

alter table payments
  add column direction text not null default 'in'
    check(direction in ('in','out'));

alter table purchase_bill_items add constraint purchase_bill_items_tenant_id_id_key unique(tenant_id,id);

create table sale_returns(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 shop_id uuid not null,
 sale_invoice_id uuid not null,
 customer_id uuid,
 doc_no text not null,
 doc_seq bigint not null check(doc_seq>0),
 business_date date not null,
 status text not null default 'DRAFT' check(status in ('DRAFT','POSTED','VOID')),
 total_paise bigint not null default 0 check(total_paise>=0),
 cash_refund_paise bigint not null default 0 check(cash_refund_paise>=0),
 balance_credit_paise bigint not null default 0 check(balance_credit_paise>=0),
 notes text,
 request_fingerprint text not null,
 posted_at timestamptz,
 voided_at timestamptz,
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at bigint not null default 0,
 deleted_at bigint,
 client_id text not null,
 check(total_paise=cash_refund_paise+balance_credit_paise),
 unique(tenant_id,client_id),
 unique(tenant_id,shop_id,doc_no),
 unique(tenant_id,id),
 foreign key(tenant_id,shop_id) references shops(tenant_id,id),
 foreign key(tenant_id,sale_invoice_id) references sale_invoices(tenant_id,id),
 foreign key(tenant_id,customer_id) references customers(tenant_id,id)
);

create table sale_return_items(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 shop_id uuid not null,
 sale_return_id uuid not null,
 sale_invoice_item_id uuid not null,
 item_id uuid not null,
 line_no integer not null check(line_no>0),
 item_name_snapshot text not null,
 hsn_snapshot text,
 tax_rate_bp_snapshot integer not null,
 unit_name_snapshot text not null,
 unit_level smallint not null check(unit_level between 1 and 3),
 qty numeric(18,6) not null check(qty>0),
 base_qty numeric(18,6) not null check(base_qty>0),
 amount_paise bigint not null check(amount_paise>=0),
 disposition text not null check(disposition in ('RETURN_TO_SELLABLE','DAMAGED','EXPIRED','SUPPLIER_RETURN')),
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at bigint not null default 0,
 deleted_at bigint,
 client_id text not null,
 unique(sale_return_id,line_no),
 unique(sale_return_id,sale_invoice_item_id),
 unique(tenant_id,client_id),
 unique(tenant_id,id),
 foreign key(tenant_id,shop_id) references shops(tenant_id,id),
 foreign key(tenant_id,sale_return_id) references sale_returns(tenant_id,id),
 foreign key(tenant_id,sale_invoice_item_id) references sale_invoice_items(tenant_id,id),
 foreign key(tenant_id,item_id) references items(tenant_id,id)
);

create table purchase_returns(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 shop_id uuid not null,
 purchase_bill_id uuid not null,
 party_id uuid,
 doc_no text not null,
 doc_seq bigint not null check(doc_seq>0),
 business_date date not null,
 status text not null default 'DRAFT' check(status in ('DRAFT','POSTED','VOID')),
 total_paise bigint not null default 0 check(total_paise>=0),
 notes text,
 request_fingerprint text not null,
 posted_at timestamptz,
 voided_at timestamptz,
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at bigint not null default 0,
 deleted_at bigint,
 client_id text not null,
 unique(tenant_id,client_id),
 unique(tenant_id,shop_id,doc_no),
 unique(tenant_id,id),
 foreign key(tenant_id,shop_id) references shops(tenant_id,id),
 foreign key(tenant_id,purchase_bill_id) references purchase_bills(tenant_id,id),
 foreign key(tenant_id,party_id) references parties(tenant_id,id)
);

create table purchase_return_items(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 shop_id uuid not null,
 purchase_return_id uuid not null,
 purchase_bill_item_id uuid not null,
 item_id uuid not null,
 line_no integer not null check(line_no>0),
 item_name_snapshot text not null,
 hsn_snapshot text,
 tax_rate_bp_snapshot integer not null,
 unit_name_snapshot text not null,
 unit_level smallint not null check(unit_level between 1 and 3),
 qty numeric(18,6) not null check(qty>0),
 base_qty numeric(18,6) not null check(base_qty>0),
 amount_paise bigint not null check(amount_paise>=0),
 disposition text not null check(disposition in ('RETURN_TO_SELLABLE','DAMAGED','EXPIRED','SUPPLIER_RETURN')),
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at bigint not null default 0,
 deleted_at bigint,
 client_id text not null,
 unique(purchase_return_id,line_no),
 unique(purchase_return_id,purchase_bill_item_id),
 unique(tenant_id,client_id),
 unique(tenant_id,id),
 foreign key(tenant_id,shop_id) references shops(tenant_id,id),
 foreign key(tenant_id,purchase_return_id) references purchase_returns(tenant_id,id),
 foreign key(tenant_id,purchase_bill_item_id) references purchase_bill_items(tenant_id,id),
 foreign key(tenant_id,item_id) references items(tenant_id,id)
);

alter table payments add column source_sale_return_id uuid;
alter table payments add constraint payments_source_sale_return_fk
  foreign key(tenant_id,source_sale_return_id) references sale_returns(tenant_id,id);
create unique index payments_one_refund_per_return
  on payments(tenant_id,source_sale_return_id) where source_sale_return_id is not null;

alter table stock_movements drop constraint stock_movements_source_type_check;
alter table stock_movements add constraint stock_movements_source_type_check check(source_type in (
  'PURCHASE','PURCHASE_VOID','SALE','SALE_VOID','RETURN','ADJUSTMENT',
  'SALE_RETURN','SALE_RETURN_VOID','PURCHASE_RETURN','PURCHASE_RETURN_VOID'
));

create index sale_returns_source_idx on sale_returns(tenant_id,sale_invoice_id,status);
create index sale_return_items_source_idx on sale_return_items(tenant_id,sale_invoice_item_id);
create index purchase_returns_source_idx on purchase_returns(tenant_id,purchase_bill_id,status);
create index purchase_return_items_source_idx on purchase_return_items(tenant_id,purchase_bill_item_id);

create trigger sale_returns_set_updated_at before insert or update on sale_returns for each row execute function set_updated_at();
create trigger sale_return_items_set_updated_at before insert or update on sale_return_items for each row execute function set_updated_at();
create trigger purchase_returns_set_updated_at before insert or update on purchase_returns for each row execute function set_updated_at();
create trigger purchase_return_items_set_updated_at before insert or update on purchase_return_items for each row execute function set_updated_at();
create trigger audit_sale_returns after insert or update on sale_returns for each row execute function audit_row_change();
create trigger audit_sale_return_items after insert on sale_return_items for each row execute function audit_row_change();
create trigger audit_purchase_returns after insert or update on purchase_returns for each row execute function audit_row_change();
create trigger audit_purchase_return_items after insert on purchase_return_items for each row execute function audit_row_change();

create function phase65_return_line_immutable() returns trigger language plpgsql as $$
begin raise exception 'return lines are immutable; use void_return'; end $$;
create trigger sale_return_items_immutable before update or delete on sale_return_items for each row execute function phase65_return_line_immutable();
create trigger purchase_return_items_immutable before update or delete on purchase_return_items for each row execute function phase65_return_line_immutable();

create function phase65_sale_return_guard() returns trigger language plpgsql as $$
begin
 if old.status='DRAFT' and new.status='POSTED' and new.posted_at is not null then return new; end if;
 if old.status='POSTED' and new.status='VOID'
    and new.tenant_id=old.tenant_id and new.shop_id=old.shop_id
    and new.sale_invoice_id=old.sale_invoice_id and new.customer_id is not distinct from old.customer_id
    and new.doc_no=old.doc_no and new.doc_seq=old.doc_seq and new.business_date=old.business_date
    and new.total_paise=old.total_paise and new.cash_refund_paise=old.cash_refund_paise
    and new.balance_credit_paise=old.balance_credit_paise and new.notes is not distinct from old.notes
    and new.request_fingerprint=old.request_fingerprint and new.voided_at is not null then return new;
 end if;
 raise exception 'posted sale return is immutable; use void_return';
end $$;
create trigger sale_return_guard before update on sale_returns for each row execute function phase65_sale_return_guard();

create function phase65_purchase_return_guard() returns trigger language plpgsql as $$
begin
 if old.status='DRAFT' and new.status='POSTED' and new.posted_at is not null then return new; end if;
 if old.status='POSTED' and new.status='VOID'
    and new.tenant_id=old.tenant_id and new.shop_id=old.shop_id
    and new.purchase_bill_id=old.purchase_bill_id and new.party_id is not distinct from old.party_id
    and new.doc_no=old.doc_no and new.doc_seq=old.doc_seq and new.business_date=old.business_date
    and new.total_paise=old.total_paise and new.notes is not distinct from old.notes
    and new.request_fingerprint=old.request_fingerprint and new.voided_at is not null then return new;
 end if;
 raise exception 'posted purchase return is immutable; use void_return';
end $$;
create trigger purchase_return_guard before update on purchase_returns for each row execute function phase65_purchase_return_guard();

alter table sale_returns enable row level security;
alter table sale_return_items enable row level security;
alter table purchase_returns enable row level security;
alter table purchase_return_items enable row level security;
revoke all on sale_returns,sale_return_items,purchase_returns,purchase_return_items from anon,authenticated;
grant select on sale_returns,sale_return_items,purchase_returns,purchase_return_items to authenticated;
create policy sale_returns_read on sale_returns for select using(
 tenant_id=current_tenant_id() and (has_perm('POST_SALES') or has_perm('VIEW_REPORTS'))
);
create policy sale_return_items_read on sale_return_items for select using(
 tenant_id=current_tenant_id() and (has_perm('POST_SALES') or has_perm('VIEW_REPORTS'))
);
create policy purchase_returns_read on purchase_returns for select using(
 tenant_id=current_tenant_id() and (has_perm('POST_PURCHASES') or has_perm('VIEW_REPORTS'))
);
create policy purchase_return_items_read on purchase_return_items for select using(
 tenant_id=current_tenant_id() and (has_perm('POST_PURCHASES') or has_perm('VIEW_REPORTS'))
);

-- Full refundable merchandise value assigned deterministically to an original
-- line. Header discounts are distributed proportionally; extra charges are not
-- merchandise and are deliberately not refunded.
create function phase65_sale_line_cap(p_line_id uuid) returns bigint
language sql stable security definer set search_path=public as $$
 with target as (
  select li.*,s.subtotal_paise,s.discount_paise as header_discount_paise
  from sale_invoice_items li join sale_invoices s on s.tenant_id=li.tenant_id and s.id=li.sale_invoice_id
  where li.id=p_line_id
 ), totals as (
  select t.*,coalesce((select sum(x.line_total_paise) from sale_invoice_items x where x.sale_invoice_id=t.sale_invoice_id),0) line_sum,
    (select max(x.line_no) from sale_invoice_items x where x.sale_invoice_id=t.sale_invoice_id) last_line
  from target t
 )
 select case when line_sum=0 then 0
   when line_no=last_line then greatest(subtotal_paise-header_discount_paise,0)-coalesce((
     select sum(floor(x.line_total_paise::numeric*greatest(totals.subtotal_paise-totals.header_discount_paise,0)/totals.line_sum)::bigint)
     from sale_invoice_items x where x.sale_invoice_id=totals.sale_invoice_id and x.line_no<>totals.last_line
   ),0)
   else floor(line_total_paise::numeric*greatest(subtotal_paise-header_discount_paise,0)/line_sum)::bigint end
 from totals
$$;
revoke all on function phase65_sale_line_cap(uuid) from public,anon,authenticated;

create function phase65_purchase_line_cap(p_line_id uuid) returns bigint
language sql stable security definer set search_path=public as $$
 with target as (
  select li.*,b.subtotal_paise,b.discount_paise
  from purchase_bill_items li join purchase_bills b on b.tenant_id=li.tenant_id and b.id=li.purchase_bill_id
  where li.id=p_line_id
 ), totals as (
  select t.*,coalesce((select sum(x.line_total_paise) from purchase_bill_items x where x.purchase_bill_id=t.purchase_bill_id),0) line_sum,
    (select max(x.line_no) from purchase_bill_items x where x.purchase_bill_id=t.purchase_bill_id) last_line
  from target t
 )
 select case when line_sum=0 then 0
   when line_no=last_line then greatest(subtotal_paise-discount_paise,0)-coalesce((
     select sum(floor(x.line_total_paise::numeric*greatest(totals.subtotal_paise-totals.discount_paise,0)/totals.line_sum)::bigint)
     from purchase_bill_items x where x.purchase_bill_id=totals.purchase_bill_id and x.line_no<>totals.last_line
   ),0)
   else floor(line_total_paise::numeric*greatest(subtotal_paise-discount_paise,0)/line_sum)::bigint end
 from totals
$$;
revoke all on function phase65_purchase_line_cap(uuid) from public,anon,authenticated;

create function post_return(
 p_return_type text,p_source_id uuid,p_business_date date,p_client_id text,p_lines jsonb,p_notes text default null
) returns uuid language plpgsql security definer set search_path=public as $return$
declare
 v_tenant uuid:=current_tenant_id(); v_type text:=upper(btrim(coalesce(p_return_type,''))); v_date date;
 v_existing_id uuid; v_existing_source uuid; v_existing_fingerprint text; v_fingerprint text;
 v_sale sale_invoices%rowtype; v_sale_line sale_invoice_items%rowtype; v_sale_return uuid;
 v_purchase purchase_bills%rowtype; v_purchase_line purchase_bill_items%rowtype; v_purchase_return uuid;
 v_line jsonb; v_ord bigint; v_qty numeric; v_base numeric; v_prior_base numeric; v_prior_amount bigint;
 v_cap bigint; v_amount bigint; v_total bigint:=0; v_disposition text; v_seq bigint; v_doc text;
 v_received bigint:=0; v_prior_refunds bigint:=0; v_refund bigint:=0;
begin
 if v_tenant is null then raise exception 'not authenticated'; end if;
 if v_type not in ('SALE','PURCHASE') then raise exception 'return type must be SALE or PURCHASE'; end if;
 if p_client_id is null or btrim(p_client_id)='' then raise exception 'client_id required'; end if;
 if p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then raise exception 'return requires lines'; end if;

 perform pg_advisory_xact_lock(hashtextextended(v_tenant::text||':return-client:'||p_client_id,0));

 if v_type='SALE' then
   if not has_perm('POST_SALES') then raise exception 'not permitted'; end if;
   select id,sale_invoice_id,request_fingerprint into v_existing_id,v_existing_source,v_existing_fingerprint
   from sale_returns where tenant_id=v_tenant and client_id=p_client_id;
 else
   if not has_perm('POST_PURCHASES') then raise exception 'not permitted'; end if;
   select id,purchase_bill_id,request_fingerprint into v_existing_id,v_existing_source,v_existing_fingerprint
   from purchase_returns where tenant_id=v_tenant and client_id=p_client_id;
 end if;
 if v_existing_id is null then
   if exists(select 1 from sale_returns where tenant_id=v_tenant and client_id=p_client_id)
      or exists(select 1 from purchase_returns where tenant_id=v_tenant and client_id=p_client_id) then
     raise exception 'client_id already used for another return type';
   end if;
 end if;

 if v_type='SALE' then
   select * into v_sale from sale_invoices where id=p_source_id and tenant_id=v_tenant for update;
   if not found or v_sale.status<>'FINALIZED' then raise exception 'sale unavailable for return'; end if;
   perform phase3_assert_shop(v_sale.shop_id);
   v_date:=coalesce(p_business_date,shop_business_date(v_sale.shop_id));
 else
   select * into v_purchase from purchase_bills where id=p_source_id and tenant_id=v_tenant for update;
   if not found or v_purchase.status<>'POSTED' then raise exception 'purchase unavailable for return'; end if;
   perform phase3_assert_shop(v_purchase.shop_id);
   v_date:=coalesce(p_business_date,shop_business_date(v_purchase.shop_id));
 end if;
 v_fingerprint:=md5(jsonb_build_object('type',v_type,'source',p_source_id,'date',v_date,'lines',p_lines,'notes',p_notes)::text);
 if v_existing_id is not null then
   if v_existing_source<>p_source_id or v_existing_fingerprint<>v_fingerprint then
     raise exception 'client_id already used with different return payload';
   end if;
   return v_existing_id;
 end if;

 -- Serialize every return for the same source document. This protects both
 -- cumulative returned quantities and the paid-amount refund ceiling.
 perform pg_advisory_xact_lock(hashtextextended(v_tenant::text||':'||v_type||'-return:'||p_source_id::text,0));

 if v_type='SALE' then
   v_seq:=next_doc_no(v_sale.shop_id,'SALE_RETURN'); v_doc:='SR-'||lpad(v_seq::text,6,'0');
   insert into sale_returns(tenant_id,shop_id,sale_invoice_id,customer_id,doc_no,doc_seq,business_date,notes,request_fingerprint,client_id)
   values(v_tenant,v_sale.shop_id,v_sale.id,v_sale.customer_id,v_doc,v_seq,v_date,p_notes,v_fingerprint,p_client_id)
   returning id into v_sale_return;

   for v_line,v_ord in select value,ordinality from jsonb_array_elements(p_lines) with ordinality loop
     begin
       v_qty:=(v_line->>'qty')::numeric;
     exception when others then raise exception 'invalid return quantity'; end;
     v_disposition:=upper(btrim(coalesce(v_line->>'disposition','')));
     if v_qty<=0 or v_disposition not in ('RETURN_TO_SELLABLE','DAMAGED','EXPIRED','SUPPLIER_RETURN') then
       raise exception 'invalid sale return line';
     end if;
     select * into v_sale_line from sale_invoice_items
       where id=(v_line->>'sale_invoice_item_id')::uuid and tenant_id=v_tenant and sale_invoice_id=v_sale.id
       for update;
     if not found then raise exception 'sale line unavailable for return'; end if;
     v_base:=v_qty*v_sale_line.base_qty/v_sale_line.qty;
     select coalesce(sum(sri.base_qty),0),coalesce(sum(sri.amount_paise),0)
       into v_prior_base,v_prior_amount
     from sale_return_items sri join sale_returns sr on sr.tenant_id=sri.tenant_id and sr.id=sri.sale_return_id
     where sri.tenant_id=v_tenant and sri.sale_invoice_item_id=v_sale_line.id and sr.status in ('DRAFT','POSTED');
     if v_prior_base+v_base>v_sale_line.base_qty then raise exception 'sale return quantity exceeds sold quantity'; end if;
     v_cap:=phase65_sale_line_cap(v_sale_line.id);
     v_amount:=floor(v_cap::numeric*(v_prior_base+v_base)/v_sale_line.base_qty)::bigint-v_prior_amount;
     insert into sale_return_items(tenant_id,shop_id,sale_return_id,sale_invoice_item_id,item_id,line_no,
       item_name_snapshot,hsn_snapshot,tax_rate_bp_snapshot,unit_name_snapshot,unit_level,qty,base_qty,amount_paise,disposition,client_id)
     values(v_tenant,v_sale.shop_id,v_sale_return,v_sale_line.id,v_sale_line.item_id,v_ord,
       v_sale_line.item_name_snapshot,v_sale_line.hsn_snapshot,v_sale_line.tax_rate_bp_snapshot,
       v_sale_line.unit_name_snapshot,v_sale_line.unit_level,v_qty,v_base,v_amount,v_disposition,p_client_id||':line:'||v_ord::text);
     if v_disposition='RETURN_TO_SELLABLE' then
       insert into stock_movements(tenant_id,shop_id,item_id,source_type,source_id,qty_base,client_id)
       values(v_tenant,v_sale.shop_id,v_sale_line.item_id,'SALE_RETURN',v_sale_return,v_base,p_client_id||':stock:'||v_ord::text);
     end if;
     v_total:=v_total+v_amount;
   end loop;

   select
     coalesce((select sum(pa.amount_paise) from payment_allocations pa join payments p on p.tenant_id=pa.tenant_id and p.id=pa.payment_id
       where pa.tenant_id=v_tenant and pa.sale_invoice_id=v_sale.id and pa.status='POSTED' and p.status='POSTED' and p.direction='in'),0)
     +coalesce((select sum(p.amount_paise) from payments p where p.tenant_id=v_tenant and p.source_sale_invoice_id=v_sale.id
       and p.kind='walkin' and p.status='POSTED' and p.direction='in'),0),
     coalesce((select sum(p.amount_paise) from payments p where p.tenant_id=v_tenant and p.source_sale_invoice_id=v_sale.id
       and p.status='POSTED' and p.direction='out'),0)
   into v_received,v_prior_refunds;
   v_refund:=least(v_total,greatest(v_received-v_prior_refunds,0));
   update sale_returns set status='POSTED',total_paise=v_total,cash_refund_paise=v_refund,
     balance_credit_paise=v_total-v_refund,posted_at=clock_timestamp() where id=v_sale_return;
   if v_refund>0 then
     insert into payments(tenant_id,shop_id,kind,customer_id,party_id,source_sale_invoice_id,source_sale_return_id,
       business_date,amount_paise,direction,mode,reference,status,client_id)
     values(v_tenant,v_sale.shop_id,case when v_sale.customer_id is null then 'walkin' else 'customer' end,
       v_sale.customer_id,null,v_sale.id,v_sale_return,v_date,v_refund,'out','cash','Refund '||v_doc,'POSTED',p_client_id||':refund');
   end if;
   return v_sale_return;
 end if;

 v_seq:=next_doc_no(v_purchase.shop_id,'PURCHASE_RETURN'); v_doc:='PR-'||lpad(v_seq::text,6,'0');
 insert into purchase_returns(tenant_id,shop_id,purchase_bill_id,party_id,doc_no,doc_seq,business_date,notes,request_fingerprint,client_id)
 values(v_tenant,v_purchase.shop_id,v_purchase.id,v_purchase.party_id,v_doc,v_seq,v_date,p_notes,v_fingerprint,p_client_id)
 returning id into v_purchase_return;

 for v_line,v_ord in select value,ordinality from jsonb_array_elements(p_lines) with ordinality loop
   begin
     v_qty:=(v_line->>'qty')::numeric;
   exception when others then raise exception 'invalid return quantity'; end;
   v_disposition:=upper(btrim(coalesce(v_line->>'disposition','')));
   if v_qty<=0 or v_disposition not in ('RETURN_TO_SELLABLE','DAMAGED','EXPIRED','SUPPLIER_RETURN') then
     raise exception 'invalid purchase return line';
   end if;
   select * into v_purchase_line from purchase_bill_items
     where id=(v_line->>'purchase_bill_item_id')::uuid and tenant_id=v_tenant and purchase_bill_id=v_purchase.id
     for update;
   if not found then raise exception 'purchase line unavailable for return'; end if;
   v_base:=v_qty*v_purchase_line.base_qty/v_purchase_line.qty;
   select coalesce(sum(pri.base_qty),0),coalesce(sum(pri.amount_paise),0)
     into v_prior_base,v_prior_amount
   from purchase_return_items pri join purchase_returns pr on pr.tenant_id=pri.tenant_id and pr.id=pri.purchase_return_id
   where pri.tenant_id=v_tenant and pri.purchase_bill_item_id=v_purchase_line.id and pr.status in ('DRAFT','POSTED');
   if v_prior_base+v_base>v_purchase_line.base_qty then raise exception 'purchase return quantity exceeds purchased quantity'; end if;
   v_cap:=phase65_purchase_line_cap(v_purchase_line.id);
   v_amount:=floor(v_cap::numeric*(v_prior_base+v_base)/v_purchase_line.base_qty)::bigint-v_prior_amount;
   insert into purchase_return_items(tenant_id,shop_id,purchase_return_id,purchase_bill_item_id,item_id,line_no,
     item_name_snapshot,hsn_snapshot,tax_rate_bp_snapshot,unit_name_snapshot,unit_level,qty,base_qty,amount_paise,disposition,client_id)
   values(v_tenant,v_purchase.shop_id,v_purchase_return,v_purchase_line.id,v_purchase_line.item_id,v_ord,
     v_purchase_line.item_name_snapshot,v_purchase_line.hsn_snapshot,v_purchase_line.tax_rate_bp_snapshot,
     v_purchase_line.unit_name_snapshot,v_purchase_line.unit_level,v_qty,v_base,v_amount,v_disposition,p_client_id||':line:'||v_ord::text);
   if v_disposition<>'RETURN_TO_SELLABLE' then
     insert into stock_current(tenant_id,shop_id,item_id,on_hand,reserved)
       values(v_tenant,v_purchase.shop_id,v_purchase_line.item_id,0,0) on conflict do nothing;
     perform 1 from stock_current where tenant_id=v_tenant and shop_id=v_purchase.shop_id and item_id=v_purchase_line.item_id for update;
     if not exists(select 1 from stock_current where tenant_id=v_tenant and shop_id=v_purchase.shop_id
       and item_id=v_purchase_line.item_id and available>=v_base) then raise exception 'insufficient stock for purchase return'; end if;
     insert into stock_movements(tenant_id,shop_id,item_id,source_type,source_id,qty_base,client_id)
       values(v_tenant,v_purchase.shop_id,v_purchase_line.item_id,'PURCHASE_RETURN',v_purchase_return,-v_base,p_client_id||':stock:'||v_ord::text);
   end if;
   v_total:=v_total+v_amount;
 end loop;
 update purchase_returns set status='POSTED',total_paise=v_total,posted_at=clock_timestamp() where id=v_purchase_return;
 return v_purchase_return;
end
$return$;

create function void_return(p_return_type text,p_return_id uuid,p_client_id text)
returns uuid language plpgsql security definer set search_path=public as $void$
declare v_tenant uuid:=current_tenant_id(); v_type text:=upper(btrim(coalesce(p_return_type,'')));
 v_sr sale_returns%rowtype; v_pr purchase_returns%rowtype; v_move record; v_available numeric;
begin
 if p_client_id is null or btrim(p_client_id)='' then raise exception 'client_id required'; end if;
 if v_type='SALE' then
   if not has_perm('VOID_SALES') then raise exception 'not permitted'; end if;
   select * into v_sr from sale_returns where id=p_return_id and tenant_id=v_tenant for update;
   if not found then raise exception 'sale return not found'; end if;
   if v_sr.status='VOID' then return v_sr.id; end if;
   for v_move in select item_id,sum(qty_base) qty from stock_movements
     where tenant_id=v_tenant and source_id=v_sr.id and source_type='SALE_RETURN' group by item_id order by item_id loop
     insert into stock_current(tenant_id,shop_id,item_id,on_hand,reserved)
       values(v_tenant,v_sr.shop_id,v_move.item_id,0,0) on conflict do nothing;
     select available into v_available from stock_current
       where tenant_id=v_tenant and shop_id=v_sr.shop_id and item_id=v_move.item_id for update;
     if v_available<v_move.qty then raise exception 'insufficient stock to void sale return'; end if;
     insert into stock_movements(tenant_id,shop_id,item_id,source_type,source_id,qty_base,client_id)
       values(v_tenant,v_sr.shop_id,v_move.item_id,'SALE_RETURN_VOID',v_sr.id,-v_move.qty,p_client_id||':stock:'||v_move.item_id::text);
   end loop;
   update payments set status='VOID',voided_at=clock_timestamp()
     where tenant_id=v_tenant and source_sale_return_id=v_sr.id and status='POSTED';
   update sale_returns set status='VOID',voided_at=clock_timestamp() where id=v_sr.id;
   return v_sr.id;
 elsif v_type='PURCHASE' then
   if not has_perm('POST_PURCHASES') then raise exception 'not permitted'; end if;
   select * into v_pr from purchase_returns where id=p_return_id and tenant_id=v_tenant for update;
   if not found then raise exception 'purchase return not found'; end if;
   if v_pr.status='VOID' then return v_pr.id; end if;
   for v_move in select item_id,sum(qty_base) qty from stock_movements
     where tenant_id=v_tenant and source_id=v_pr.id and source_type='PURCHASE_RETURN' group by item_id order by item_id loop
     insert into stock_movements(tenant_id,shop_id,item_id,source_type,source_id,qty_base,client_id)
       values(v_tenant,v_pr.shop_id,v_move.item_id,'PURCHASE_RETURN_VOID',v_pr.id,-v_move.qty,p_client_id||':stock:'||v_move.item_id::text);
   end loop;
   update purchase_returns set status='VOID',voided_at=clock_timestamp() where id=v_pr.id;
   return v_pr.id;
 end if;
 raise exception 'return type must be SALE or PURCHASE';
end
$void$;

-- A source document with a posted return cannot itself be voided; doing both
-- would reverse the same economic event twice.
create function phase65_source_void_guard() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if tg_table_name='sale_invoices' and new.status='VOID' and old.status<>'VOID'
    and exists(select 1 from sale_returns where tenant_id=old.tenant_id and sale_invoice_id=old.id and status='POSTED') then
   raise exception 'void posted returns before voiding the sale';
 end if;
 if tg_table_name='purchase_bills' and new.status='VOID' and old.status<>'VOID'
    and exists(select 1 from purchase_returns where tenant_id=old.tenant_id and purchase_bill_id=old.id and status='POSTED') then
   raise exception 'void posted returns before voiding the purchase';
 end if;
 return new;
end $$;
create trigger sale_source_return_guard before update on sale_invoices for each row execute function phase65_source_void_guard();
create trigger purchase_source_return_guard before update on purchase_bills for each row execute function phase65_source_void_guard();

create or replace function phase4_payment_guard() returns trigger language plpgsql as $$
begin
 if old.status='POSTED' and new.status='VOID'
    and new.tenant_id=old.tenant_id and new.shop_id=old.shop_id and new.kind=old.kind
    and new.customer_id is not distinct from old.customer_id and new.party_id is not distinct from old.party_id
    and new.source_sale_invoice_id is not distinct from old.source_sale_invoice_id
    and new.source_sale_return_id is not distinct from old.source_sale_return_id
    and new.business_date=old.business_date and new.amount_paise=old.amount_paise
    and new.direction=old.direction and new.mode=old.mode
    and new.reference is not distinct from old.reference and new.voided_at is not null then return new;
 end if;
 raise exception 'payment is immutable; use void_payment or void_return';
end $$;

create or replace function phase4_validate_allocation() returns trigger
language plpgsql security definer set search_path=public as $$
declare v_payment payments%rowtype; v_customer uuid; v_party uuid; v_doc_total bigint; v_allocated bigint;
begin
 select * into v_payment from payments where id=new.payment_id and tenant_id=new.tenant_id;
 if not found or v_payment.status<>'POSTED' or v_payment.direction<>'in' then raise exception 'payment unavailable'; end if;
 if new.doc_type='SALE' then
   select s.customer_id,s.total_paise-coalesce((select sum(sr.total_paise) from sale_returns sr
     where sr.tenant_id=s.tenant_id and sr.sale_invoice_id=s.id and sr.status='POSTED'),0)
     into v_customer,v_doc_total from sale_invoices s
     where s.id=new.sale_invoice_id and s.tenant_id=new.tenant_id and s.status='FINALIZED' for update;
   if not found then raise exception 'sale unavailable'; end if;
   if v_payment.kind<>'customer' or v_customer is distinct from v_payment.customer_id then raise exception 'payment and sale customer mismatch'; end if;
   select coalesce(sum(amount_paise),0) into v_allocated from payment_allocations
     where tenant_id=new.tenant_id and sale_invoice_id=new.sale_invoice_id and status='POSTED';
 else
   select party_id,total_paise into v_party,v_doc_total from purchase_bills
     where id=new.purchase_bill_id and tenant_id=new.tenant_id and status='POSTED' for update;
   if not found then raise exception 'purchase unavailable'; end if;
   if v_payment.kind<>'party' or v_party is distinct from v_payment.party_id then raise exception 'payment and purchase party mismatch'; end if;
   select coalesce(sum(amount_paise),0) into v_allocated from payment_allocations
     where tenant_id=new.tenant_id and purchase_bill_id=new.purchase_bill_id and status='POSTED';
 end if;
 if v_allocated+new.amount_paise>greatest(v_doc_total,0) then raise exception 'allocation exceeds document outstanding amount'; end if;
 return new;
end $$;

revoke all on function post_return(text,uuid,date,text,jsonb,text),void_return(text,uuid,text) from public,anon;
grant execute on function post_return(text,uuid,date,text,jsonb,text),void_return(text,uuid,text) to authenticated;

do $backup$
begin
 if exists(select 1 from pg_roles where rolname='backup_ro') then
   execute 'grant select on table sale_returns,sale_return_items,purchase_returns,purchase_return_items to backup_ro';
 end if;
end
$backup$;

drop view customer_balances;
drop view customer_ledger;
create view customer_ledger with(security_invoker=true) as
 select tenant_id,customer_id,business_date,created_at,'SALE'::text entry_type,id ref_id,doc_no reference,
   total_paise debit_paise,0::bigint credit_paise
 from sale_invoices where customer_id is not null and status='FINALIZED' and deleted_at is null
 union all
 select tenant_id,customer_id,business_date,created_at,
   case when direction='out' then 'REFUND' else 'PAYMENT' end::text entry_type,id ref_id,coalesce(reference,mode) reference,
   case when direction='out' then amount_paise else 0 end::bigint debit_paise,
   case when direction='in' then amount_paise else 0 end::bigint credit_paise
 from payments where kind='customer' and customer_id is not null and status='POSTED' and deleted_at is null
 union all
 select tenant_id,customer_id,business_date,created_at,'SALE_RETURN'::text entry_type,id ref_id,doc_no reference,
   0::bigint debit_paise,total_paise credit_paise
 from sale_returns where customer_id is not null and status='POSTED' and deleted_at is null;
create view customer_balances with(security_invoker=true) as
 select tenant_id,customer_id,coalesce(sum(debit_paise-credit_paise),0)::bigint balance_paise
 from customer_ledger group by tenant_id,customer_id;
grant select on customer_ledger,customer_balances to authenticated;

drop view customer_invoice_outstanding;
create view customer_invoice_outstanding with(security_invoker=true) as
with allocation_totals as (
 select pa.tenant_id,pa.sale_invoice_id,sum(pa.amount_paise)::bigint allocated_paise
 from payment_allocations pa join payments p on p.tenant_id=pa.tenant_id and p.id=pa.payment_id
 where pa.status='POSTED' and p.status='POSTED' and p.direction='in' group by pa.tenant_id,pa.sale_invoice_id
), return_totals as (
 select tenant_id,sale_invoice_id,sum(total_paise)::bigint returned_paise
 from sale_returns where status='POSTED' group by tenant_id,sale_invoice_id
), refund_totals as (
 select tenant_id,source_sale_invoice_id sale_invoice_id,sum(amount_paise)::bigint refunded_paise
 from payments where status='POSTED' and direction='out' and source_sale_invoice_id is not null
 group by tenant_id,source_sale_invoice_id
)
select s.tenant_id,s.customer_id,s.id sale_invoice_id,s.doc_no,s.business_date,s.total_paise,
 coalesce(a.allocated_paise,0)::bigint allocated_paise,
 greatest(s.total_paise-coalesce(r.returned_paise,0)-coalesce(a.allocated_paise,0)+coalesce(f.refunded_paise,0),0)::bigint outstanding_paise
from sale_invoices s
left join allocation_totals a on a.tenant_id=s.tenant_id and a.sale_invoice_id=s.id
left join return_totals r on r.tenant_id=s.tenant_id and r.sale_invoice_id=s.id
left join refund_totals f on f.tenant_id=s.tenant_id and f.sale_invoice_id=s.id
where s.customer_id is not null and s.status='FINALIZED' and s.deleted_at is null
 and s.total_paise-coalesce(r.returned_paise,0)-coalesce(a.allocated_paise,0)+coalesce(f.refunded_paise,0)>0;
grant select on customer_invoice_outstanding to authenticated;

create or replace function get_party_ledger(p_party_id uuid,p_from date default null,p_to date default null)
returns table(business_date date,entry_type text,document text,debit_paise bigint,credit_paise bigint,running_balance_paise bigint)
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=phase6_assert_report_access();
begin
 return query
 with entries(entry_date,entry_kind,entry_document,debit,credit,entry_created,entry_id) as (
  select pb.business_date,'PURCHASE'::text,coalesce(pb.bill_no,pb.id::text),pb.total_paise::bigint,0::bigint,pb.created_at,pb.id
  from purchase_bills pb where pb.tenant_id=v_tenant and pb.party_id=p_party_id and pb.status='POSTED'
    and (p_to is null or pb.business_date<=p_to)
  union all
  select pr.business_date,'PURCHASE_RETURN'::text,pr.doc_no,0::bigint,pr.total_paise::bigint,pr.created_at,pr.id
  from purchase_returns pr where pr.tenant_id=v_tenant and pr.party_id=p_party_id and pr.status='POSTED'
    and (p_to is null or pr.business_date<=p_to)
  union all
  select p.business_date,'PAYMENT'::text,coalesce(p.reference,p.id::text),
    case when p.direction='in' then p.amount_paise else 0 end::bigint,
    case when p.direction='out' then p.amount_paise else 0 end::bigint,p.created_at,p.id
  from payments p where p.tenant_id=v_tenant and p.party_id=p_party_id and p.status='POSTED'
    and (p_to is null or p.business_date<=p_to)
 ), balances as (
  select *,sum(debit-credit) over(order by entry_date,entry_created,entry_id) balance from entries
 )
 select entry_date,entry_kind,entry_document,debit,credit,balance::bigint from balances
 where p_from is null or entry_date>=p_from order by entry_date,entry_created,entry_id;
end $$;

create or replace function get_day_book(p_shop_id uuid,p_from date,p_to date)
returns table(business_date date,sales_paise bigint,purchases_paise bigint,receipts_paise bigint,payments_paise bigint,expenses_paise bigint,net_cashflow_paise bigint)
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=phase6_assert_report_access();
begin
 perform phase3_assert_shop(p_shop_id);
 return query
 with d as (select generate_series(p_from,p_to,'1 day'::interval)::date entry_date)
 select d.entry_date,
  (coalesce((select sum(total_paise) from sale_invoices s where s.tenant_id=v_tenant and s.shop_id=p_shop_id and s.status='FINALIZED' and s.business_date=d.entry_date),0)
   -coalesce((select sum(total_paise) from sale_returns r where r.tenant_id=v_tenant and r.shop_id=p_shop_id and r.status='POSTED' and r.business_date=d.entry_date),0))::bigint,
  (coalesce((select sum(total_paise) from purchase_bills b where b.tenant_id=v_tenant and b.shop_id=p_shop_id and b.status='POSTED' and b.business_date=d.entry_date),0)
   -coalesce((select sum(total_paise) from purchase_returns r where r.tenant_id=v_tenant and r.shop_id=p_shop_id and r.status='POSTED' and r.business_date=d.entry_date),0))::bigint,
  coalesce((select sum(case when direction='in' then amount_paise else -amount_paise end) from payments p
    where p.tenant_id=v_tenant and p.shop_id=p_shop_id and p.kind in ('customer','walkin') and p.status='POSTED' and p.business_date=d.entry_date),0)::bigint,
  coalesce((select sum(case when direction='out' then amount_paise else -amount_paise end) from payments p
    where p.tenant_id=v_tenant and p.shop_id=p_shop_id and p.kind='party' and p.status='POSTED' and p.business_date=d.entry_date),0)::bigint,
  coalesce((select sum(amount_paise) from expenses e where e.tenant_id=v_tenant and e.shop_id=p_shop_id and e.status='POSTED' and e.business_date=d.entry_date),0)::bigint,
  (coalesce((select sum(case when direction='in' then amount_paise else -amount_paise end) from payments p
     where p.tenant_id=v_tenant and p.shop_id=p_shop_id and p.kind in ('customer','walkin') and p.status='POSTED' and p.business_date=d.entry_date),0)
   -coalesce((select sum(case when direction='out' then amount_paise else -amount_paise end) from payments p
     where p.tenant_id=v_tenant and p.shop_id=p_shop_id and p.kind='party' and p.status='POSTED' and p.business_date=d.entry_date),0)
   -coalesce((select sum(amount_paise) from expenses e where e.tenant_id=v_tenant and e.shop_id=p_shop_id and e.status='POSTED' and e.business_date=d.entry_date),0))::bigint
 from d order by d.entry_date;
end $$;

create or replace function get_gst_summary(p_shop_id uuid,p_from date,p_to date)
returns table(tax_rate_bp integer,taxable_sales_paise bigint,gross_sales_paise bigint,taxable_purchases_paise bigint,gross_purchases_paise bigint)
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=phase6_assert_report_access();
begin
 perform phase3_assert_shop(p_shop_id);
 return query
 with sale_base as (
  select sii.tax_rate_bp_snapshot rate,sii.line_total_paise,si.id invoice_id,
   greatest(si.subtotal_paise-si.discount_paise,0)::bigint after_all_discounts,
   sum(sii.line_total_paise) over(partition by si.id)::bigint after_line_discounts
  from sale_invoice_items sii join sale_invoices si on si.tenant_id=sii.tenant_id and si.id=sii.sale_invoice_id
  where sii.tenant_id=v_tenant and sii.shop_id=p_shop_id and si.status='FINALIZED' and si.business_date between p_from and p_to
 ), sale_lines as (
  select rate,case when after_line_discounts>0 then round(line_total_paise::numeric*after_all_discounts/after_line_discounts)::bigint else 0::bigint end adjusted from sale_base
  union all
  select sri.tax_rate_bp_snapshot,-sri.amount_paise from sale_return_items sri
   join sale_returns sr on sr.tenant_id=sri.tenant_id and sr.id=sri.sale_return_id
   where sri.tenant_id=v_tenant and sri.shop_id=p_shop_id and sr.status='POSTED' and sr.business_date between p_from and p_to
 ), purchase_lines as (
  select pbi.tax_rate_bp_snapshot rate,
   case when pb.subtotal_paise>0 then round(pbi.line_total_paise::numeric*greatest(pb.subtotal_paise-pb.discount_paise,0)/pb.subtotal_paise)::bigint else 0::bigint end adjusted
  from purchase_bill_items pbi join purchase_bills pb on pb.tenant_id=pbi.tenant_id and pb.id=pbi.purchase_bill_id
  where pbi.tenant_id=v_tenant and pbi.shop_id=p_shop_id and pb.status='POSTED' and pb.business_date between p_from and p_to
  union all
  select pri.tax_rate_bp_snapshot,-pri.amount_paise from purchase_return_items pri
   join purchase_returns pr on pr.tenant_id=pri.tenant_id and pr.id=pri.purchase_return_id
   where pri.tenant_id=v_tenant and pri.shop_id=p_shop_id and pr.status='POSTED' and pr.business_date between p_from and p_to
 ), s as (select rate,sum(adjusted)::bigint gross from sale_lines group by rate),
 p as (select rate,sum(adjusted)::bigint gross from purchase_lines group by rate),rates as (select rate from s union select rate from p)
 select r.rate,round(coalesce(s.gross,0)*10000.0/(10000+r.rate))::bigint,coalesce(s.gross,0)::bigint,
  round(coalesce(p.gross,0)*10000.0/(10000+r.rate))::bigint,coalesce(p.gross,0)::bigint
 from rates r left join s using(rate) left join p using(rate) order by r.rate;
end $$;

alter function phase6_export_tenant(uuid) rename to phase6_export_tenant_v4_base;
revoke all on function phase6_export_tenant_v4_base(uuid) from public,anon,authenticated;
create function phase6_export_tenant(p_shop_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_base jsonb; v_tenant uuid;
begin
 v_base:=phase6_export_tenant_v4_base(p_shop_id); v_tenant:=(v_base->>'tenantId')::uuid;
 return v_base || jsonb_build_object(
  'schemaVersion',4,
  'saleReturns',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from sale_returns where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'saleReturnLines',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from sale_return_items where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'purchaseReturns',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from purchase_returns where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'purchaseReturnLines',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from purchase_return_items where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb)
 );
end $$;
revoke all on function phase6_export_tenant(uuid) from public,anon;
grant execute on function phase6_export_tenant(uuid) to authenticated;

create or replace function get_shop_day_reconciliation(p_shop_id uuid,p_business_date date)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid; v_date date; v_result jsonb;
begin
 v_tenant:=phase3_assert_shop(p_shop_id); v_date:=coalesce(p_business_date,shop_business_date(p_shop_id));
 with finalized as (
  select id,total_paise,discount_paise,extra_charges_paise from sale_invoices
  where tenant_id=v_tenant and shop_id=p_shop_id and business_date=v_date and status='FINALIZED' and deleted_at is null
 ), voided as (
  select id,total_paise from sale_invoices where tenant_id=v_tenant and shop_id=p_shop_id and business_date=v_date and status='VOID' and deleted_at is null
 ), day_returns as (
  select id,total_paise,cash_refund_paise from sale_returns
  where tenant_id=v_tenant and shop_id=p_shop_id and business_date=v_date and status='POSTED' and deleted_at is null
 ), direct_sale_receipts as (
  select p.id,p.amount_paise,p.mode from payments p join finalized f on f.id=p.source_sale_invoice_id
  where p.tenant_id=v_tenant and p.shop_id=p_shop_id and p.business_date=v_date and p.status='POSTED'
    and p.deleted_at is null and p.kind in ('walkin','customer') and p.direction='in'
 ), standalone_customer_receipts as (
  select p.id,p.amount_paise,p.mode from payments p
  where p.tenant_id=v_tenant and p.shop_id=p_shop_id and p.business_date=v_date and p.status='POSTED'
    and p.deleted_at is null and p.kind='customer' and p.source_sale_invoice_id is null and p.direction='in'
 ), standalone_allocations as (
  select r.id payment_id,coalesce(sum(pa.amount_paise) filter(where pa.status='POSTED' and pa.deleted_at is null),0)::bigint allocated_paise
  from standalone_customer_receipts r left join payment_allocations pa on pa.payment_id=r.id and pa.tenant_id=v_tenant group by r.id
 ), customer_cash as (
  select amount_paise::bigint signed_amount,mode from direct_sale_receipts
  union all select amount_paise::bigint,mode from standalone_customer_receipts
  union all select -p.amount_paise::bigint,p.mode from payments p
    where p.tenant_id=v_tenant and p.shop_id=p_shop_id and p.business_date=v_date and p.status='POSTED'
      and p.deleted_at is null and p.kind in ('walkin','customer') and p.direction='out'
 ), balance_events as (
  select customer_id,total_paise::bigint delta from sale_invoices
   where tenant_id=v_tenant and shop_id=p_shop_id and customer_id is not null and status='FINALIZED' and deleted_at is null
  union all
  select customer_id,case when direction='in' then -amount_paise else amount_paise end::bigint from payments
   where tenant_id=v_tenant and shop_id=p_shop_id and kind='customer' and customer_id is not null and status='POSTED' and deleted_at is null
  union all
  select customer_id,-total_paise::bigint from sale_returns
   where tenant_id=v_tenant and shop_id=p_shop_id and customer_id is not null and status='POSTED' and deleted_at is null
 ), customer_balances_now as (
  select customer_id,sum(delta)::bigint balance_paise from balance_events group by customer_id
 ), sold_base as (
  select sii.item_id,max(sii.item_name_snapshot) item_name,
    sum(sii.base_qty)::numeric sold_qty_smallest,count(*)::bigint sale_lines
  from sale_invoice_items sii join sale_invoices si on si.id=sii.sale_invoice_id and si.tenant_id=sii.tenant_id
  where sii.tenant_id=v_tenant and sii.shop_id=p_shop_id and si.business_date=v_date and si.status='FINALIZED'
    and sii.deleted_at is null and si.deleted_at is null group by sii.item_id
 ), returned_base as (
  select sri.item_id,sum(sri.base_qty)::numeric returned_qty_smallest
  from sale_return_items sri join sale_returns sr on sr.tenant_id=sri.tenant_id and sr.id=sri.sale_return_id
  where sri.tenant_id=v_tenant and sri.shop_id=p_shop_id and sr.business_date=v_date and sr.status='POSTED'
  group by sri.item_id
 ), sold as (
  select s.*,s.sold_qty_smallest-coalesce(r.returned_qty_smallest,0) sold_qty_net
  from sold_base s left join returned_base r using(item_id)
 )
 select jsonb_build_object(
  'businessDate',v_date,
  'invoiceCount',(select count(*)::bigint from finalized),
  'salesTotalPaise',coalesce((select sum(total_paise) from finalized),0)::bigint,
  'saleReturnCount',(select count(*)::bigint from day_returns),
  'saleReturnTotalPaise',coalesce((select sum(total_paise) from day_returns),0)::bigint,
  'cashRefundPaise',coalesce((select sum(cash_refund_paise) from day_returns),0)::bigint,
  'netSalesTotalPaise',(coalesce((select sum(total_paise) from finalized),0)-coalesce((select sum(total_paise) from day_returns),0))::bigint,
  'discountPaise',coalesce((select sum(discount_paise) from finalized),0)::bigint,
  'extraChargesPaise',coalesce((select sum(extra_charges_paise) from finalized),0)::bigint,
  'voidCount',(select count(*)::bigint from voided),
  'voidedTotalPaise',coalesce((select sum(total_paise) from voided),0)::bigint,
  'directSaleReceiptsPaise',coalesce((select sum(amount_paise) from direct_sale_receipts),0)::bigint,
  'creditCreatedPaise',greatest(coalesce((select sum(total_paise) from finalized),0)-coalesce((select sum(amount_paise) from direct_sale_receipts),0),0)::bigint,
  'standaloneCustomerReceiptsPaise',coalesce((select sum(amount_paise) from standalone_customer_receipts),0)::bigint,
  'standaloneAllocatedPaise',coalesce((select sum(allocated_paise) from standalone_allocations),0)::bigint,
  'standaloneAdvancePaise',coalesce((select sum(greatest(r.amount_paise-a.allocated_paise,0)) from standalone_customer_receipts r join standalone_allocations a on a.payment_id=r.id),0)::bigint,
  'allCustomerReceiptsPaise',coalesce((select sum(signed_amount) from customer_cash),0)::bigint,
  'paymentModes',coalesce((select jsonb_build_object(
    'cash',coalesce(sum(signed_amount) filter(where mode='cash'),0)::bigint,
    'upi',coalesce(sum(signed_amount) filter(where mode='upi'),0)::bigint,
    'card',coalesce(sum(signed_amount) filter(where mode='card'),0)::bigint,
    'bank',coalesce(sum(signed_amount) filter(where mode='bank'),0)::bigint,
    'other',coalesce(sum(signed_amount) filter(where mode='other'),0)::bigint) from customer_cash),
    '{"cash":0,"upi":0,"card":0,"bank":0,"other":0}'::jsonb),
  'currentCustomerOutstandingPaise',coalesce((select sum(greatest(balance_paise,0)) from customer_balances_now),0)::bigint,
  'currentCustomerAdvancePaise',coalesce((select sum(greatest(-balance_paise,0)) from customer_balances_now),0)::bigint,
  'soldItems',coalesce((select jsonb_agg(jsonb_build_object(
    'itemId',s.item_id,'name',s.item_name,'soldQtySmallest',s.sold_qty_net,'saleLines',s.sale_lines,
    'smallestUnit',coalesce(i.unit3,i.unit2,i.unit1),'currentStockSmallest',coalesce(sc.qty_base,0)) order by s.item_name)
    from sold s join items i on i.id=s.item_id and i.tenant_id=v_tenant
    left join stock_current sc on sc.tenant_id=v_tenant and sc.shop_id=p_shop_id and sc.item_id=s.item_id),'[]'::jsonb)
 ) into v_result;
 return v_result;
end $$;

create or replace function check_invariants()
returns jsonb language plpgsql stable security definer set search_path=public as $invariants$
declare v_tenant uuid:=phase6_assert_report_access();
 bad_sales bigint; bad_purchases bigint; bad_stock bigint; bad_alloc bigint; bad_projection bigint; bad_voids bigint;
 bad_sale_returns bigint; bad_purchase_returns bigint; bad_return_qty bigint; bad_refunds bigint; bad_payment_direction bigint;
begin
 select count(*) into bad_sales from sale_invoices s where s.tenant_id=v_tenant and s.status='FINALIZED' and
  (s.subtotal_paise<>(select coalesce(sum(li.line_total_paise+li.discount_paise),0) from sale_invoice_items li where li.sale_invoice_id=s.id)
   or s.total_paise<>s.subtotal_paise-s.discount_paise+s.extra_charges_paise);
 select count(*) into bad_purchases from purchase_bills b where b.tenant_id=v_tenant and b.status='POSTED' and
  (b.subtotal_paise<>(select coalesce(sum(li.line_total_paise),0) from purchase_bill_items li where li.purchase_bill_id=b.id)
   or b.total_paise<>b.subtotal_paise-b.discount_paise+b.extra_charges_paise);
 select count(*) into bad_stock from stock_current where tenant_id=v_tenant and qty_base<0;
 select count(*) into bad_alloc from payments p where p.tenant_id=v_tenant and
  (select coalesce(sum(amount_paise),0) from payment_allocations a where a.payment_id=p.id and a.status='POSTED')>p.amount_paise;
 select count(*) into bad_payment_direction from payment_allocations a join payments p on p.tenant_id=a.tenant_id and p.id=a.payment_id
  where a.tenant_id=v_tenant and a.status='POSTED' and (p.status<>'POSTED' or p.direction<>'in');
 select count(*) into bad_projection from (
  select coalesce(sc.shop_id,m.shop_id) shop_id,coalesce(sc.item_id,m.item_id) item_id,coalesce(sc.qty_base,0) projected,coalesce(m.moved,0) moved
  from stock_current sc full join (select tenant_id,shop_id,item_id,sum(qty_base) moved from stock_movements where tenant_id=v_tenant group by tenant_id,shop_id,item_id) m
   on m.tenant_id=sc.tenant_id and m.shop_id=sc.shop_id and m.item_id=sc.item_id where coalesce(sc.tenant_id,m.tenant_id)=v_tenant
 ) q where q.projected<>q.moved;
 select count(*) into bad_voids from (
  select s.id,m.item_id,sum(m.qty_base) net from sale_invoices s join stock_movements m on m.tenant_id=s.tenant_id and m.source_id=s.id
   where s.tenant_id=v_tenant and s.status='VOID' and m.source_type in ('SALE','SALE_VOID') group by s.id,m.item_id having sum(m.qty_base)<>0
  union all
  select p.id,m.item_id,sum(m.qty_base) net from purchase_bills p join stock_movements m on m.tenant_id=p.tenant_id and m.source_id=p.id
   where p.tenant_id=v_tenant and p.status='VOID' and m.source_type in ('PURCHASE','PURCHASE_VOID') group by p.id,m.item_id having sum(m.qty_base)<>0
  union all
  select r.id,m.item_id,sum(m.qty_base) net from sale_returns r join stock_movements m on m.tenant_id=r.tenant_id and m.source_id=r.id
   where r.tenant_id=v_tenant and r.status='VOID' and m.source_type in ('SALE_RETURN','SALE_RETURN_VOID') group by r.id,m.item_id having sum(m.qty_base)<>0
  union all
  select r.id,m.item_id,sum(m.qty_base) net from purchase_returns r join stock_movements m on m.tenant_id=r.tenant_id and m.source_id=r.id
   where r.tenant_id=v_tenant and r.status='VOID' and m.source_type in ('PURCHASE_RETURN','PURCHASE_RETURN_VOID') group by r.id,m.item_id having sum(m.qty_base)<>0
 ) violations;
 select count(*) into bad_sale_returns from sale_returns r where r.tenant_id=v_tenant and r.status in ('POSTED','VOID') and
  (r.total_paise<>(select coalesce(sum(i.amount_paise),0) from sale_return_items i where i.sale_return_id=r.id)
   or r.total_paise<>r.cash_refund_paise+r.balance_credit_paise);
 select count(*) into bad_purchase_returns from purchase_returns r where r.tenant_id=v_tenant and r.status in ('POSTED','VOID') and
  r.total_paise<>(select coalesce(sum(i.amount_paise),0) from purchase_return_items i where i.purchase_return_id=r.id);
 select count(*) into bad_return_qty from (
  select li.id from sale_invoice_items li left join sale_return_items ri on ri.tenant_id=li.tenant_id and ri.sale_invoice_item_id=li.id
   left join sale_returns r on r.tenant_id=ri.tenant_id and r.id=ri.sale_return_id and r.status='POSTED'
   where li.tenant_id=v_tenant group by li.id,li.base_qty having coalesce(sum(ri.base_qty) filter(where r.id is not null),0)>li.base_qty
  union all
  select li.id from purchase_bill_items li left join purchase_return_items ri on ri.tenant_id=li.tenant_id and ri.purchase_bill_item_id=li.id
   left join purchase_returns r on r.tenant_id=ri.tenant_id and r.id=ri.purchase_return_id and r.status='POSTED'
   where li.tenant_id=v_tenant group by li.id,li.base_qty having coalesce(sum(ri.base_qty) filter(where r.id is not null),0)>li.base_qty
 ) excess;
 select count(*) into bad_refunds from sale_returns r where r.tenant_id=v_tenant and (
  (r.status='POSTED' and ((r.cash_refund_paise=0 and exists(select 1 from payments p where p.source_sale_return_id=r.id and p.status='POSTED'))
    or (r.cash_refund_paise>0 and (select count(*) from payments p where p.source_sale_return_id=r.id and p.status='POSTED' and p.direction='out' and p.amount_paise=r.cash_refund_paise)<>1)))
  or (r.status='VOID' and exists(select 1 from payments p where p.source_sale_return_id=r.id and p.status<>'VOID'))
 );
 return jsonb_build_object('ok',bad_sales=0 and bad_purchases=0 and bad_stock=0 and bad_alloc=0 and bad_projection=0 and bad_voids=0
   and bad_sale_returns=0 and bad_purchase_returns=0 and bad_return_qty=0 and bad_refunds=0 and bad_payment_direction=0,
  'saleTotalViolations',bad_sales,'purchaseTotalViolations',bad_purchases,'negativeStock',bad_stock,
  'allocationViolations',bad_alloc,'stockProjectionViolations',bad_projection,'voidReversalViolations',bad_voids,
  'saleReturnViolations',bad_sale_returns,'purchaseReturnViolations',bad_purchase_returns,
  'returnQuantityViolations',bad_return_qty,'refundViolations',bad_refunds,'paymentDirectionViolations',bad_payment_direction);
end
$invariants$;

revoke all on function get_party_ledger(uuid,date,date),get_day_book(uuid,date,date),get_gst_summary(uuid,date,date),
 get_shop_day_reconciliation(uuid,date),check_invariants() from public,anon;
grant execute on function get_party_ledger(uuid,date,date),get_day_book(uuid,date,date),get_gst_summary(uuid,date,date),
 get_shop_day_reconciliation(uuid,date),check_invariants() to authenticated;
