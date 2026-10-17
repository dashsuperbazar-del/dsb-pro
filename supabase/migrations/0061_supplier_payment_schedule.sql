-- supplierschedule: supplier payment schedule (old DSB "recurring pay" checklist).
-- This is a REMINDER, not a payer: it never records money. A schedule says "pay this supplier around day N
-- of every month, about this much". What is DUE is derived on read from the immutable payments ledger (no
-- posted payment to that supplier this month, or less than the expected amount), so it cannot go stale and
-- there is nothing to tick off or undo. Paying goes through the existing audited supplier payment flow.
create table supplier_payment_schedules(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 shop_id uuid not null,
 party_id uuid not null,
 due_day smallint not null check(due_day between 1 and 28),
 expected_amount_paise bigint check(expected_amount_paise is null or (expected_amount_paise>0 and expected_amount_paise<=100000000000000)),
 note text check(note is null or char_length(note)<=300),
 status text not null default 'ACTIVE' check(status in ('ACTIVE','PAUSED')),
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at bigint not null default 0,
 deleted_at bigint,
 client_id text not null check(char_length(client_id) between 1 and 128),
 unique(tenant_id,client_id),
 unique(tenant_id,id),
 foreign key(tenant_id,shop_id) references shops(tenant_id,id),
 foreign key(tenant_id,party_id) references parties(tenant_id,id)
);
-- One live schedule per supplier per shop; a removed one (deleted_at set) can be replaced.
create unique index supplier_payment_schedules_one_live
 on supplier_payment_schedules(tenant_id,shop_id,party_id) where deleted_at is null;

create function supplier_schedule_guard() returns trigger language plpgsql as $$
begin
 raise exception 'a payment schedule is never deleted; remove it with remove_supplier_payment_schedule';
end $$;
create trigger supplier_payment_schedules_set_updated_at before insert or update on supplier_payment_schedules
 for each row execute function set_updated_at();
create trigger supplier_payment_schedules_no_delete before delete on supplier_payment_schedules
 for each row execute function supplier_schedule_guard();
create trigger audit_supplier_payment_schedules after insert or update on supplier_payment_schedules
 for each row execute function audit_row_change();

alter table supplier_payment_schedules enable row level security;
create policy supplier_payment_schedules_read on supplier_payment_schedules for select using(
 tenant_id=current_tenant_id() and c1_shop_visible(shop_id)
 and (has_perm('POST_PURCHASES') or has_perm('VIEW_REPORTS')));
revoke all on supplier_payment_schedules from public,anon,authenticated;
grant select on supplier_payment_schedules to authenticated;
do $$
begin
 if exists (select 1 from pg_roles where rolname='backup_ro') then
   grant select on supplier_payment_schedules to backup_ro;
 end if;
end $$;

-- Create or update the one live schedule of a supplier in a shop. Master-data permission (owner/manager).
create function set_supplier_payment_schedule(
 p_shop_id uuid,p_party_id uuid,p_due_day integer,p_expected_amount_paise bigint,p_note text,p_active boolean,p_client_id text
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid; v_note text:=nullif(btrim(coalesce(p_note,'')),'');
begin
 if not has_perm('MANAGE_MASTER_DATA') then raise exception 'not permitted'; end if;
 if not exists(select 1 from shops where id=p_shop_id and tenant_id=current_tenant_id()) or not c1_shop_visible(p_shop_id) then
   raise exception 'not permitted';
 end if;
 if p_due_day is null or p_due_day not between 1 and 28
    or (p_expected_amount_paise is not null and (p_expected_amount_paise<=0 or p_expected_amount_paise>100000000000000))
    or (v_note is not null and char_length(v_note)>300) or p_active is null
    or p_client_id is null or char_length(p_client_id) not between 1 and 128 then
   raise exception 'DSB_INVALID_SCHEDULE: due day 1-28, amount above zero (optional), note up to 300 characters';
 end if;
 -- KEY SHARE: an archive of this supplier cannot slip in between the check and the write.
 perform 1 from parties where id=p_party_id and tenant_id=current_tenant_id() and deleted_at is null for key share;
 if not found then raise exception 'DSB_PARTY_NOT_FOUND: supplier not found'; end if;
 insert into supplier_payment_schedules(tenant_id,shop_id,party_id,due_day,expected_amount_paise,note,status,client_id)
 values(current_tenant_id(),p_shop_id,p_party_id,p_due_day,p_expected_amount_paise,v_note,
        case when p_active then 'ACTIVE' else 'PAUSED' end,p_client_id)
 on conflict(tenant_id,shop_id,party_id) where deleted_at is null do update
   set due_day=excluded.due_day,expected_amount_paise=excluded.expected_amount_paise,note=excluded.note,status=excluded.status
 returning id into v_id;
 return v_id;
end $$;

-- Soft remove (the row stays for the audit trail). Idempotent.
create function remove_supplier_payment_schedule(p_schedule_id uuid) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_row supplier_payment_schedules%rowtype; v_now bigint:=(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 if not has_perm('MANAGE_MASTER_DATA') then raise exception 'not permitted'; end if;
 select * into v_row from supplier_payment_schedules where id=p_schedule_id and tenant_id=current_tenant_id() for update;
 if not found or not c1_shop_visible(v_row.shop_id) then raise exception 'DSB_SCHEDULE_NOT_FOUND: schedule not found'; end if;
 if v_row.deleted_at is not null then return p_schedule_id; end if;
 update supplier_payment_schedules set deleted_at=v_now where id=p_schedule_id;
 return p_schedule_id;
end $$;

-- What is due on p_on. Money paid is read from the ledger: posted supplier payments made ("out") from the
-- first of p_on's month through p_on. Due = nothing paid yet (no expected amount) or paid below the expected amount.
create function get_supplier_payments_due(p_shop_id uuid,p_on date)
returns table(schedule_id uuid,party_id uuid,party_name text,due_day integer,due_date date,
              expected_amount_paise bigint,paid_this_month_paise bigint,remaining_paise bigint,days_overdue integer)
language plpgsql stable security definer set search_path=public as $$
declare v_month date;
begin
 if not (has_perm('POST_PURCHASES') or has_perm('VIEW_REPORTS')) then raise exception 'not permitted'; end if;
 if not exists(select 1 from shops where id=p_shop_id and tenant_id=current_tenant_id()) or not c1_shop_visible(p_shop_id) then
   raise exception 'not permitted';
 end if;
 if p_on is null then raise exception 'DSB_INVALID_SCHEDULE: a date is required'; end if;
 v_month:=date_trunc('month',p_on)::date;
 return query
 with s as (
  select sc.id,sc.party_id,p.name,sc.due_day::integer,(v_month+(sc.due_day-1))::date due_date,sc.expected_amount_paise,
   coalesce((select sum(pm.amount_paise) from payments pm
     where pm.tenant_id=sc.tenant_id and pm.shop_id=sc.shop_id and pm.kind='party' and pm.party_id=sc.party_id
       and pm.direction='out' and pm.status='POSTED' and pm.deleted_at is null
       and pm.business_date between v_month and p_on),0)::bigint paid
  from supplier_payment_schedules sc
  join parties p on p.tenant_id=sc.tenant_id and p.id=sc.party_id and p.deleted_at is null
  where sc.tenant_id=current_tenant_id() and sc.shop_id=p_shop_id and sc.deleted_at is null and sc.status='ACTIVE'
 )
 select s.id,s.party_id,s.name,s.due_day,s.due_date,s.expected_amount_paise,s.paid,
   case when s.expected_amount_paise is null then null else greatest(s.expected_amount_paise-s.paid,0) end,
   (p_on-s.due_date)::integer
 from s
 where p_on>=s.due_date and ((s.expected_amount_paise is null and s.paid=0) or (s.expected_amount_paise is not null and s.paid<s.expected_amount_paise))
 order by s.due_date,s.name;
end $$;

revoke all on function supplier_schedule_guard() from public,anon,authenticated;
revoke all on function set_supplier_payment_schedule(uuid,uuid,integer,bigint,text,boolean,text) from public,anon;
revoke all on function remove_supplier_payment_schedule(uuid) from public,anon;
revoke all on function get_supplier_payments_due(uuid,date) from public,anon;
grant execute on function set_supplier_payment_schedule(uuid,uuid,integer,bigint,text,boolean,text) to authenticated;
grant execute on function remove_supplier_payment_schedule(uuid) to authenticated;
grant execute on function get_supplier_payments_due(uuid,date) to authenticated;

-- The business export carries the schedules too (the coverage test fails on any unexported table).
create or replace function phase6_export_tenant(p_shop_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_base jsonb; v_tenant uuid;
begin
 v_base:=phase6_export_tenant_v4_base(p_shop_id); v_tenant:=(v_base->>'tenantId')::uuid;
 return v_base || jsonb_build_object(
  'schemaVersion',4,
  'saleReturns',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from sale_returns where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'saleReturnLines',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from sale_return_items where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'purchaseReturns',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from purchase_returns where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'purchaseReturnLines',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from purchase_return_items where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'accountOpenings',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from account_openings where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'openingSettlements',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from opening_settlements where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  -- D3a: the request ledger (payload + result of every money request) and the shop's allocation-date
  -- trust marker, so a restore keeps replay protection and dated reports.
  'financialRequests',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from financial_requests where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'shopFinancialHistory',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from shop_financial_history where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'supplierPaymentSchedules',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from supplier_payment_schedules where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb)
 );
end $$;
