-- Phase 6 — ledgers, reports, expenses, stock counts, export/health primitives.
-- Financial/reporting data is derived from immutable source documents. New financial rows are append-only.

insert into permissions(code,description) values
 ('VIEW_REPORTS','View ledgers and financial reports'),
 ('POST_EXPENSES','Post and void expenses'),
 ('COUNT_STOCK','Create and post stock counts'),
 ('EXPORT_DATA','Export tenant data')
on conflict(code) do nothing;

insert into role_permissions(role,code) values
 ('owner','VIEW_REPORTS'),('manager','VIEW_REPORTS'),('accountant','VIEW_REPORTS'),
 ('owner','POST_EXPENSES'),('manager','POST_EXPENSES'),('accountant','POST_EXPENSES'),
 ('owner','COUNT_STOCK'),('manager','COUNT_STOCK'),
 ('owner','EXPORT_DATA'),('manager','EXPORT_DATA'),('accountant','EXPORT_DATA')
on conflict do nothing;

create table expenses(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 shop_id uuid not null,
 business_date date not null,
 category text not null check(btrim(category)<>''),
 description text not null check(btrim(description)<>''),
 amount_paise bigint not null check(amount_paise>0),
 mode text not null check(mode in ('cash','upi','card','bank','other')),
 reference text,
 status text not null default 'POSTED' check(status in ('POSTED','VOID')),
 voided_at timestamptz,
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at bigint not null default 0,
 deleted_at bigint,
 client_id text not null,
 unique(tenant_id,client_id),
 unique(tenant_id,id),
 foreign key(tenant_id,shop_id) references shops(tenant_id,id)
);

create table stock_counts(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 shop_id uuid not null,
 business_date date not null,
 status text not null default 'DRAFT' check(status in ('DRAFT','POSTED','VOID')),
 notes text,
 posted_at timestamptz,
 voided_at timestamptz,
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at bigint not null default 0,
 deleted_at bigint,
 client_id text not null,
 unique(tenant_id,client_id),
 unique(tenant_id,id),
 foreign key(tenant_id,shop_id) references shops(tenant_id,id)
);

create table stock_count_lines(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 shop_id uuid not null,
 stock_count_id uuid not null,
 item_id uuid not null,
 expected_qty numeric(18,6) not null,
 counted_qty numeric(18,6) not null check(counted_qty>=0),
 variance_qty numeric(18,6) generated always as (counted_qty-expected_qty) stored,
 reason text,
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at bigint not null default 0,
 deleted_at bigint,
 client_id text not null,
 unique(stock_count_id,item_id),
 unique(tenant_id,client_id),
 foreign key(tenant_id,stock_count_id) references stock_counts(tenant_id,id),
 foreign key(tenant_id,shop_id) references shops(tenant_id,id),
 foreign key(tenant_id,item_id) references items(tenant_id,id)
);

create index expenses_date_idx on expenses(tenant_id,shop_id,business_date desc);
create index stock_counts_date_idx on stock_counts(tenant_id,shop_id,business_date desc);
create index stock_count_lines_count_idx on stock_count_lines(tenant_id,stock_count_id);

create trigger expenses_set_updated_at before insert or update on expenses for each row execute function set_updated_at();
create trigger stock_counts_set_updated_at before insert or update on stock_counts for each row execute function set_updated_at();
create trigger stock_count_lines_set_updated_at before insert or update on stock_count_lines for each row execute function set_updated_at();
create trigger audit_expenses after insert or update on expenses for each row execute function audit_row_change();
create trigger audit_stock_counts after insert or update on stock_counts for each row execute function audit_row_change();
create trigger audit_stock_count_lines after insert on stock_count_lines for each row execute function audit_row_change();

alter table expenses enable row level security;
alter table stock_counts enable row level security;
alter table stock_count_lines enable row level security;
grant select on expenses,stock_counts,stock_count_lines to authenticated;
create policy expenses_read on expenses for select using(tenant_id=current_tenant_id());
create policy stock_counts_read on stock_counts for select using(tenant_id=current_tenant_id());
create policy stock_count_lines_read on stock_count_lines for select using(tenant_id=current_tenant_id());

create function phase6_expense_guard() returns trigger language plpgsql as $$
begin
 if old.status='POSTED' and new.status='VOID'
    and new.tenant_id=old.tenant_id and new.shop_id=old.shop_id
    and new.business_date=old.business_date and new.category=old.category
    and new.description=old.description and new.amount_paise=old.amount_paise
    and new.mode=old.mode and new.reference is not distinct from old.reference
    and new.voided_at is not null then return new; end if;
 raise exception 'expense is immutable; use void_expense';
end $$;
create trigger expense_guard before update on expenses for each row execute function phase6_expense_guard();
create trigger expense_delete_immutable before delete on expenses for each row execute function phase4_financial_line_immutable();

create function post_expense(p_shop_id uuid,p_business_date date,p_category text,p_description text,p_amount_paise bigint,p_mode text,p_reference text,p_client_id text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_existing uuid; v_id uuid;
begin
 if not has_perm('POST_EXPENSES') then raise exception 'not permitted'; end if;
 v_tenant:=phase3_assert_shop(p_shop_id);
 if p_client_id is null or btrim(p_client_id)='' then raise exception 'client_id required'; end if;
 select id into v_existing from expenses where tenant_id=v_tenant and client_id=p_client_id;
 if v_existing is not null then return v_existing; end if;
 if p_amount_paise<=0 or p_mode not in ('cash','upi','card','bank','other') then raise exception 'invalid expense'; end if;
 insert into expenses(tenant_id,shop_id,business_date,category,description,amount_paise,mode,reference,client_id)
 values(v_tenant,p_shop_id,coalesce(p_business_date,current_date),btrim(p_category),btrim(p_description),p_amount_paise,p_mode,p_reference,p_client_id)
 returning id into v_id;
 return v_id;
end $$;

create function void_expense(p_expense_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id();
begin
 if not has_perm('POST_EXPENSES') then raise exception 'not permitted'; end if;
 update expenses set status='VOID',voided_at=clock_timestamp()
 where id=p_expense_id and tenant_id=v_tenant and status='POSTED';
 if not found then raise exception 'expense unavailable'; end if;
end $$;

create function create_stock_count(p_shop_id uuid,p_business_date date,p_lines jsonb,p_notes text,p_client_id text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_id uuid; v_existing uuid; v_line jsonb; v_item uuid; v_counted numeric; v_expected numeric;
begin
 if not has_perm('COUNT_STOCK') then raise exception 'not permitted'; end if;
 v_tenant:=phase3_assert_shop(p_shop_id);
 if p_client_id is null or btrim(p_client_id)='' then raise exception 'client_id required'; end if;
 select id into v_existing from stock_counts where tenant_id=v_tenant and client_id=p_client_id;
 if v_existing is not null then return v_existing; end if;
 if p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then raise exception 'stock count requires lines'; end if;
 insert into stock_counts(tenant_id,shop_id,business_date,notes,client_id)
 values(v_tenant,p_shop_id,coalesce(p_business_date,current_date),p_notes,p_client_id) returning id into v_id;
 for v_line in select value from jsonb_array_elements(p_lines) loop
   v_item:=(v_line->>'item_id')::uuid; v_counted:=(v_line->>'counted_qty')::numeric;
   if v_counted<0 or not exists(select 1 from items where tenant_id=v_tenant and id=v_item and deleted_at is null) then raise exception 'invalid stock count line'; end if;
   select coalesce(qty_base,0) into v_expected from stock_current where tenant_id=v_tenant and shop_id=p_shop_id and item_id=v_item;
   insert into stock_count_lines(tenant_id,shop_id,stock_count_id,item_id,expected_qty,counted_qty,reason,client_id)
   values(v_tenant,p_shop_id,v_id,v_item,coalesce(v_expected,0),v_counted,nullif(v_line->>'reason',''),p_client_id||':'||v_item::text);
 end loop;
 return v_id;
end $$;

create function post_stock_count(p_stock_count_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_count stock_counts%rowtype; v_line stock_count_lines%rowtype; v_now numeric;
begin
 if not has_perm('COUNT_STOCK') then raise exception 'not permitted'; end if;
 select * into v_count from stock_counts where id=p_stock_count_id and tenant_id=v_tenant for update;
 if not found or v_count.status<>'DRAFT' then raise exception 'stock count unavailable'; end if;
 for v_line in select * from stock_count_lines where stock_count_id=v_count.id order by item_id loop
   select coalesce(qty_base,0) into v_now from stock_current where tenant_id=v_tenant and shop_id=v_count.shop_id and item_id=v_line.item_id;
   if coalesce(v_now,0)<>v_line.expected_qty then raise exception 'stock changed since count was captured; recount required'; end if;
   if v_line.variance_qty<>0 then
     insert into stock_movements(tenant_id,shop_id,item_id,source_type,source_id,qty_base,client_id)
     values(v_tenant,v_count.shop_id,v_line.item_id,'ADJUSTMENT',v_count.id,v_line.variance_qty,'stock-count:'||v_line.id::text);
   end if;
 end loop;
 update stock_counts set status='POSTED',posted_at=clock_timestamp() where id=v_count.id;
end $$;

create function get_party_ledger(p_party_id uuid,p_from date default null,p_to date default null)
returns table(business_date date,entry_type text,document text,debit_paise bigint,credit_paise bigint,running_balance_paise bigint)
language sql stable security definer set search_path=public as $$
 with x as (
  select pb.business_date,'PURCHASE'::text,coalesce(pb.bill_no,pb.id::text),pb.total_paise::bigint,0::bigint,pb.created_at
  from purchase_bills pb where pb.tenant_id=current_tenant_id() and pb.party_id=p_party_id and pb.status='POSTED'
    and (p_from is null or pb.business_date>=p_from) and (p_to is null or pb.business_date<=p_to)
  union all
  select p.business_date,'PAYMENT'::text,coalesce(p.reference,p.id::text),0::bigint,p.amount_paise::bigint,p.created_at
  from payments p where p.tenant_id=current_tenant_id() and p.party_id=p_party_id and p.status='POSTED'
    and (p_from is null or p.business_date>=p_from) and (p_to is null or p.business_date<=p_to)
 )
 select business_date,entry_type,document,debit_paise,credit_paise,
 sum(debit_paise-credit_paise) over(order by business_date,created_at,document) from x order by business_date,created_at,document
$$;

create function get_day_book(p_shop_id uuid,p_from date,p_to date)
returns table(business_date date,sales_paise bigint,purchases_paise bigint,receipts_paise bigint,payments_paise bigint,expenses_paise bigint,net_cashflow_paise bigint)
language sql stable security definer set search_path=public as $$
 with d as (select generate_series(p_from,p_to,'1 day'::interval)::date business_date)
 select d.business_date,
  coalesce((select sum(total_paise) from sale_invoices s where s.tenant_id=current_tenant_id() and s.shop_id=p_shop_id and s.status='FINALIZED' and s.business_date=d.business_date),0)::bigint,
  coalesce((select sum(total_paise) from purchase_bills b where b.tenant_id=current_tenant_id() and b.shop_id=p_shop_id and b.status='POSTED' and b.business_date=d.business_date),0)::bigint,
  coalesce((select sum(amount_paise) from payments p where p.tenant_id=current_tenant_id() and p.shop_id=p_shop_id and p.kind='customer' and p.status='POSTED' and p.business_date=d.business_date),0)::bigint,
  coalesce((select sum(amount_paise) from payments p where p.tenant_id=current_tenant_id() and p.shop_id=p_shop_id and p.kind='party' and p.status='POSTED' and p.business_date=d.business_date),0)::bigint,
  coalesce((select sum(amount_paise) from expenses e where e.tenant_id=current_tenant_id() and e.shop_id=p_shop_id and e.status='POSTED' and e.business_date=d.business_date),0)::bigint,
  (
   coalesce((select sum(amount_paise) from payments p where p.tenant_id=current_tenant_id() and p.shop_id=p_shop_id and p.kind='customer' and p.status='POSTED' and p.business_date=d.business_date),0)
   -coalesce((select sum(amount_paise) from payments p where p.tenant_id=current_tenant_id() and p.shop_id=p_shop_id and p.kind='party' and p.status='POSTED' and p.business_date=d.business_date),0)
   -coalesce((select sum(amount_paise) from expenses e where e.tenant_id=current_tenant_id() and e.shop_id=p_shop_id and e.status='POSTED' and e.business_date=d.business_date),0)
  )::bigint
 from d order by d.business_date
$$;

create function get_stock_valuation(p_shop_id uuid)
returns table(item_id uuid,item_name text,qty_base numeric,cost_paise bigint,value_paise bigint)
language sql stable security definer set search_path=public as $$
 select i.id,i.name,coalesce(sc.qty_base,0),
  coalesce((select ip.price_paise from item_prices ip where ip.tenant_id=i.tenant_id and ip.item_id=i.id and ip.kind='cost_last' and ip.deleted_at is null order by ip.effective_from desc limit 1),0)::bigint,
  round(coalesce(sc.qty_base,0)*coalesce((select ip.price_paise from item_prices ip where ip.tenant_id=i.tenant_id and ip.item_id=i.id and ip.kind='cost_last' and ip.deleted_at is null order by ip.effective_from desc limit 1),0))::bigint
 from items i left join stock_current sc on sc.tenant_id=i.tenant_id and sc.shop_id=p_shop_id and sc.item_id=i.id
 where i.tenant_id=current_tenant_id() and i.deleted_at is null order by i.name
$$;

create function get_gst_summary(p_shop_id uuid,p_from date,p_to date)
returns table(tax_rate_bp integer,taxable_sales_paise bigint,gross_sales_paise bigint,taxable_purchases_paise bigint,gross_purchases_paise bigint)
language sql stable security definer set search_path=public as $$
 with s as (
  select sii.tax_rate_bp_snapshot rate,sum(sii.line_total_paise)::bigint gross
  from sale_invoice_items sii join sale_invoices si on si.tenant_id=sii.tenant_id and si.id=sii.sale_invoice_id
  where sii.tenant_id=current_tenant_id() and sii.shop_id=p_shop_id and si.status='FINALIZED' and si.business_date between p_from and p_to group by 1
 ), p as (
  select pbi.tax_rate_bp_snapshot rate,sum(pbi.line_total_paise)::bigint gross
  from purchase_bill_items pbi join purchase_bills pb on pb.tenant_id=pbi.tenant_id and pb.id=pbi.purchase_bill_id
  where pbi.tenant_id=current_tenant_id() and pbi.shop_id=p_shop_id and pb.status='POSTED' and pb.business_date between p_from and p_to group by 1
 ), rates as (select rate from s union select rate from p)
 select r.rate,
  round(coalesce(s.gross,0)*10000.0/(10000+r.rate))::bigint,coalesce(s.gross,0)::bigint,
  round(coalesce(p.gross,0)*10000.0/(10000+r.rate))::bigint,coalesce(p.gross,0)::bigint
 from rates r left join s using(rate) left join p using(rate) order by r.rate
$$;

create function phase6_export_tenant(p_shop_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid;
begin
 if not has_perm('EXPORT_DATA') then raise exception 'not permitted'; end if;
 v_tenant:=phase3_assert_shop(p_shop_id);
 return jsonb_build_object(
  'schemaVersion',2,'exportedAt',clock_timestamp(),'tenantId',v_tenant,'shopId',p_shop_id,
  'items',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from items where tenant_id=v_tenant) x),'[]'::jsonb),
  'parties',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from parties where tenant_id=v_tenant) x),'[]'::jsonb),
  'customers',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from customers where tenant_id=v_tenant) x),'[]'::jsonb),
  'purchases',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from purchase_bills where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'purchaseLines',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from purchase_bill_items where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'sales',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from sale_invoices where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'saleLines',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from sale_invoice_items where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'payments',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from payments where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'allocations',coalesce((select jsonb_agg(to_jsonb(x)) from (select pa.* from payment_allocations pa join payments p on p.tenant_id=pa.tenant_id and p.id=pa.payment_id where pa.tenant_id=v_tenant and p.shop_id=p_shop_id) x),'[]'::jsonb),
  'stockMovements',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from stock_movements where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'expenses',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from expenses where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'stockCounts',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from stock_counts where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'stockCountLines',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from stock_count_lines where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb)
 );
end $$;

create function check_invariants()
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); bad_sales bigint; bad_stock bigint; bad_alloc bigint;
begin
 select count(*) into bad_sales from sale_invoices s where s.tenant_id=v_tenant and s.status='FINALIZED'
 and s.total_paise<>(select coalesce(sum(line_total_paise),0) from sale_invoice_items li where li.sale_invoice_id=s.id)+s.extra_charges_paise;
 select count(*) into bad_stock from stock_current where tenant_id=v_tenant and qty_base<0;
 select count(*) into bad_alloc from payments p where p.tenant_id=v_tenant and
  (select coalesce(sum(amount_paise),0) from payment_allocations a where a.payment_id=p.id and a.status='POSTED')>p.amount_paise;
 return jsonb_build_object('ok',bad_sales=0 and bad_stock=0 and bad_alloc=0,'saleTotalViolations',bad_sales,'negativeStock',bad_stock,'allocationViolations',bad_alloc);
end $$;

revoke all on function post_expense(uuid,date,text,text,bigint,text,text,text) from public;
revoke all on function void_expense(uuid) from public;
revoke all on function create_stock_count(uuid,date,jsonb,text,text) from public;
revoke all on function post_stock_count(uuid) from public;
revoke all on function get_party_ledger(uuid,date,date) from public;
revoke all on function get_day_book(uuid,date,date) from public;
revoke all on function get_stock_valuation(uuid) from public;
revoke all on function get_gst_summary(uuid,date,date) from public;
revoke all on function phase6_export_tenant(uuid) from public;
revoke all on function check_invariants() from public;
grant execute on function post_expense(uuid,date,text,text,bigint,text,text,text),void_expense(uuid),create_stock_count(uuid,date,jsonb,text,text),post_stock_count(uuid),get_party_ledger(uuid,date,date),get_day_book(uuid,date,date),get_stock_valuation(uuid),get_gst_summary(uuid,date,date),phase6_export_tenant(uuid),check_invariants() to authenticated;

do $$
begin
 if exists(select 1 from pg_roles where rolname='backup_ro') then
   grant select on expenses,stock_counts,stock_count_lines to backup_ro;
 end if;
end $$;
