-- Packet C0 (SINGLE_BUILDER_PLAN v2.0 row 3 = COMPLETE_REMAINING_BUILD_PLAN v1.1 §6 C0a + §6a C0b):
-- financial request ledger, allocation dates, and the shop finance lock around every money writer.
--
-- Silent-corruption risks addressed here (CLAUDE.md: list them before code):
--  1. A money writer reachable without the shop lock. Every public writer below is renamed to a
--     private c0_*_body, revoked from clients, and replaced by a same-signature wrapper that takes
--     dsb_lock_shop_finance first. The call graph was enumerated from pg_proc: the sync wrappers
--     (phase5_sync_post_sale, phase65_sync_post_return, phase65_sync_void_return) call the public
--     entry points, never the bodies, so they are covered.
--  2. Lock-order inversion. phase5_sync_post_sale takes its own request advisory lock
--     ('phase5:post_sale:<client>') before post_sale reaches the shop lock. It is deliberately NOT
--     wrapped: that key is taken only by phase5_sync_post_sale itself, always as its first lock,
--     so no transaction can hold the shop lock and then wait on it -- no deadlock cycle exists.
--     Wrapping it would also move the Batch B intent-fingerprint body that the upgrade classifier
--     and live verification read from phase5_sync_post_sale.
--  3. Backfilled allocation dates are inference, not history: labelled LEGACY_INFERRED, and
--     shop_financial_history records the first date from which dates are EXPLICIT.
--  4. Allocations never checked that payment and document share a shop; the insert trigger now does.
--  5. Voiding a purchase that still has active allocations would strand money on a void bill; the
--     wrapper refuses it (v1.1 §6a.1).
-- Existing per-writer exact-retry behaviour is unchanged (v1.1 §6a.1); financial_requests has no
-- writer until C1/C3.

-- ---------------------------------------------------------------------------------------------
-- 1. Financial request ledger (v1.1 §6.1)
-- ---------------------------------------------------------------------------------------------
create table financial_requests(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 shop_id uuid not null,
 operation text not null check(operation in (
   'record_supplier_payment','allocate_supplier_payment','release_supplier_allocation',
   'void_supplier_payment','record_customer_payment_v2','allocate_customer_payment_v2')),
 request jsonb not null check(jsonb_typeof(request)='object'),
 result jsonb not null check(jsonb_typeof(result)='object'),
 request_version integer not null default 1 check(request_version>=1),
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at bigint not null default 0,
 deleted_at bigint,
 client_id text not null check(char_length(client_id) between 1 and 128),
 unique(tenant_id,operation,client_id),
 unique(tenant_id,id),
 foreign key(tenant_id,shop_id) references shops(tenant_id,id)
);
create function c0_financial_request_immutable() returns trigger language plpgsql as $$
begin
 raise exception 'financial request is immutable';
end $$;
create trigger financial_requests_set_updated_at before insert on financial_requests
 for each row execute function set_updated_at();
create trigger financial_requests_immutable before update or delete on financial_requests
 for each row execute function c0_financial_request_immutable();
create trigger audit_financial_requests after insert on financial_requests
 for each row execute function audit_row_change();
alter table financial_requests enable row level security;
revoke all on financial_requests from public,anon,authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. Private helpers (never granted to clients)
-- ---------------------------------------------------------------------------------------------
create function dsb_lock_shop_finance(p_tenant uuid,p_shop uuid) returns void
language plpgsql volatile set search_path=public as $$
begin
 if p_tenant is null or p_shop is null then raise exception 'shop finance lock requires tenant and shop'; end if;
 perform pg_advisory_xact_lock(hashtextextended('dsb:shop-finance:'||p_tenant::text||':'||p_shop::text,0));
end $$;

create function dsb_lock_request(p_tenant uuid,p_operation text,p_client_id text) returns void
language plpgsql volatile set search_path=public as $$
begin
 if p_tenant is null or p_operation is null or p_client_id is null then raise exception 'request lock requires tenant, operation and client_id'; end if;
 perform pg_advisory_xact_lock(hashtextextended('dsb:finance-request:'||p_tenant::text||':'||p_operation||':'||p_client_id,0));
end $$;

-- 9007199254740991 = Number.MAX_SAFE_INTEGER, the app's money boundary (v1.1 §3.3).
create function dsb_assert_safe_paise(p_value bigint,p_signed boolean default false) returns void
language plpgsql immutable set search_path=public as $$
begin
 if p_value is null then raise exception 'amount required'; end if;
 if abs(p_value)>9007199254740991 then raise exception 'amount out of safe range'; end if;
 if not coalesce(p_signed,false) and p_value<0 then raise exception 'amount must not be negative'; end if;
end $$;

-- Validates an allocation list and returns it canonical: sorted by target UUID, amounts as
-- decimal text, duplicates rejected, at most 200 entries.
create function dsb_normalize_allocations(p_allocations jsonb,p_target_field text) returns jsonb
language plpgsql immutable set search_path=public as $$
declare v_item jsonb; v_target text; v_amount_text text; v_amount numeric; v_out jsonb:='[]'::jsonb; v_seen text[]:='{}';
begin
 if p_target_field not in ('sale_invoice_id','purchase_bill_id') then raise exception 'unsupported allocation target'; end if;
 if p_allocations is null then return '[]'::jsonb; end if;
 if jsonb_typeof(p_allocations)<>'array' then raise exception 'allocations must be an array'; end if;
 if jsonb_array_length(p_allocations)>200 then raise exception 'too many allocations'; end if;
 for v_item in select value from jsonb_array_elements(p_allocations) loop
   if jsonb_typeof(v_item)<>'object' then raise exception 'allocation must be an object'; end if;
   if exists(select 1 from jsonb_object_keys(v_item) k where k not in (p_target_field,'amount_paise')) then
     raise exception 'unknown allocation field';
   end if;
   v_target:=lower(v_item->>p_target_field);
   if v_target is null or v_target !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
     raise exception 'allocation target must be a uuid';
   end if;
   if jsonb_typeof(v_item->'amount_paise') not in ('string','number') then raise exception 'allocation amount required'; end if;
   v_amount_text:=v_item->>'amount_paise';
   if v_amount_text !~ '^[0-9]{1,16}$' then raise exception 'allocation amount must be a positive integer'; end if;
   v_amount:=v_amount_text::numeric;
   if v_amount<=0 or v_amount>9007199254740991 then raise exception 'allocation amount out of range'; end if;
   if v_target=any(v_seen) then raise exception 'duplicate allocation target'; end if;
   v_seen:=array_append(v_seen,v_target);
   v_out:=v_out||jsonb_build_array(jsonb_build_object(p_target_field,v_target,'amount_paise',v_amount::text));
 end loop;
 return coalesce((select jsonb_agg(e order by e->>p_target_field) from jsonb_array_elements(v_out) e),'[]'::jsonb);
end $$;

-- Exact-retry lookup. Caller already holds the shop and request locks and checked permissions.
-- Returns null when no committed request exists; raises when the key is reused for another payload.
create function dsb_request_result(p_tenant uuid,p_shop uuid,p_operation text,p_client_id text,p_request jsonb)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_row financial_requests%rowtype;
begin
 select * into v_row from financial_requests
  where tenant_id=p_tenant and operation=p_operation and client_id=p_client_id;
 if not found then return null; end if;
 if v_row.shop_id<>p_shop or v_row.request<>p_request then
   raise exception 'client_id already used for a different request';
 end if;
 return v_row.result;
end $$;

revoke all on function dsb_lock_shop_finance(uuid,uuid) from public,anon,authenticated;
revoke all on function dsb_lock_request(uuid,text,text) from public,anon,authenticated;
revoke all on function dsb_assert_safe_paise(bigint,boolean) from public,anon,authenticated;
revoke all on function dsb_normalize_allocations(jsonb,text) from public,anon,authenticated;
revoke all on function dsb_request_result(uuid,uuid,text,text,jsonb) from public,anon,authenticated;
revoke all on function c0_financial_request_immutable() from public,anon,authenticated;

-- Public lookup for UNKNOWN-outcome reconciliation. Never exposes the stored request payload.
-- NOT_FOUND only permits an exact replay of the same attempt; it does not prove the earlier
-- call can never commit.
create function get_financial_request(p_shop_id uuid,p_operation text,p_client_id text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_row financial_requests%rowtype; v_payment uuid; v_status text;
begin
 v_tenant:=phase3_assert_shop(p_shop_id);
 if p_operation in ('record_supplier_payment','allocate_supplier_payment','release_supplier_allocation','void_supplier_payment') then
   if not has_perm('POST_PURCHASES') then raise exception 'not permitted'; end if;
 elsif p_operation in ('record_customer_payment_v2','allocate_customer_payment_v2') then
   if not has_perm('POST_SALES') then raise exception 'not permitted'; end if;
 else
   raise exception 'unknown financial operation';
 end if;
 if p_client_id is null or char_length(p_client_id) not between 1 and 128 then raise exception 'client_id required'; end if;
 perform dsb_lock_request(v_tenant,p_operation,p_client_id);
 select * into v_row from financial_requests
  where tenant_id=v_tenant and operation=p_operation and client_id=p_client_id;
 if not found or v_row.shop_id<>p_shop_id then return jsonb_build_object('state','NOT_FOUND'); end if;
 if coalesce(v_row.result->>'paymentId','') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
   v_payment:=(v_row.result->>'paymentId')::uuid;
   select status into v_status from payments where tenant_id=v_tenant and id=v_payment;
 end if;
 return jsonb_build_object('state','COMMITTED','result',v_row.result,'currentStatus',v_status);
end $$;
revoke all on function get_financial_request(uuid,text,text) from public,anon;
grant execute on function get_financial_request(uuid,text,text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. Allocation dates and history boundary (v1.1 §6.2)
-- ---------------------------------------------------------------------------------------------
create table shop_financial_history(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 shop_id uuid not null,
 allocation_dates_trustworthy_from date not null,
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at bigint not null default 0,
 deleted_at bigint,
 client_id text not null,
 unique(tenant_id,shop_id),
 unique(tenant_id,client_id),
 unique(tenant_id,id),
 foreign key(tenant_id,shop_id) references shops(tenant_id,id)
);
create trigger shop_financial_history_set_updated_at before insert or update on shop_financial_history
 for each row execute function set_updated_at();
create trigger shop_financial_history_immutable before update or delete on shop_financial_history
 for each row execute function c0_financial_request_immutable();
create trigger audit_shop_financial_history after insert on shop_financial_history
 for each row execute function audit_row_change();
alter table shop_financial_history enable row level security;
revoke all on shop_financial_history from public,anon,authenticated;

alter table payment_allocations
 add column effective_date date,
 add column effective_date_source text check(effective_date_source in ('EXPLICIT','LEGACY_INFERRED')),
 add column voided_at timestamptz;

-- Conservative inference for rows that predate this migration: the latest of payment date,
-- document date and the shop-local creation date. Already-VOID rows keep voided_at null: their
-- real void time is unknown and is not invented.
alter table payment_allocations disable trigger allocation_guard;
update payment_allocations pa set
  effective_date=greatest(
    p.business_date,
    (select si.business_date from sale_invoices si where si.tenant_id=pa.tenant_id and si.id=pa.sale_invoice_id),
    (select pb.business_date from purchase_bills pb where pb.tenant_id=pa.tenant_id and pb.id=pa.purchase_bill_id),
    (pa.created_at at time zone s.timezone)::date),
  effective_date_source='LEGACY_INFERRED'
 from payments p
 join shops s on s.tenant_id=p.tenant_id and s.id=p.shop_id
 where p.tenant_id=pa.tenant_id and p.id=pa.payment_id;
alter table payment_allocations enable trigger allocation_guard;
alter table payment_allocations alter column effective_date set not null,
 alter column effective_date_source set not null;

insert into shop_financial_history(tenant_id,shop_id,allocation_dates_trustworthy_from,created_by,client_id)
select s.tenant_id,s.id,(now() at time zone s.timezone)::date,s.created_by,'c0-allocation-history:'||s.id::text
 from shops s;

-- New allocations: date defaults to the later of payment/document date, may not precede either,
-- payment and document must share a shop, and the source is always EXPLICIT.
create function c0_allocation_dates() returns trigger language plpgsql security definer set search_path=public as $$
declare v_pay_shop uuid; v_pay_date date; v_doc_shop uuid; v_doc_date date; v_min date;
begin
 select shop_id,business_date into v_pay_shop,v_pay_date from payments where tenant_id=new.tenant_id and id=new.payment_id;
 if not found then raise exception 'payment unavailable'; end if;
 if new.sale_invoice_id is not null then
   select shop_id,business_date into v_doc_shop,v_doc_date from sale_invoices where tenant_id=new.tenant_id and id=new.sale_invoice_id;
 else
   select shop_id,business_date into v_doc_shop,v_doc_date from purchase_bills where tenant_id=new.tenant_id and id=new.purchase_bill_id;
 end if;
 if v_doc_shop is null then raise exception 'allocation document unavailable'; end if;
 if v_doc_shop<>v_pay_shop then raise exception 'payment and document shop mismatch'; end if;
 v_min:=greatest(v_pay_date,v_doc_date);
 if new.effective_date is null then new.effective_date:=v_min;
 elsif new.effective_date<v_min then raise exception 'allocation effective date precedes payment or document date';
 end if;
 new.effective_date_source:='EXPLICIT';
 new.voided_at:=null;
 return new;
end $$;
revoke all on function c0_allocation_dates() from public,anon,authenticated;
-- Named to sort after allocation_validate: BEFORE triggers fire alphabetically.
create trigger allocation_zz_dates before insert on payment_allocations
 for each row execute function c0_allocation_dates();

-- Void keeps every identity, amount and date field and stamps voided_at once.
create or replace function phase4_allocation_guard() returns trigger language plpgsql as $$
begin
 if old.status='POSTED' and new.status='VOID'
    and new.tenant_id=old.tenant_id and new.payment_id=old.payment_id and new.doc_type=old.doc_type
    and new.sale_invoice_id is not distinct from old.sale_invoice_id
    and new.purchase_bill_id is not distinct from old.purchase_bill_id
    and new.amount_paise=old.amount_paise
    and new.effective_date=old.effective_date
    and new.effective_date_source=old.effective_date_source then
   new.voided_at:=now();
   return new;
 end if;
 raise exception 'payment allocation is immutable';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 4. Shop finance lock around every money writer (v1.1 §3.4, §6a.1)
--    Order: validated tenant/shop -> shop finance lock -> (body) request lock -> rows.
--    The target's shop is read unlocked only to pick the lock; each body re-reads under lock
--    and re-validates status and permission.
-- ---------------------------------------------------------------------------------------------
alter function post_sale(uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text) rename to c0_post_sale_body;
alter function record_customer_payment(uuid,uuid,date,bigint,text,text,jsonb,text) rename to c0_record_customer_payment_body;
alter function post_purchase(uuid,uuid,text,date,bigint,bigint,text,jsonb,text) rename to c0_post_purchase_body;
alter function post_return(text,uuid,date,text,jsonb,text) rename to c0_post_return_body;
alter function void_sale(uuid,text) rename to c0_void_sale_body;
alter function void_payment(uuid) rename to c0_void_payment_body;
alter function void_purchase(uuid,text) rename to c0_void_purchase_body;
alter function void_return(text,uuid,text) rename to c0_void_return_body;

revoke all on function c0_post_sale_body(uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text) from public,anon,authenticated;
revoke all on function c0_record_customer_payment_body(uuid,uuid,date,bigint,text,text,jsonb,text) from public,anon,authenticated;
revoke all on function c0_post_purchase_body(uuid,uuid,text,date,bigint,bigint,text,jsonb,text) from public,anon,authenticated;
revoke all on function c0_post_return_body(text,uuid,date,text,jsonb,text) from public,anon,authenticated;
revoke all on function c0_void_sale_body(uuid,text) from public,anon,authenticated;
revoke all on function c0_void_payment_body(uuid) from public,anon,authenticated;
revoke all on function c0_void_purchase_body(uuid,text) from public,anon,authenticated;
revoke all on function c0_void_return_body(text,uuid,text) from public,anon,authenticated;

create function post_sale(
 p_shop_id uuid,p_customer_id uuid,p_business_date date,p_discount_paise bigint,p_extra_charges_paise bigint,
 p_client_id text,p_lines jsonb,p_payments jsonb default '[]'::jsonb,p_notes text default null
) returns uuid language plpgsql security definer set search_path=public as $$
begin
 perform dsb_lock_shop_finance(phase3_assert_shop(p_shop_id),p_shop_id);
 return c0_post_sale_body(p_shop_id,p_customer_id,p_business_date,p_discount_paise,p_extra_charges_paise,p_client_id,p_lines,p_payments,p_notes);
end $$;

create function record_customer_payment(
 p_shop_id uuid,p_customer_id uuid,p_business_date date,p_amount_paise bigint,p_mode text,p_reference text,
 p_allocations jsonb,p_client_id text
) returns uuid language plpgsql security definer set search_path=public as $$
begin
 perform dsb_lock_shop_finance(phase3_assert_shop(p_shop_id),p_shop_id);
 return c0_record_customer_payment_body(p_shop_id,p_customer_id,p_business_date,p_amount_paise,p_mode,p_reference,p_allocations,p_client_id);
end $$;

create function post_purchase(
 p_shop_id uuid,p_party_id uuid,p_bill_no text,p_business_date date,p_discount_paise bigint,p_extra_charges_paise bigint,
 p_client_id text,p_lines jsonb,p_bill_image_path text default null
) returns uuid language plpgsql security definer set search_path=public as $$
begin
 perform dsb_lock_shop_finance(phase3_assert_shop(p_shop_id),p_shop_id);
 return c0_post_purchase_body(p_shop_id,p_party_id,p_bill_no,p_business_date,p_discount_paise,p_extra_charges_paise,p_client_id,p_lines,p_bill_image_path);
end $$;

create function post_return(
 p_return_type text,p_source_id uuid,p_business_date date,p_client_id text,p_lines jsonb,p_notes text default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_shop uuid;
begin
 if v_tenant is null then raise exception 'not authenticated'; end if;
 if upper(btrim(coalesce(p_return_type,'')))='SALE' then
   select shop_id into v_shop from sale_invoices where tenant_id=v_tenant and id=p_source_id;
 elsif upper(btrim(coalesce(p_return_type,'')))='PURCHASE' then
   select shop_id into v_shop from purchase_bills where tenant_id=v_tenant and id=p_source_id;
 end if;
 if v_shop is not null then perform dsb_lock_shop_finance(v_tenant,v_shop); end if;
 return c0_post_return_body(p_return_type,p_source_id,p_business_date,p_client_id,p_lines,p_notes);
end $$;

create function void_sale(p_sale_id uuid,p_client_id text) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_shop uuid;
begin
 if v_tenant is null then raise exception 'not authenticated'; end if;
 select shop_id into v_shop from sale_invoices where tenant_id=v_tenant and id=p_sale_id;
 if v_shop is not null then perform dsb_lock_shop_finance(v_tenant,v_shop); end if;
 return c0_void_sale_body(p_sale_id,p_client_id);
end $$;

create function void_payment(p_payment_id uuid) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_shop uuid;
begin
 if v_tenant is null then raise exception 'not authenticated'; end if;
 select shop_id into v_shop from payments where tenant_id=v_tenant and id=p_payment_id;
 if v_shop is not null then perform dsb_lock_shop_finance(v_tenant,v_shop); end if;
 return c0_void_payment_body(p_payment_id);
end $$;

create function void_purchase(p_purchase_id uuid,p_client_id text) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_shop uuid;
begin
 if v_tenant is null then raise exception 'not authenticated'; end if;
 select shop_id into v_shop from purchase_bills where tenant_id=v_tenant and id=p_purchase_id;
 if v_shop is not null then
   perform dsb_lock_shop_finance(v_tenant,v_shop);
   -- Only a still-POSTED bill is refused: a retry of an already-committed void must reach the
   -- body's exact-retry path. Pre-C0 voids never checked allocations, so a legacy VOID bill may
   -- still carry POSTED allocations; that is surfaced for review, not blocked here.
   if exists(select 1 from purchase_bills where tenant_id=v_tenant and id=p_purchase_id and status='POSTED')
      and exists(select 1 from payment_allocations
              where tenant_id=v_tenant and purchase_bill_id=p_purchase_id and status='POSTED') then
     raise exception 'purchase has active allocations; void or release allocations first';
   end if;
 end if;
 return c0_void_purchase_body(p_purchase_id,p_client_id);
end $$;

create function void_return(p_return_type text,p_return_id uuid,p_client_id text) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_shop uuid;
begin
 if v_tenant is null then raise exception 'not authenticated'; end if;
 if upper(btrim(coalesce(p_return_type,'')))='SALE' then
   select shop_id into v_shop from sale_returns where tenant_id=v_tenant and id=p_return_id;
 elsif upper(btrim(coalesce(p_return_type,'')))='PURCHASE' then
   select shop_id into v_shop from purchase_returns where tenant_id=v_tenant and id=p_return_id;
 end if;
 if v_shop is not null then perform dsb_lock_shop_finance(v_tenant,v_shop); end if;
 return c0_void_return_body(p_return_type,p_return_id,p_client_id);
end $$;

revoke all on function post_sale(uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text) from public,anon;
revoke all on function record_customer_payment(uuid,uuid,date,bigint,text,text,jsonb,text) from public,anon;
revoke all on function post_purchase(uuid,uuid,text,date,bigint,bigint,text,jsonb,text) from public,anon;
revoke all on function post_return(text,uuid,date,text,jsonb,text) from public,anon;
revoke all on function void_sale(uuid,text) from public,anon;
revoke all on function void_payment(uuid) from public,anon;
revoke all on function void_purchase(uuid,text) from public,anon;
revoke all on function void_return(text,uuid,text) from public,anon;
grant execute on function post_sale(uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text) to authenticated;
grant execute on function record_customer_payment(uuid,uuid,date,bigint,text,text,jsonb,text) to authenticated;
grant execute on function post_purchase(uuid,uuid,text,date,bigint,bigint,text,jsonb,text) to authenticated;
grant execute on function post_return(text,uuid,date,text,jsonb,text) to authenticated;
grant execute on function void_sale(uuid,text) to authenticated;
grant execute on function void_payment(uuid) to authenticated;
grant execute on function void_purchase(uuid,text) to authenticated;
grant execute on function void_return(text,uuid,text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5. Backup role (existing conditional pattern)
-- ---------------------------------------------------------------------------------------------
do $$
begin
 if exists (select 1 from pg_roles where rolname='backup_ro') then
   grant select on financial_requests,shop_financial_history to backup_ro;
 end if;
end $$;
