-- Phase 4 transactional core: sales, split tenders, customer payments and ledgers.
-- Prices are server-resolved from item_prices; GST rates are snapshotted for print only.

create table sale_invoices(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id), shop_id uuid not null references shops(id),
 customer_id uuid references customers(id),
 doc_no text not null, doc_seq bigint not null check(doc_seq>0), business_date date not null,
 status text not null default 'FINALIZED' check(status in ('DRAFT','FINALIZED','VOID')),
 subtotal_paise bigint not null check(subtotal_paise>=0),
 discount_paise bigint not null default 0 check(discount_paise>=0),
 extra_charges_paise bigint not null default 0 check(extra_charges_paise>=0),
 total_paise bigint not null check(total_paise>=0),
 notes text, finalized_at timestamptz, voided_at timestamptz,
 created_by uuid not null default auth.uid(), created_at timestamptz not null default now(),
 updated_at bigint not null default 0, deleted_at bigint, client_id text not null,
 unique(tenant_id,client_id), unique(tenant_id,shop_id,doc_no), unique(tenant_id,id),
 foreign key(tenant_id,shop_id) references shops(tenant_id,id),
 foreign key(tenant_id,customer_id) references customers(tenant_id,id)
);

create table sale_invoice_items(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id), shop_id uuid not null references shops(id),
 sale_invoice_id uuid not null, item_id uuid not null,
 line_no integer not null check(line_no>0),
 item_name_snapshot text not null, hsn_snapshot text, tax_rate_bp_snapshot integer not null,
 unit_name_snapshot text not null, conv1_snapshot numeric(18,6), conv2_snapshot numeric(18,6),
 unit_level smallint not null check(unit_level between 1 and 3),
 entry_mode text not null check(entry_mode in ('big','small','piece')),
 is_big_unit boolean not null,
 qty numeric(18,6) not null check(qty>0), base_qty numeric(18,6) not null check(base_qty>0),
 price_kind text not null check(price_kind in ('retail','wholesale')),
 unit_price_paise bigint not null check(unit_price_paise>=0),
 discount_paise bigint not null default 0 check(discount_paise>=0),
 line_total_paise bigint not null check(line_total_paise>=0),
 created_by uuid not null default auth.uid(), created_at timestamptz not null default now(),
 updated_at bigint not null default 0, deleted_at bigint, client_id text not null,
 unique(sale_invoice_id,line_no), unique(tenant_id,client_id), unique(tenant_id,id),
 foreign key(tenant_id,sale_invoice_id) references sale_invoices(tenant_id,id),
 foreign key(tenant_id,shop_id) references shops(tenant_id,id),
 foreign key(tenant_id,item_id) references items(tenant_id,id)
);

create table payments(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id), shop_id uuid not null references shops(id),
 kind text not null check(kind in ('customer','party')),
 customer_id uuid, party_id uuid,
 source_sale_invoice_id uuid,
 business_date date not null,
 amount_paise bigint not null check(amount_paise>0),
 mode text not null check(mode in ('cash','upi','card','bank','other')),
 reference text, status text not null default 'POSTED' check(status in ('POSTED','VOID')),
 voided_at timestamptz,
 created_by uuid not null default auth.uid(), created_at timestamptz not null default now(),
 updated_at bigint not null default 0, deleted_at bigint, client_id text not null,
 check((kind='customer' and customer_id is not null and party_id is null) or (kind='party' and party_id is not null and customer_id is null)),
 unique(tenant_id,client_id), unique(tenant_id,id),
 foreign key(tenant_id,shop_id) references shops(tenant_id,id),
 foreign key(tenant_id,customer_id) references customers(tenant_id,id),
 foreign key(tenant_id,party_id) references parties(tenant_id,id),
 foreign key(tenant_id,source_sale_invoice_id) references sale_invoices(tenant_id,id)
);

create table payment_allocations(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id), payment_id uuid not null,
 doc_type text not null check(doc_type in ('SALE','PURCHASE')),
 sale_invoice_id uuid, purchase_bill_id uuid,
 doc_id uuid generated always as (coalesce(sale_invoice_id,purchase_bill_id)) stored,
 amount_paise bigint not null check(amount_paise>0),
 status text not null default 'POSTED' check(status in ('POSTED','VOID')),
 created_by uuid not null default auth.uid(), created_at timestamptz not null default now(),
 updated_at bigint not null default 0, deleted_at bigint, client_id text not null,
 check((doc_type='SALE' and sale_invoice_id is not null and purchase_bill_id is null) or
       (doc_type='PURCHASE' and purchase_bill_id is not null and sale_invoice_id is null)),
 unique(tenant_id,client_id),
 foreign key(tenant_id,payment_id) references payments(tenant_id,id),
 foreign key(tenant_id,sale_invoice_id) references sale_invoices(tenant_id,id),
 foreign key(tenant_id,purchase_bill_id) references purchase_bills(tenant_id,id)
);

create index sale_invoices_date_idx on sale_invoices(tenant_id,shop_id,business_date desc,doc_seq desc);
create index sale_invoice_items_invoice_idx on sale_invoice_items(tenant_id,sale_invoice_id);
create index payments_customer_idx on payments(tenant_id,customer_id,business_date desc);
create index payment_allocations_payment_idx on payment_allocations(tenant_id,payment_id);
create index payment_allocations_sale_idx on payment_allocations(tenant_id,sale_invoice_id) where sale_invoice_id is not null;

create trigger sale_invoices_set_updated_at before insert or update on sale_invoices for each row execute function set_updated_at();
create trigger sale_invoice_items_set_updated_at before insert or update on sale_invoice_items for each row execute function set_updated_at();
create trigger payments_set_updated_at before insert or update on payments for each row execute function set_updated_at();
create trigger payment_allocations_set_updated_at before insert or update on payment_allocations for each row execute function set_updated_at();
create trigger audit_sale_invoices after insert or update on sale_invoices for each row execute function audit_row_change();
create trigger audit_sale_invoice_items after insert on sale_invoice_items for each row execute function audit_row_change();
create trigger audit_payments after insert or update on payments for each row execute function audit_row_change();
create trigger audit_payment_allocations after insert or update on payment_allocations for each row execute function audit_row_change();

alter table sale_invoices enable row level security;
alter table sale_invoice_items enable row level security;
alter table payments enable row level security;
alter table payment_allocations enable row level security;
grant select on sale_invoices,sale_invoice_items,payments,payment_allocations to authenticated;
create policy sale_invoices_read on sale_invoices for select using(tenant_id=current_tenant_id());
create policy sale_invoice_items_read on sale_invoice_items for select using(tenant_id=current_tenant_id());
create policy payments_read on payments for select using(tenant_id=current_tenant_id());
create policy payment_allocations_read on payment_allocations for select using(tenant_id=current_tenant_id());

create function phase4_financial_line_immutable() returns trigger language plpgsql as $$
begin raise exception 'financial rows are immutable; use reversal RPC'; end $$;
create trigger sale_items_immutable before update or delete on sale_invoice_items for each row execute function phase4_financial_line_immutable();
create trigger allocations_delete_immutable before delete on payment_allocations for each row execute function phase4_financial_line_immutable();

create function phase4_sale_guard() returns trigger language plpgsql as $$
begin
 if old.status='FINALIZED' and new.status='VOID'
    and new.tenant_id=old.tenant_id and new.shop_id=old.shop_id
    and new.customer_id is not distinct from old.customer_id
    and new.doc_no=old.doc_no and new.doc_seq=old.doc_seq and new.business_date=old.business_date
    and new.subtotal_paise=old.subtotal_paise and new.discount_paise=old.discount_paise
    and new.extra_charges_paise=old.extra_charges_paise and new.total_paise=old.total_paise
    and new.notes is not distinct from old.notes and new.voided_at is not null then return new;
 end if;
 if old.status='DRAFT' and new.status='FINALIZED' then return new; end if;
 raise exception 'finalized invoice is immutable; use void_sale';
end $$;
create trigger sale_invoice_guard before update on sale_invoices for each row execute function phase4_sale_guard();

create function phase4_payment_guard() returns trigger language plpgsql as $$
begin
 if old.status='POSTED' and new.status='VOID'
    and new.tenant_id=old.tenant_id and new.shop_id=old.shop_id and new.kind=old.kind
    and new.customer_id is not distinct from old.customer_id and new.party_id is not distinct from old.party_id
    and new.source_sale_invoice_id is not distinct from old.source_sale_invoice_id
    and new.business_date=old.business_date and new.amount_paise=old.amount_paise and new.mode=old.mode
    and new.reference is not distinct from old.reference and new.voided_at is not null then return new;
 end if;
 raise exception 'payment is immutable; use void_payment';
end $$;
create trigger payment_guard before update on payments for each row execute function phase4_payment_guard();

create function phase4_allocation_guard() returns trigger language plpgsql as $$
begin
 if old.status='POSTED' and new.status='VOID'
    and new.tenant_id=old.tenant_id and new.payment_id=old.payment_id and new.doc_type=old.doc_type
    and new.sale_invoice_id is not distinct from old.sale_invoice_id
    and new.purchase_bill_id is not distinct from old.purchase_bill_id
    and new.amount_paise=old.amount_paise then return new;
 end if;
 raise exception 'payment allocation is immutable';
end $$;
create trigger allocation_guard before update on payment_allocations for each row execute function phase4_allocation_guard();

create function phase4_validate_allocation() returns trigger language plpgsql security definer set search_path=public as $$
declare v_payment payments%rowtype; v_customer uuid; v_party uuid;
begin
 select * into v_payment from payments where id=new.payment_id and tenant_id=new.tenant_id;
 if not found or v_payment.status<>'POSTED' then raise exception 'payment unavailable'; end if;
 if new.doc_type='SALE' then
   select customer_id into v_customer from sale_invoices where id=new.sale_invoice_id and tenant_id=new.tenant_id and status='FINALIZED';
   if v_payment.kind<>'customer' or v_customer is distinct from v_payment.customer_id then raise exception 'payment and sale customer mismatch'; end if;
 else
   select party_id into v_party from purchase_bills where id=new.purchase_bill_id and tenant_id=new.tenant_id and status='POSTED';
   if v_payment.kind<>'party' or v_party is distinct from v_payment.party_id then raise exception 'payment and purchase party mismatch'; end if;
 end if;
 return new;
end $$;
create trigger allocation_validate before insert on payment_allocations for each row execute function phase4_validate_allocation();

create function phase4_check_payment_sum() returns trigger language plpgsql security definer set search_path=public as $$
declare v_payment uuid:=coalesce(new.payment_id,old.payment_id); v_amount bigint; v_sum bigint;
begin
 select amount_paise into v_amount from payments where id=v_payment;
 select coalesce(sum(amount_paise),0) into v_sum from payment_allocations where payment_id=v_payment and status='POSTED';
 if v_sum>v_amount then raise exception 'payment allocations exceed payment amount'; end if;
 return coalesce(new,old);
end $$;
create constraint trigger payment_allocation_sum after insert or update or delete on payment_allocations
 deferrable initially deferred for each row execute function phase4_check_payment_sum();

create function phase4_current_price(p_tenant uuid,p_shop uuid,p_item uuid,p_kind text,p_level int) returns bigint
language plpgsql stable security definer set search_path=public as $$
declare v_price bigint;
begin
 select price_paise into v_price from item_prices
 where tenant_id=p_tenant and item_id=p_item and kind=p_kind and unit_level=p_level and deleted_at is null
   and effective_from<=clock_timestamp() and (effective_to is null or effective_to>clock_timestamp())
   and (shop_id=p_shop or shop_id is null)
 order by (shop_id is not null) desc,effective_from desc limit 1;
 if v_price is null then raise exception 'sale price unavailable'; end if;
 return v_price;
end $$;
revoke all on function phase4_current_price(uuid,uuid,uuid,text,int) from public;

create function post_sale(
 p_shop_id uuid,p_customer_id uuid,p_business_date date,p_discount_paise bigint,p_extra_charges_paise bigint,
 p_client_id text,p_lines jsonb,p_payments jsonb default '[]'::jsonb,p_notes text default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare
 v_tenant uuid; v_existing uuid; v_sale uuid; v_seq bigint; v_prefix text; v_doc text;
 v_line jsonb; v_pay jsonb; v_ord bigint; v_item items%rowtype;
 v_level int; v_qty numeric; v_base numeric; v_kind text; v_price bigint; v_gross bigint; v_line_discount bigint; v_line_total bigint;
 v_subtotal bigint:=0; v_line_discounts bigint:=0; v_total_discount bigint; v_total bigint; v_payment_total bigint:=0;
 v_item_ids uuid[]:='{}'; v_required numeric[]:='{}'; v_pos int; v_i int; v_payment_id uuid; v_amount bigint; v_mode text;
begin
 if not has_perm('POST_SALES') then raise exception 'not permitted'; end if;
 v_tenant:=phase3_assert_shop(p_shop_id);
 if p_client_id is null or btrim(p_client_id)='' then raise exception 'client_id required'; end if;
 select id into v_existing from sale_invoices where tenant_id=v_tenant and client_id=p_client_id;
 if v_existing is not null then return v_existing; end if;
 if p_customer_id is not null and not exists(select 1 from customers where id=p_customer_id and tenant_id=v_tenant and deleted_at is null) then raise exception 'customer not in tenant'; end if;
 if coalesce(p_discount_paise,0)<0 or coalesce(p_extra_charges_paise,0)<0 then raise exception 'negative adjustment'; end if;
 if p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then raise exception 'sale requires lines'; end if;
 if p_payments is null or jsonb_typeof(p_payments)<>'array' then raise exception 'payments must be an array'; end if;

 for v_line,v_ord in select value,ordinality from jsonb_array_elements(p_lines) with ordinality loop
   select * into v_item from items where id=(v_line->>'item_id')::uuid and tenant_id=v_tenant and deleted_at is null and is_active for share;
   if not found then raise exception 'item not in tenant'; end if;
   v_level:=coalesce((v_line->>'unit_level')::int,1); v_qty:=(v_line->>'qty')::numeric;
   v_kind:=coalesce(nullif(v_line->>'price_kind',''),'retail');
   if v_qty<=0 or v_level not between 1 and 3 or v_kind not in ('retail','wholesale') then raise exception 'invalid sale line'; end if;
   if v_level=1 then v_base:=v_qty*coalesce(v_item.conv1,1)*coalesce(v_item.conv2,1);
   elsif v_level=2 and v_item.unit2 is not null then v_base:=v_qty*coalesce(v_item.conv2,1);
   elsif v_level=3 and v_item.unit3 is not null then v_base:=v_qty;
   else raise exception 'unit tier unavailable'; end if;
   v_price:=phase4_current_price(v_tenant,p_shop_id,v_item.id,v_kind,v_level);
   v_gross:=round(v_qty*v_price)::bigint;
   v_line_discount:=coalesce((v_line->>'discount_paise')::bigint,0);
   if v_line_discount<0 or v_line_discount>v_gross then raise exception 'invalid line discount'; end if;
   v_subtotal:=v_subtotal+v_gross; v_line_discounts:=v_line_discounts+v_line_discount;
   v_pos:=array_position(v_item_ids,v_item.id);
   if v_pos is null then v_item_ids:=array_append(v_item_ids,v_item.id); v_required:=array_append(v_required,v_base);
   else v_required[v_pos]:=v_required[v_pos]+v_base; end if;
 end loop;
 v_total_discount:=v_line_discounts+coalesce(p_discount_paise,0);
 if v_total_discount>v_subtotal then raise exception 'discount exceeds subtotal'; end if;
 v_total:=v_subtotal-v_total_discount+coalesce(p_extra_charges_paise,0);

 for v_pay in select value from jsonb_array_elements(p_payments) loop
   v_amount:=(v_pay->>'amount_paise')::bigint; v_mode:=v_pay->>'mode';
   if v_amount<=0 or v_mode not in ('cash','upi','card','bank','other') then raise exception 'invalid payment'; end if;
   v_payment_total:=v_payment_total+v_amount;
 end loop;
 if v_payment_total>v_total then raise exception 'payments exceed sale total'; end if;
 if p_customer_id is null and v_payment_total<>v_total then raise exception 'walk-in sale must be fully paid'; end if;

 -- Ensure every projection row exists, then lock all items in deterministic order.
 for v_i in 1..coalesce(array_length(v_item_ids,1),0) loop
   insert into stock_current(tenant_id,shop_id,item_id,on_hand,reserved)
   values(v_tenant,p_shop_id,v_item_ids[v_i],0,0) on conflict do nothing;
 end loop;
 perform 1 from stock_current where tenant_id=v_tenant and shop_id=p_shop_id and item_id=any(v_item_ids) order by item_id for update;
 for v_i in 1..coalesce(array_length(v_item_ids,1),0) loop
   if not exists(select 1 from stock_current where tenant_id=v_tenant and shop_id=p_shop_id and item_id=v_item_ids[v_i] and available>=v_required[v_i]) then
     raise exception 'insufficient stock';
   end if;
 end loop;

 v_seq:=next_doc_no(p_shop_id,'SALE');
 select coalesce(nullif(invoice_prefix,''),'INV') into v_prefix from shops where id=p_shop_id and tenant_id=v_tenant;
 v_doc:=v_prefix||'-'||lpad(v_seq::text,6,'0');
 insert into sale_invoices(tenant_id,shop_id,customer_id,doc_no,doc_seq,business_date,status,subtotal_paise,discount_paise,extra_charges_paise,total_paise,notes,finalized_at,client_id)
 values(v_tenant,p_shop_id,p_customer_id,v_doc,v_seq,coalesce(p_business_date,shop_business_date(p_shop_id)),'FINALIZED',v_subtotal,v_total_discount,coalesce(p_extra_charges_paise,0),v_total,p_notes,now(),p_client_id)
 returning id into v_sale;

 for v_line,v_ord in select value,ordinality from jsonb_array_elements(p_lines) with ordinality loop
   select * into v_item from items where id=(v_line->>'item_id')::uuid and tenant_id=v_tenant;
   v_level:=coalesce((v_line->>'unit_level')::int,1); v_qty:=(v_line->>'qty')::numeric; v_kind:=coalesce(nullif(v_line->>'price_kind',''),'retail');
   if v_level=1 then v_base:=v_qty*coalesce(v_item.conv1,1)*coalesce(v_item.conv2,1);
   elsif v_level=2 then v_base:=v_qty*coalesce(v_item.conv2,1); else v_base:=v_qty; end if;
   v_price:=phase4_current_price(v_tenant,p_shop_id,v_item.id,v_kind,v_level); v_gross:=round(v_qty*v_price)::bigint;
   v_line_discount:=coalesce((v_line->>'discount_paise')::bigint,0); v_line_total:=v_gross-v_line_discount;
   insert into sale_invoice_items(tenant_id,shop_id,sale_invoice_id,item_id,line_no,item_name_snapshot,hsn_snapshot,tax_rate_bp_snapshot,unit_name_snapshot,conv1_snapshot,conv2_snapshot,unit_level,entry_mode,is_big_unit,qty,base_qty,price_kind,unit_price_paise,discount_paise,line_total_paise,client_id)
   values(v_tenant,p_shop_id,v_sale,v_item.id,v_ord,v_item.name,v_item.hsn,v_item.tax_rate_bp,
      case v_level when 1 then v_item.unit1 when 2 then v_item.unit2 else v_item.unit3 end,v_item.conv1,v_item.conv2,v_level,
      case v_level when 1 then 'big' when 2 then 'small' else 'piece' end,v_level=1,v_qty,v_base,v_kind,v_price,v_line_discount,v_line_total,p_client_id||':line:'||v_ord::text);
   insert into stock_movements(tenant_id,shop_id,item_id,source_type,source_id,qty_base,client_id)
   values(v_tenant,p_shop_id,v_item.id,'SALE',v_sale,-v_base,p_client_id||':stock:'||v_ord::text);
 end loop;

 for v_pay,v_ord in select value,ordinality from jsonb_array_elements(p_payments) with ordinality loop
   v_amount:=(v_pay->>'amount_paise')::bigint; v_mode:=v_pay->>'mode';
   if p_customer_id is null then
     -- Use no customer ledger row for walk-in tenders; the payment still belongs to the sale.
     insert into payments(tenant_id,shop_id,kind,customer_id,party_id,source_sale_invoice_id,business_date,amount_paise,mode,reference,status,client_id)
     values(v_tenant,p_shop_id,'customer',null,null,v_sale,coalesce(p_business_date,shop_business_date(p_shop_id)),v_amount,v_mode,v_pay->>'reference','POSTED',p_client_id||':pay:'||v_ord::text)
     returning id into v_payment_id;
   else
     insert into payments(tenant_id,shop_id,kind,customer_id,source_sale_invoice_id,business_date,amount_paise,mode,reference,status,client_id)
     values(v_tenant,p_shop_id,'customer',p_customer_id,v_sale,coalesce(p_business_date,shop_business_date(p_shop_id)),v_amount,v_mode,v_pay->>'reference','POSTED',p_client_id||':pay:'||v_ord::text)
     returning id into v_payment_id;
     insert into payment_allocations(tenant_id,payment_id,doc_type,sale_invoice_id,amount_paise,client_id)
     values(v_tenant,v_payment_id,'SALE',v_sale,v_amount,p_client_id||':alloc:'||v_ord::text);
   end if;
 end loop;
 return v_sale;
exception when unique_violation then
 select id into v_existing from sale_invoices where tenant_id=v_tenant and client_id=p_client_id;
 if v_existing is not null then return v_existing; end if;
 raise;
end $$;

-- Walk-in payments cannot satisfy the payments.kind/customer check with a NULL customer.
-- Instead of weakening customer/party identity, use a dedicated walk-in kind.
alter table payments drop constraint payments_check;
alter table payments drop constraint payments_kind_check;
alter table payments add constraint payments_kind_check check(kind in ('customer','party','walkin'));
alter table payments add constraint payments_identity_check check(
 (kind='customer' and customer_id is not null and party_id is null) or
 (kind='party' and party_id is not null and customer_id is null) or
 (kind='walkin' and customer_id is null and party_id is null)
);

-- Replace post_sale now that walk-in is an explicit payment identity.
create or replace function phase4_payment_kind_for_sale(p_customer_id uuid) returns text language sql immutable as $$
 select case when p_customer_id is null then 'walkin' else 'customer' end
$$;

-- The function body above inserts walk-in as customer; correct those inserts at execution
-- via a small BEFORE INSERT guard that canonicalizes sale-sourced anonymous tenders.
create function phase4_payment_identity() returns trigger language plpgsql as $$
begin
 if new.source_sale_invoice_id is not null and new.customer_id is null and new.party_id is null then new.kind:='walkin'; end if;
 return new;
end $$;
create trigger payment_identity before insert on payments for each row execute function phase4_payment_identity();

create function record_customer_payment(
 p_shop_id uuid,p_customer_id uuid,p_business_date date,p_amount_paise bigint,p_mode text,p_reference text,p_allocations jsonb,p_client_id text
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_existing uuid; v_payment uuid; v_alloc jsonb; v_ord bigint; v_invoice sale_invoices%rowtype; v_amount bigint; v_sum bigint:=0;
begin
 if not has_perm('POST_SALES') then raise exception 'not permitted'; end if;
 v_tenant:=phase3_assert_shop(p_shop_id);
 if p_client_id is null or btrim(p_client_id)='' then raise exception 'client_id required'; end if;
 select id into v_existing from payments where tenant_id=v_tenant and client_id=p_client_id;
 if v_existing is not null then return v_existing; end if;
 if p_amount_paise<=0 or p_mode not in ('cash','upi','card','bank','other') then raise exception 'invalid payment'; end if;
 if not exists(select 1 from customers where id=p_customer_id and tenant_id=v_tenant and deleted_at is null) then raise exception 'customer not in tenant'; end if;
 if p_allocations is null or jsonb_typeof(p_allocations)<>'array' then raise exception 'allocations must be an array'; end if;
 for v_alloc in select value from jsonb_array_elements(p_allocations) loop
   v_amount:=(v_alloc->>'amount_paise')::bigint;
   select * into v_invoice from sale_invoices where id=(v_alloc->>'sale_invoice_id')::uuid and tenant_id=v_tenant and customer_id=p_customer_id and status='FINALIZED';
   if not found or v_amount<=0 then raise exception 'invalid sale allocation'; end if;
   if v_amount > v_invoice.total_paise-coalesce((select sum(pa.amount_paise) from payment_allocations pa join payments p on p.id=pa.payment_id where pa.sale_invoice_id=v_invoice.id and pa.status='POSTED' and p.status='POSTED'),0) then raise exception 'allocation exceeds invoice balance'; end if;
   v_sum:=v_sum+v_amount;
 end loop;
 if v_sum>p_amount_paise then raise exception 'allocations exceed payment amount'; end if;
 insert into payments(tenant_id,shop_id,kind,customer_id,business_date,amount_paise,mode,reference,status,client_id)
 values(v_tenant,p_shop_id,'customer',p_customer_id,coalesce(p_business_date,shop_business_date(p_shop_id)),p_amount_paise,p_mode,p_reference,'POSTED',p_client_id)
 returning id into v_payment;
 for v_alloc,v_ord in select value,ordinality from jsonb_array_elements(p_allocations) with ordinality loop
   insert into payment_allocations(tenant_id,payment_id,doc_type,sale_invoice_id,amount_paise,client_id)
   values(v_tenant,v_payment,'SALE',(v_alloc->>'sale_invoice_id')::uuid,(v_alloc->>'amount_paise')::bigint,p_client_id||':alloc:'||v_ord::text);
 end loop;
 return v_payment;
exception when unique_violation then
 select id into v_existing from payments where tenant_id=v_tenant and client_id=p_client_id;
 if v_existing is not null then return v_existing; end if;
 raise;
end $$;

create function void_sale(p_sale_id uuid,p_client_id text) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_sale sale_invoices%rowtype; v_line sale_invoice_items%rowtype;
begin
 if not has_perm('VOID_SALES') then raise exception 'not permitted'; end if;
 if p_client_id is null or btrim(p_client_id)='' then raise exception 'client_id required'; end if;
 select * into v_sale from sale_invoices where id=p_sale_id and tenant_id=v_tenant for update;
 if not found then raise exception 'sale not found'; end if;
 if v_sale.status='VOID' then return v_sale.id; end if;
 perform phase3_assert_shop(v_sale.shop_id);
 for v_line in select * from sale_invoice_items where sale_invoice_id=v_sale.id and deleted_at is null order by line_no loop
   insert into stock_movements(tenant_id,shop_id,item_id,source_type,source_id,qty_base,client_id)
   values(v_sale.tenant_id,v_sale.shop_id,v_line.item_id,'SALE_VOID',v_sale.id,v_line.base_qty,p_client_id||':stock:'||v_line.line_no::text);
 end loop;
 update payment_allocations set status='VOID' where sale_invoice_id=v_sale.id and status='POSTED';
 update payments set status='VOID',voided_at=now() where source_sale_invoice_id=v_sale.id and status='POSTED';
 update sale_invoices set status='VOID',voided_at=now() where id=v_sale.id;
 return v_sale.id;
end $$;

create function void_payment(p_payment_id uuid) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_payment payments%rowtype;
begin
 if not has_perm('VOID_SALES') then raise exception 'not permitted'; end if;
 select * into v_payment from payments where id=p_payment_id and tenant_id=v_tenant for update;
 if not found then raise exception 'payment not found'; end if;
 if v_payment.status='VOID' then return v_payment.id; end if;
 perform phase3_assert_shop(v_payment.shop_id);
 update payment_allocations set status='VOID' where payment_id=v_payment.id and status='POSTED';
 update payments set status='VOID',voided_at=now() where id=v_payment.id;
 return v_payment.id;
end $$;

create view customer_ledger with(security_invoker=true) as
 select tenant_id,customer_id,business_date,created_at,'SALE'::text entry_type,id ref_id,doc_no reference,total_paise debit_paise,0::bigint credit_paise
 from sale_invoices where customer_id is not null and status='FINALIZED' and deleted_at is null
 union all
 select tenant_id,customer_id,business_date,created_at,'PAYMENT'::text,id ref_id,coalesce(reference,mode) reference,0::bigint debit_paise,amount_paise credit_paise
 from payments where kind='customer' and customer_id is not null and status='POSTED' and deleted_at is null;
create view customer_balances with(security_invoker=true) as
 select tenant_id,customer_id,coalesce(sum(debit_paise-credit_paise),0)::bigint balance_paise
 from customer_ledger group by tenant_id,customer_id;
grant select on customer_ledger,customer_balances to authenticated;

revoke all on function post_sale(uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text) from public;
revoke all on function record_customer_payment(uuid,uuid,date,bigint,text,text,jsonb,text) from public;
revoke all on function void_sale(uuid,text) from public;
revoke all on function void_payment(uuid) from public;
grant execute on function post_sale(uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text) to authenticated;
grant execute on function record_customer_payment(uuid,uuid,date,bigint,text,text,jsonb,text) to authenticated;
grant execute on function void_sale(uuid,text) to authenticated;
grant execute on function void_payment(uuid) to authenticated;
