-- Packet O2 (group o2): settle payments against opening balances (deferred from O1).
-- A settlement assigns the still-unassigned part of a POSTED payment to a positive opening of the same
-- account (customer receipt -> customer opening; supplier payment -> supplier opening). It moves no money:
-- net balances are unchanged; only open items and unassigned cash change. Existing payment writers are
-- untouched; a new allocation trigger counts settlements so a payment is never assigned twice.
-- Credit openings (negative) are not applied to bills here; they stay as credits in the net balance.
create table opening_settlements(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 shop_id uuid not null,
 account_kind text not null check(account_kind in ('CUSTOMER','SUPPLIER')),
 opening_id uuid not null,
 payment_id uuid not null,
 amount_paise bigint not null check(amount_paise>0 and amount_paise<=100000000000000),
 effective_date date not null,
 status text not null default 'POSTED' check(status in ('POSTED','VOID')),
 void_reason text check(void_reason is null or char_length(btrim(void_reason)) between 1 and 500),
 voided_at timestamptz,
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at bigint not null default 0,
 deleted_at bigint,
 client_id text not null check(char_length(client_id) between 1 and 128),
 unique(tenant_id,client_id),
 foreign key(tenant_id,shop_id) references shops(tenant_id,id),
 foreign key(tenant_id,opening_id) references account_openings(tenant_id,id),
 foreign key(tenant_id,payment_id) references payments(tenant_id,id),
 check((status='VOID')=(voided_at is not null and void_reason is not null))
);
create index opening_settlements_opening_idx on opening_settlements(tenant_id,opening_id) where status='POSTED';
create index opening_settlements_payment_idx on opening_settlements(tenant_id,payment_id) where status='POSTED';

create function o2_settlement_guard() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' then raise exception 'opening settlement is immutable; void it instead'; end if;
 if old.status='POSTED' and new.status='VOID'
    and new.tenant_id=old.tenant_id and new.shop_id=old.shop_id and new.account_kind=old.account_kind
    and new.opening_id=old.opening_id and new.payment_id=old.payment_id and new.amount_paise=old.amount_paise
    and new.effective_date=old.effective_date and new.client_id=old.client_id
    and new.created_by=old.created_by and new.created_at=old.created_at
    and new.voided_at is not null and new.void_reason is not null then
   return new;
 end if;
 raise exception 'opening settlement is immutable; void it instead';
end $$;
create trigger opening_settlements_set_updated_at before insert or update on opening_settlements
 for each row execute function set_updated_at();
create trigger opening_settlements_guard before update or delete on opening_settlements
 for each row execute function o2_settlement_guard();
create trigger audit_opening_settlements after insert or update on opening_settlements
 for each row execute function audit_row_change();

alter table opening_settlements enable row level security;
create policy opening_settlements_read on opening_settlements for select using(
 tenant_id=current_tenant_id() and c1_shop_visible(shop_id)
 and ((account_kind='CUSTOMER' and (has_perm('POST_SALES') or has_perm('VIEW_REPORTS')))
   or (account_kind='SUPPLIER' and (has_perm('POST_PURCHASES') or has_perm('VIEW_REPORTS')))));
revoke all on opening_settlements from public,anon,authenticated;
grant select on opening_settlements to authenticated;
do $$
begin
 if exists (select 1 from pg_roles where rolname='backup_ro') then
   grant select on opening_settlements to backup_ro;
 end if;
end $$;

-- What of a payment is already assigned: bill/invoice allocations plus opening settlements.
create function o2_payment_assigned(p_tenant uuid,p_payment uuid) returns bigint
language sql stable security definer set search_path=public as $$
 select coalesce((select sum(amount_paise) from payment_allocations where tenant_id=p_tenant and payment_id=p_payment and status='POSTED'),0)
       +coalesce((select sum(amount_paise) from opening_settlements where tenant_id=p_tenant and payment_id=p_payment and status='POSTED'),0)
$$;
revoke all on function o2_payment_assigned(uuid,uuid) from public,anon,authenticated;

-- Every new allocation (from any writer) is refused if, with settlements, it would assign more than the payment.
create function o2_allocation_within_payment() returns trigger
language plpgsql security definer set search_path=public as $$
declare v_amount bigint;
begin
 if new.status<>'POSTED' then return new; end if;
 select amount_paise into v_amount from payments where tenant_id=new.tenant_id and id=new.payment_id;
 if v_amount is not null and o2_payment_assigned(new.tenant_id,new.payment_id)+new.amount_paise>v_amount then
   raise exception 'DSB_ALLOCATION_EXCEEDS_PAYMENT: allocations exceed payment amount';
 end if;
 return new;
end $$;
create trigger payment_allocations_o2_within_payment before insert on payment_allocations
 for each row execute function o2_allocation_within_payment();

-- A voided payment releases its settlements with it (same as its allocations).
create function o2_void_settlements_with_payment() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 update opening_settlements set status='VOID',voided_at=now(),void_reason='Payment voided'
 where tenant_id=new.tenant_id and payment_id=new.id and status='POSTED';
 return new;
end $$;
create trigger payments_o2_void_settlements after update of status on payments
 for each row when (old.status='POSTED' and new.status='VOID') execute function o2_void_settlements_with_payment();

-- Owner only, idempotent by client id, under the shop finance lock.
create function settle_opening(p_opening_id uuid,p_payment_id uuid,p_amount_paise bigint,p_client_id text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_open account_openings%rowtype; v_pay payments%rowtype;
 v_row opening_settlements%rowtype; v_settled bigint;
begin
 if v_tenant is null then raise exception 'not authenticated'; end if;
 if coalesce("current_role"(),'')<>'owner' then raise exception 'not permitted'; end if;
 if p_client_id is null or char_length(btrim(p_client_id)) not between 1 and 128 then raise exception 'DSB_INVALID_REQUEST: client id required'; end if;
 select * into v_open from account_openings where tenant_id=v_tenant and id=p_opening_id;
 if not found then raise exception 'DSB_OPENING_UNAVAILABLE: opening unavailable'; end if;
 perform phase3_assert_shop(v_open.shop_id);
 perform dsb_lock_shop_finance(v_tenant,v_open.shop_id);
 select * into v_row from opening_settlements where tenant_id=v_tenant and client_id=p_client_id;
 if found then
   if v_row.opening_id=p_opening_id and v_row.payment_id=p_payment_id and v_row.amount_paise=p_amount_paise then
     if v_row.status='VOID' then raise exception 'DSB_SETTLEMENT_VOIDED: this settlement was recorded and has since been voided'; end if;
     return v_row.id;
   end if;
   raise exception 'DSB_PAYLOAD_MISMATCH: client_id already used for a different settlement';
 end if;
 select * into v_open from account_openings where tenant_id=v_tenant and id=p_opening_id for update;
 if v_open.status<>'POSTED' or v_open.deleted_at is not null then raise exception 'DSB_OPENING_UNAVAILABLE: opening unavailable'; end if;
 if v_open.amount_paise<=0 then raise exception 'DSB_OPENING_NOT_DUE: only an opening the account owes can be settled'; end if;
 select * into v_pay from payments where tenant_id=v_tenant and id=p_payment_id for update;
 if not found or v_pay.status<>'POSTED' or v_pay.deleted_at is not null or v_pay.shop_id<>v_open.shop_id then
   raise exception 'DSB_PAYMENT_UNAVAILABLE: payment unavailable';
 end if;
 if not ((v_open.account_kind='CUSTOMER' and v_pay.kind='customer' and v_pay.direction='in' and v_pay.customer_id=v_open.customer_id)
      or (v_open.account_kind='SUPPLIER' and v_pay.kind='party' and v_pay.direction='out' and v_pay.party_id=v_open.party_id)) then
   raise exception 'DSB_PAYMENT_MISMATCH: payment is not from this account in the right direction';
 end if;
 if p_amount_paise is null or p_amount_paise<=0 then raise exception 'DSB_INVALID_AMOUNT: amount must be greater than zero'; end if;
 if o2_payment_assigned(v_tenant,v_pay.id)+p_amount_paise>v_pay.amount_paise then
   raise exception 'DSB_ALLOCATION_EXCEEDS_PAYMENT: more than the unassigned part of the payment';
 end if;
 select coalesce(sum(amount_paise),0) into v_settled from opening_settlements
  where tenant_id=v_tenant and opening_id=v_open.id and status='POSTED';
 if v_settled+p_amount_paise>v_open.amount_paise then
   raise exception 'DSB_SETTLEMENT_EXCEEDS_OPENING: more than what remains of the opening';
 end if;
 insert into opening_settlements(tenant_id,shop_id,account_kind,opening_id,payment_id,amount_paise,effective_date,client_id)
 values(v_tenant,v_open.shop_id,v_open.account_kind,v_open.id,v_pay.id,p_amount_paise,
   greatest(v_pay.business_date,v_open.as_of_date),p_client_id)
 returning * into v_row;
 return v_row.id;
end $$;

create function void_opening_settlement(p_settlement_id uuid,p_reason text) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_row opening_settlements%rowtype;
begin
 if v_tenant is null then raise exception 'not authenticated'; end if;
 if coalesce("current_role"(),'')<>'owner' then raise exception 'not permitted'; end if;
 if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then raise exception 'DSB_INVALID_REASON: reason required (1-500 characters)'; end if;
 select * into v_row from opening_settlements where tenant_id=v_tenant and id=p_settlement_id;
 if not found then raise exception 'DSB_SETTLEMENT_UNAVAILABLE: settlement unavailable'; end if;
 perform phase3_assert_shop(v_row.shop_id);
 perform dsb_lock_shop_finance(v_tenant,v_row.shop_id);
 select * into v_row from opening_settlements where tenant_id=v_tenant and id=p_settlement_id for update;
 if v_row.status='VOID' then return v_row.id; end if;
 update opening_settlements set status='VOID',voided_at=now(),void_reason=btrim(p_reason) where id=v_row.id;
 return v_row.id;
end $$;

-- Owner screen data: positive openings with what remains, payments with an unassigned part, settlements.
create function get_opening_settlement_options(p_shop_id uuid) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid;
begin
 if coalesce("current_role"(),'')<>'owner' then raise exception 'not permitted'; end if;
 v_tenant:=phase3_assert_shop(p_shop_id);
 return jsonb_build_object(
  'openings',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'kind',o.account_kind,
     'accountId',coalesce(o.customer_id,o.party_id),'asOfDate',o.as_of_date,'amountPaise',o.amount_paise::text,
     'remainingPaise',(o.amount_paise-coalesce(s.v,0))::text) order by o.as_of_date,o.id)
   from account_openings o left join lateral (select sum(amount_paise) v from opening_settlements x
     where x.tenant_id=o.tenant_id and x.opening_id=o.id and x.status='POSTED') s on true
   where o.tenant_id=v_tenant and o.shop_id=p_shop_id and o.status='POSTED' and o.deleted_at is null
     and o.amount_paise>0),'[]'::jsonb),
  'payments',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'kind',case when p.kind='customer' then 'CUSTOMER' else 'SUPPLIER' end,
     'accountId',coalesce(p.customer_id,p.party_id),'businessDate',p.business_date,'amountPaise',p.amount_paise::text,
     'unassignedPaise',(p.amount_paise-o2_payment_assigned(v_tenant,p.id))::text) order by p.business_date,p.id)
   from payments p where p.tenant_id=v_tenant and p.shop_id=p_shop_id and p.status='POSTED' and p.deleted_at is null
     and ((p.kind='customer' and p.direction='in' and p.customer_id is not null) or (p.kind='party' and p.direction='out' and p.party_id is not null))
     and p.amount_paise>o2_payment_assigned(v_tenant,p.id)),'[]'::jsonb),
  'settlements',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'openingId',x.opening_id,'paymentId',x.payment_id,
     'amountPaise',x.amount_paise::text,'effectiveDate',x.effective_date,'status',x.status,'voidReason',x.void_reason)
     order by x.created_at desc,x.id)
   from opening_settlements x where x.tenant_id=v_tenant and x.shop_id=p_shop_id),'[]'::jsonb));
end $$;

revoke all on function settle_opening(uuid,uuid,bigint,text) from public,anon;
revoke all on function void_opening_settlement(uuid,text) from public,anon;
revoke all on function get_opening_settlement_options(uuid) from public,anon;
grant execute on function settle_opening(uuid,uuid,bigint,text) to authenticated;
grant execute on function void_opening_settlement(uuid,text) to authenticated;
grant execute on function get_opening_settlement_options(uuid) to authenticated;

-- Reports and void_account_opening (from 0054) with settlements.
create or replace function void_account_opening(p_opening_id uuid,p_reason text) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_row account_openings%rowtype;
begin
 if coalesce("current_role"(),'')<>'owner' then raise exception 'not permitted'; end if;
 if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then raise exception 'DSB_INVALID_REASON: reason required (1-500 characters)'; end if;
 select * into v_row from account_openings where tenant_id=v_tenant and id=p_opening_id;
 if not found then raise exception 'DSB_OPENING_UNAVAILABLE: opening unavailable'; end if;
 perform phase3_assert_shop(v_row.shop_id);
 perform dsb_lock_shop_finance(v_tenant,v_row.shop_id);
 select * into v_row from account_openings where tenant_id=v_tenant and id=p_opening_id for update;
 if v_row.status='VOID' then return v_row.id; end if;
 if exists(select 1 from opening_settlements where tenant_id=v_tenant and opening_id=v_row.id and status='POSTED') then
   raise exception 'DSB_OPENING_SETTLED: payments are settled against this opening; void those settlements first';
 end if;
 update account_openings set status='VOID',voided_at=now(),void_reason=btrim(p_reason) where id=v_row.id;
 return v_row.id;
end $$;

CREATE OR REPLACE FUNCTION public.get_supplier_outstanding(p_shop_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_tenant uuid:=c1_assert_supplier_read(p_shop_id); v_rows jsonb;
begin
 with bills as (
   select b.party_id,b.purchase_bill_id,b.net_outstanding_paise net from purchase_bill_outstanding b
   where b.tenant_id=v_tenant and b.shop_id=p_shop_id
 ), advances as (
   select p.party_id,sum(p.amount_paise-coalesce((select sum(a.amount_paise) from payment_allocations a
     where a.tenant_id=p.tenant_id and a.payment_id=p.id and a.status='POSTED'),0)
     -coalesce((select sum(s.amount_paise) from opening_settlements s where s.tenant_id=p.tenant_id and s.payment_id=p.id and s.status='POSTED'),0)) unallocated
   from payments p where p.tenant_id=v_tenant and p.shop_id=p_shop_id and p.kind='party' and p.direction='out' and p.status='POSTED'
   group by p.party_id
 ), ledger as (
   select party_id,sum(amt) bal from (
     select party_id,total_paise amt from purchase_bills where tenant_id=v_tenant and shop_id=p_shop_id and status='POSTED' and party_id is not null
     union all select party_id,-total_paise from purchase_returns where tenant_id=v_tenant and shop_id=p_shop_id and status='POSTED' and party_id is not null
     union all select party_id,case when direction='out' then -amount_paise else amount_paise end from payments
       where tenant_id=v_tenant and shop_id=p_shop_id and kind='party' and status='POSTED'
     union all select party_id,amount_paise from account_openings
       where tenant_id=v_tenant and shop_id=p_shop_id and account_kind='SUPPLIER' and status='POSTED' and deleted_at is null
   ) e group by party_id
 ), openings as (
   select o.party_id,sum(case when o.amount_paise>0 then o.amount_paise-coalesce((select sum(s.amount_paise) from opening_settlements s
     where s.tenant_id=o.tenant_id and s.opening_id=o.id and s.status='POSTED'),0) else 0 end) pos,
     sum(greatest(-o.amount_paise,0)) neg from account_openings o
   where o.tenant_id=v_tenant and o.shop_id=p_shop_id and o.account_kind='SUPPLIER' and o.status='POSTED' and o.deleted_at is null group by o.party_id
 ), stranded as (
   select p.party_id,count(*) n from payment_allocations a
   join payments p on p.tenant_id=a.tenant_id and p.id=a.payment_id
   join purchase_bills b on b.tenant_id=a.tenant_id and b.id=a.purchase_bill_id
   where a.tenant_id=v_tenant and p.shop_id=p_shop_id and a.status='POSTED' and b.status='VOID'
   group by p.party_id
 ), party_ids as (
   select party_id from bills union select party_id from advances union select party_id from ledger
   union select party_id from openings
 )
 select coalesce(jsonb_agg(jsonb_build_object(
   'partyId',pi.party_id,'partyName',pt.name,
   'grossOpenBills',coalesce((select sum(greatest(net,0)) from bills b where b.party_id=pi.party_id),0)::text,
   -- O2: a positive opening remains until payments are settled against it.
   'remainingPositiveOpenings',coalesce(op.pos,0)::text,
   'unallocatedCashAdvances',coalesce(ad.unallocated,0)::text,
   'remainingOpeningCredits',coalesce(op.neg,0)::text,
   'returnCredits',coalesce((select sum(-least(net,0)) from bills b where b.party_id=pi.party_id),0)::text,
   'netLedgerBalance',coalesce(l.bal,0)::text,
   'strandedAllocationsOnVoidBills',coalesce(st.n,0)) order by pt.name),'[]'::jsonb)
 into v_rows
 from party_ids pi
 join parties pt on pt.tenant_id=v_tenant and pt.id=pi.party_id
 left join advances ad on ad.party_id=pi.party_id
 left join ledger l on l.party_id=pi.party_id
 left join stranded st on st.party_id=pi.party_id
 left join openings op on op.party_id=pi.party_id;
 return jsonb_build_object('shopId',p_shop_id,'parties',v_rows);
end $function$;

CREATE OR REPLACE FUNCTION public.get_customer_aging_report_v2(p_shop_id uuid, p_as_of date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_tenant uuid:=phase6_assert_report_access(); v_docs jsonb; v_accounts jsonb;
begin
 perform phase3_assert_shop(p_shop_id);
 perform d1_assert_as_of(p_shop_id,p_as_of);
 with inv as (
  select s.id,s.customer_id,s.doc_no,s.business_date,s.total_paise from sale_invoices s
  where s.tenant_id=v_tenant and s.shop_id=p_shop_id and s.customer_id is not null and s.status='FINALIZED'
    and s.deleted_at is null and s.business_date<=p_as_of
 ), rcpt as (
  select p.id,p.customer_id,p.amount_paise from payments p
  where p.tenant_id=v_tenant and p.shop_id=p_shop_id and p.kind='customer' and p.customer_id is not null and p.direction='in'
    and p.status='POSTED' and p.deleted_at is null and p.business_date<=p_as_of
 ), alloc as (
  select pa.sale_invoice_id,pa.payment_id,pa.amount_paise,pa.effective_date_source from payment_allocations pa
  join rcpt r on r.id=pa.payment_id join inv i on i.id=pa.sale_invoice_id
  where pa.tenant_id=v_tenant and pa.status='POSTED' and pa.effective_date<=p_as_of
 ), settle as (
  -- O2: receipts settled against an opening (effective by the as-of date).
  select st.payment_id,st.opening_id,st.amount_paise from opening_settlements st join rcpt r on r.id=st.payment_id
  where st.tenant_id=v_tenant and st.status='POSTED' and st.effective_date<=p_as_of
 ), settle_pay as (
  select payment_id,sum(amount_paise) v from settle group by payment_id
 ), settle_open as (
  select opening_id,sum(amount_paise) v from settle group by opening_id
 ), ret as (
  select x.sale_invoice_id,sum(x.total_paise) v from sale_returns x join inv i on i.id=x.sale_invoice_id
  where x.tenant_id=v_tenant and x.status='POSTED' and x.deleted_at is null and x.business_date<=p_as_of group by x.sale_invoice_id
 ), outp as (
  select p.id,p.customer_id,p.amount_paise,p.source_sale_invoice_id,i.id linked_inv,i.customer_id inv_customer from payments p
  left join inv i on i.id=p.source_sale_invoice_id
  where p.tenant_id=v_tenant and p.shop_id=p_shop_id and p.direction='out' and p.status='POSTED' and p.deleted_at is null
    and p.business_date<=p_as_of and (i.id is not null or (p.kind='customer' and p.customer_id is not null))
 ), alloc_doc as (
  -- Aggregated once (no per-row rescans): allocations per invoice and per receipt, linked refunds per invoice.
  select sale_invoice_id,sum(amount_paise) v,bool_or(effective_date_source='LEGACY_INFERRED') legacy from alloc group by sale_invoice_id
 ), alloc_pay as (
  select payment_id,sum(amount_paise) v from alloc group by payment_id
 ), linked as (
  select linked_inv,sum(amount_paise) v from outp where linked_inv is not null group by linked_inv
 ), docs as (
  select i.customer_id account_id,i.id,i.doc_no,i.business_date,i.total_paise,coalesce(r.v,0) returned,coalesce(l.v,0) refunded,
   i.total_paise-coalesce(r.v,0)-coalesce(a.v,0)+coalesce(l.v,0) due,coalesce(a.legacy,false) legacy
  from inv i left join ret r on r.sale_invoice_id=i.id left join alloc_doc a on a.sale_invoice_id=i.id
  left join linked l on l.linked_inv=i.id
  union all
  -- O1: an opening balance is an open item aged from its as-of date (signed: negative = we owe them).
  select o.customer_id,o.id,'Opening balance',o.as_of_date,o.amount_paise,0,0,o.amount_paise-coalesce(so.v,0),false
  from account_openings o left join settle_open so on so.opening_id=o.id where o.tenant_id=v_tenant and o.shop_id=p_shop_id and o.account_kind='CUSTOMER'
    and o.status='POSTED' and o.deleted_at is null and o.as_of_date<=p_as_of
 ), cash as (
  select customer_id,sum(ua_in) ua_in,sum(ua_out) ua_out,sum(rcpt_total) rcpt_total from (
   select r.customer_id,r.amount_paise-coalesce(ap.v,0)-coalesce(sp.v,0) ua_in,0 ua_out,r.amount_paise rcpt_total
   from rcpt r left join alloc_pay ap on ap.payment_id=r.id left join settle_pay sp on sp.payment_id=r.id
   union all select o.customer_id,0,o.amount_paise,0 from outp o where o.linked_inv is null
  ) c group by customer_id
 ), docsum as (
  select account_id,sum(total_paise-returned+refunded) v from docs group by account_id
 ), ids as (select account_id customer_id from docs union select customer_id from cash)
 select
  coalesce((select jsonb_agg(jsonb_build_object('accountId',d.account_id,'documentId',d.id,'documentNo',d.doc_no,
    'businessDate',d.business_date,'signedDue',d.due::text,'legacyInferred',d.legacy)) from docs d),'[]'::jsonb),
  coalesce((select jsonb_agg(jsonb_build_object('accountId',x.customer_id,'name',c.name,
    'unassignedIn',coalesce(k.ua_in,0)::text,'unassignedOut',coalesce(k.ua_out,0)::text,
    -- Net ledger balance from the source rows: invoices - returns + linked refunds - receipts + unlinked refunds.
    'net',(coalesce(ds.v,0)-coalesce(k.rcpt_total,0)+coalesce(k.ua_out,0))::text))
   from ids x join customers c on c.tenant_id=v_tenant and c.id=x.customer_id left join cash k on k.customer_id=x.customer_id
   left join docsum ds on ds.account_id=x.customer_id),'[]'::jsonb)
 into v_docs,v_accounts;

 return d1_aging_json(p_shop_id,p_as_of,v_docs,v_accounts)
  || jsonb_build_object('kind','customer','signConvention','positive = customer owes the shop');
end $function$;

CREATE OR REPLACE FUNCTION public.get_supplier_aging_report_v2(p_shop_id uuid, p_as_of date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_tenant uuid:=c1_assert_supplier_read(p_shop_id); v_docs jsonb; v_accounts jsonb;
begin
 perform d1_assert_as_of(p_shop_id,p_as_of);
 with bill as (
  select b.id,b.party_id,coalesce(b.bill_no,b.id::text) doc_no,b.business_date,b.total_paise from purchase_bills b
  where b.tenant_id=v_tenant and b.shop_id=p_shop_id and b.party_id is not null and b.status='POSTED'
    and b.deleted_at is null and b.business_date<=p_as_of
 ), paid as (
  select p.id,p.party_id,p.amount_paise from payments p
  where p.tenant_id=v_tenant and p.shop_id=p_shop_id and p.kind='party' and p.party_id is not null and p.direction='out'
    and p.status='POSTED' and p.deleted_at is null and p.business_date<=p_as_of
 ), recv as (
  select p.party_id,sum(p.amount_paise) v from payments p
  where p.tenant_id=v_tenant and p.shop_id=p_shop_id and p.kind='party' and p.party_id is not null and p.direction='in'
    and p.status='POSTED' and p.deleted_at is null and p.business_date<=p_as_of group by p.party_id
 ), alloc as (
  select pa.purchase_bill_id,pa.payment_id,pa.amount_paise,pa.effective_date_source from payment_allocations pa
  join paid q on q.id=pa.payment_id join bill b on b.id=pa.purchase_bill_id
  where pa.tenant_id=v_tenant and pa.status='POSTED' and pa.effective_date<=p_as_of
 ), settle as (
  select st.payment_id,st.opening_id,st.amount_paise from opening_settlements st join paid q on q.id=st.payment_id
  where st.tenant_id=v_tenant and st.status='POSTED' and st.effective_date<=p_as_of
 ), settle_pay as (
  select payment_id,sum(amount_paise) v from settle group by payment_id
 ), settle_open as (
  select opening_id,sum(amount_paise) v from settle group by opening_id
 ), ret as (
  select x.purchase_bill_id,sum(x.total_paise) v from purchase_returns x join bill b on b.id=x.purchase_bill_id
  where x.tenant_id=v_tenant and x.status='POSTED' and x.business_date<=p_as_of group by x.purchase_bill_id
 ), alloc_doc as (
  select purchase_bill_id,sum(amount_paise) v,bool_or(effective_date_source='LEGACY_INFERRED') legacy from alloc group by purchase_bill_id
 ), alloc_pay as (
  select payment_id,sum(amount_paise) v from alloc group by payment_id
 ), docs as (
  select b.party_id account_id,b.id,b.doc_no,b.business_date,b.total_paise-coalesce(r.v,0) net_of_returns,
   b.total_paise-coalesce(r.v,0)-coalesce(a.v,0) due,coalesce(a.legacy,false) legacy
  from bill b left join ret r on r.purchase_bill_id=b.id left join alloc_doc a on a.purchase_bill_id=b.id
  union all
  select o.party_id,o.id,'Opening balance',o.as_of_date,o.amount_paise,o.amount_paise-coalesce(so.v,0),false
  from account_openings o left join settle_open so on so.opening_id=o.id where o.tenant_id=v_tenant and o.shop_id=p_shop_id and o.account_kind='SUPPLIER'
    and o.status='POSTED' and o.deleted_at is null and o.as_of_date<=p_as_of
 ), cash as (
  select party_id,sum(ua_out) ua_out,sum(ua_in) ua_in,sum(paid_total) paid_total from (
   select q.party_id,q.amount_paise-coalesce(ap.v,0)-coalesce(sp.v,0) ua_out,0 ua_in,q.amount_paise paid_total
   from paid q left join alloc_pay ap on ap.payment_id=q.id left join settle_pay sp on sp.payment_id=q.id
   union all select party_id,0,v,0 from recv
  ) c group by party_id
 ), docsum as (
  select account_id,sum(net_of_returns) v from docs group by account_id
 ), ids as (select account_id party_id from docs union select party_id from cash)
 select
  coalesce((select jsonb_agg(jsonb_build_object('accountId',d.account_id,'documentId',d.id,'documentNo',d.doc_no,
    'businessDate',d.business_date,'signedDue',d.due::text,'legacyInferred',d.legacy)) from docs d),'[]'::jsonb),
  coalesce((select jsonb_agg(jsonb_build_object('accountId',x.party_id,'name',pt.name,
    'unassignedIn',coalesce(k.ua_in,0)::text,'unassignedOut',coalesce(k.ua_out,0)::text,
    -- Net ledger balance from the source rows: bills - returns - payments made + money received.
    'net',(coalesce(ds.v,0)-coalesce(k.paid_total,0)+coalesce(k.ua_in,0))::text))
   from ids x join parties pt on pt.tenant_id=v_tenant and pt.id=x.party_id left join cash k on k.party_id=x.party_id
   left join docsum ds on ds.account_id=x.party_id),'[]'::jsonb)
 into v_docs,v_accounts;

 return d1_aging_json(p_shop_id,p_as_of,v_docs,v_accounts)
  || jsonb_build_object('kind','supplier','signConvention','positive = shop owes the supplier');
end $function$;

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
  'openingSettlements',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from opening_settlements where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb)
 );
end $$;

-- check_invariants (from 0053), unchanged except: allocations + settlements per payment; settlement checks.
CREATE OR REPLACE FUNCTION public.check_invariants()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_tenant uuid:=phase6_assert_report_access();
 bad_sales bigint; bad_purchases bigint; bad_stock bigint; bad_alloc bigint; bad_projection bigint; bad_voids bigint;
 bad_sale_returns bigint; bad_purchase_returns bigint; bad_return_qty bigint; bad_refunds bigint; bad_payment_direction bigint; bad_settlements bigint;
begin
 select count(*) into bad_sales from sale_invoices s where s.tenant_id=v_tenant and s.status='FINALIZED' and
  (s.subtotal_paise<>(select coalesce(sum(li.line_total_paise+li.discount_paise),0) from sale_invoice_items li where li.sale_invoice_id=s.id)
   or s.total_paise<>s.subtotal_paise-s.discount_paise+s.extra_charges_paise+s.round_off_paise);
 select count(*) into bad_purchases from purchase_bills b where b.tenant_id=v_tenant and b.status='POSTED' and
  (b.subtotal_paise<>(select coalesce(sum(li.line_total_paise),0) from purchase_bill_items li where li.purchase_bill_id=b.id)
   or b.total_paise<>b.subtotal_paise-b.discount_paise+b.extra_charges_paise);
 select count(*) into bad_stock from stock_current sc where sc.tenant_id=v_tenant and sc.qty_base<0
  and not coalesce((select allow_negative_stock from shops where id=sc.shop_id),false);
 select count(*) into bad_alloc from payments p where p.tenant_id=v_tenant and
  o2_payment_assigned(p.tenant_id,p.id)>p.amount_paise;  -- O2: allocations + opening settlements
 -- O2: a POSTED settlement needs a POSTED payment of the right account/direction and a POSTED positive
 -- opening it does not overdraw.
 select count(*) into bad_settlements from opening_settlements st
  join payments p on p.tenant_id=st.tenant_id and p.id=st.payment_id
  join account_openings o on o.tenant_id=st.tenant_id and o.id=st.opening_id
  where st.tenant_id=v_tenant and st.status='POSTED' and (p.status<>'POSTED' or o.status<>'POSTED' or o.amount_paise<=0
   or not ((o.account_kind='CUSTOMER' and p.kind='customer' and p.direction='in' and p.customer_id=o.customer_id)
        or (o.account_kind='SUPPLIER' and p.kind='party' and p.direction='out' and p.party_id=o.party_id))
   or (select sum(x.amount_paise) from opening_settlements x where x.tenant_id=o.tenant_id and x.opening_id=o.id and x.status='POSTED')>o.amount_paise);
 select count(*) into bad_payment_direction from payment_allocations a join payments p on p.tenant_id=a.tenant_id and p.id=a.payment_id
  where a.tenant_id=v_tenant and a.status='POSTED' and (p.status<>'POSTED'
   or (a.sale_invoice_id is not null and p.direction<>'in')
   or (a.purchase_bill_id is not null and (p.direction<>'out' or p.party_id is null)));
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
  (r.total_paise<>(select coalesce(sum(i.amount_paise),0) from sale_return_items i where i.sale_return_id=r.id)+r.round_off_paise
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
   and bad_sale_returns=0 and bad_purchase_returns=0 and bad_return_qty=0 and bad_refunds=0 and bad_payment_direction=0 and bad_settlements=0,
  'saleTotalViolations',bad_sales,'purchaseTotalViolations',bad_purchases,'negativeStock',bad_stock,
  'allocationViolations',bad_alloc,'stockProjectionViolations',bad_projection,'voidReversalViolations',bad_voids,
  'saleReturnViolations',bad_sale_returns,'purchaseReturnViolations',bad_purchase_returns,
  'returnQuantityViolations',bad_return_qty,'refundViolations',bad_refunds,'paymentDirectionViolations',bad_payment_direction,'settlementViolations',bad_settlements);
end
$function$;
