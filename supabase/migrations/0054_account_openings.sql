-- Packet O1 (group o1): opening balances (user decision 2026-10-02: old DSB retired; DSB Pro starts from
-- manually entered opening dues as of a cutover date). Design: COMPLETE_REMAINING_BUILD_PLAN v1.1 §15.1
-- account_openings, without settlements/credit applications (deferred to O2): until then a later payment
-- against an opening shows as unassigned cash beside the opening, and the net balance is exact.
-- Sign: positive = the account owes/we owe as for its ledger (customer: customer owes the shop;
-- supplier: shop owes the supplier); negative = credit the other way.
create table account_openings(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 shop_id uuid not null,
 account_kind text not null check(account_kind in ('CUSTOMER','SUPPLIER')),
 customer_id uuid,
 party_id uuid,
 as_of_date date not null,
 amount_paise bigint not null check(amount_paise<>0 and abs(amount_paise)<=100000000000000),
 status text not null default 'POSTED' check(status in ('POSTED','VOID')),
 reason text not null check(char_length(btrim(reason)) between 1 and 500),
 void_reason text check(void_reason is null or char_length(btrim(void_reason)) between 1 and 500),
 voided_at timestamptz,
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at bigint not null default 0,
 deleted_at bigint,
 client_id text not null check(char_length(client_id) between 1 and 128),
 unique(tenant_id,client_id),
 unique(tenant_id,id),
 foreign key(tenant_id,shop_id) references shops(tenant_id,id),
 foreign key(tenant_id,customer_id) references customers(tenant_id,id),
 foreign key(tenant_id,party_id) references parties(tenant_id,id),
 check((account_kind='CUSTOMER' and customer_id is not null and party_id is null)
    or (account_kind='SUPPLIER' and party_id is not null and customer_id is null)),
 check((status='VOID')=(voided_at is not null and void_reason is not null))
);
-- One active opening per account per shop; a voided one may be replaced by a corrected one.
create unique index account_openings_one_customer on account_openings(tenant_id,shop_id,customer_id)
  where status='POSTED' and account_kind='CUSTOMER';
create unique index account_openings_one_party on account_openings(tenant_id,shop_id,party_id)
  where status='POSTED' and account_kind='SUPPLIER';

create function o1_opening_guard() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' then raise exception 'account opening is immutable; void it instead'; end if;
 if old.status='POSTED' and new.status='VOID'
    and new.tenant_id=old.tenant_id and new.shop_id=old.shop_id and new.account_kind=old.account_kind
    and new.customer_id is not distinct from old.customer_id and new.party_id is not distinct from old.party_id
    and new.as_of_date=old.as_of_date and new.amount_paise=old.amount_paise and new.reason=old.reason
    and new.client_id=old.client_id and new.created_by=old.created_by and new.created_at=old.created_at
    and new.voided_at is not null and new.void_reason is not null then
   return new;
 end if;
 raise exception 'account opening is immutable; void it instead';
end $$;
create trigger account_openings_set_updated_at before insert or update on account_openings
 for each row execute function set_updated_at();
create trigger account_openings_guard before update or delete on account_openings
 for each row execute function o1_opening_guard();
create trigger audit_account_openings after insert or update on account_openings
 for each row execute function audit_row_change();

alter table account_openings enable row level security;
create policy account_openings_read on account_openings for select using(
 tenant_id=current_tenant_id() and c1_shop_visible(shop_id)
 and ((account_kind='CUSTOMER' and (has_perm('POST_SALES') or has_perm('VIEW_REPORTS')))
   or (account_kind='SUPPLIER' and (has_perm('POST_PURCHASES') or has_perm('VIEW_REPORTS')))));
revoke all on account_openings from public,anon,authenticated;
grant select on account_openings to authenticated;
do $$
begin
 if exists (select 1 from pg_roles where rolname='backup_ro') then
   grant select on account_openings to backup_ro;
 end if;
end $$;

-- Owner only. Idempotent by client id: an exact replay returns the same id; a different payload under the
-- same id is refused. The shop finance lock serializes it with every other money writer.
create function record_account_opening(p_shop_id uuid,p_account_kind text,p_account_id uuid,
 p_as_of_date date,p_amount_paise bigint,p_reason text,p_client_id text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_kind text:=upper(btrim(coalesce(p_account_kind,''))); v_row account_openings%rowtype;
begin
 if coalesce("current_role"(),'')<>'owner' then raise exception 'not permitted'; end if;
 v_tenant:=phase3_assert_shop(p_shop_id);
 if p_client_id is null or char_length(btrim(p_client_id)) not between 1 and 128 then raise exception 'DSB_INVALID_REQUEST: client id required'; end if;
 perform dsb_lock_shop_finance(v_tenant,p_shop_id);
 select * into v_row from account_openings where tenant_id=v_tenant and client_id=p_client_id;
 if found then
   if v_row.shop_id=p_shop_id and v_row.account_kind=v_kind
      and coalesce(v_row.customer_id,v_row.party_id)=p_account_id and v_row.as_of_date=p_as_of_date
      and v_row.amount_paise=p_amount_paise and v_row.reason=btrim(p_reason) then
     return v_row.id;
   end if;
   raise exception 'DSB_PAYLOAD_MISMATCH: client_id already used for a different opening';
 end if;
 if v_kind not in ('CUSTOMER','SUPPLIER') then raise exception 'DSB_INVALID_ACCOUNT: account kind must be CUSTOMER or SUPPLIER'; end if;
 if p_as_of_date is null then raise exception 'DSB_INVALID_DATE: as-of date required'; end if;
 if p_as_of_date>shop_business_date(p_shop_id) then raise exception 'DSB_FUTURE_DATE: as-of date is after today'; end if;
 if p_amount_paise is null or p_amount_paise=0 then raise exception 'DSB_INVALID_AMOUNT: opening amount must not be zero'; end if;
 if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then raise exception 'DSB_INVALID_REASON: reason required (1-500 characters)'; end if;
 if v_kind='CUSTOMER' and not exists(select 1 from customers where tenant_id=v_tenant and id=p_account_id and deleted_at is null) then
   raise exception 'DSB_ACCOUNT_UNAVAILABLE: customer unavailable';
 end if;
 if v_kind='SUPPLIER' and not exists(select 1 from parties where tenant_id=v_tenant and id=p_account_id and deleted_at is null) then
   raise exception 'DSB_ACCOUNT_UNAVAILABLE: supplier unavailable';
 end if;
 if exists(select 1 from account_openings where tenant_id=v_tenant and shop_id=p_shop_id and status='POSTED'
    and account_kind=v_kind and coalesce(customer_id,party_id)=p_account_id) then
   raise exception 'DSB_OPENING_EXISTS: this account already has an opening balance; void it first to correct it';
 end if;
 insert into account_openings(tenant_id,shop_id,account_kind,customer_id,party_id,as_of_date,amount_paise,reason,client_id)
 values(v_tenant,p_shop_id,v_kind,case when v_kind='CUSTOMER' then p_account_id end,
   case when v_kind='SUPPLIER' then p_account_id end,p_as_of_date,p_amount_paise,btrim(p_reason),p_client_id)
 returning * into v_row;
 return v_row.id;
end $$;

create function void_account_opening(p_opening_id uuid,p_reason text) returns uuid
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
 update account_openings set status='VOID',voided_at=now(),void_reason=btrim(p_reason) where id=v_row.id;
 return v_row.id;
end $$;
revoke all on function record_account_opening(uuid,text,uuid,date,bigint,text,text) from public,anon;
revoke all on function void_account_opening(uuid,text) from public,anon;
grant execute on function record_account_opening(uuid,text,uuid,date,bigint,text,text) to authenticated;
grant execute on function void_account_opening(uuid,text) to authenticated;

-- Customer ledger (from 0036): + opening rows. Columns unchanged, so customer_balances follows.
create or replace view customer_ledger with(security_invoker=true) as
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
 from sale_returns where customer_id is not null and status='POSTED' and deleted_at is null
 union all
 select tenant_id,customer_id,as_of_date,created_at,'OPENING'::text entry_type,id ref_id,'Opening balance'::text reference,
   greatest(amount_paise,0)::bigint debit_paise,greatest(-amount_paise,0)::bigint credit_paise
 from account_openings where account_kind='CUSTOMER' and status='POSTED' and deleted_at is null;

-- Supplier ledger, supplier summary and both aging reports (live definitions, + opening rows).
CREATE OR REPLACE FUNCTION public.get_party_ledger_v2(p_shop_id uuid, p_party_id uuid, p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_tenant uuid:=c1_assert_supplier_read(p_shop_id); v_result jsonb;
begin
 if not exists(select 1 from parties where tenant_id=v_tenant and id=p_party_id) then raise exception 'DSB_PARTY_UNAVAILABLE: supplier unavailable'; end if;
 with entries as (
   select business_date entry_date,'PURCHASE' kind,coalesce(bill_no,id::text) document,total_paise::numeric amount,created_at created,id
     from purchase_bills where tenant_id=v_tenant and shop_id=p_shop_id and party_id=p_party_id and status='POSTED'
   union all
   select business_date,'PURCHASE_RETURN',doc_no,-total_paise::numeric,created_at,id from purchase_returns
     where tenant_id=v_tenant and shop_id=p_shop_id and party_id=p_party_id and status='POSTED'
   union all
   select business_date,case when direction='out' then 'PAYMENT_MADE' else 'PAYMENT_RECEIVED' end,coalesce(reference,id::text),
     case when direction='out' then -amount_paise else amount_paise end::numeric,created_at,id from payments
     where tenant_id=v_tenant and shop_id=p_shop_id and party_id=p_party_id and kind='party' and status='POSTED'
   union all
   -- (no soft-removal filter: the C2 safeupdate test bans that word in this body; openings are never removed)
   select as_of_date,'OPENING_BALANCE','Opening balance',amount_paise::numeric,created_at,id from account_openings
     where tenant_id=v_tenant and shop_id=p_shop_id and party_id=p_party_id and account_kind='SUPPLIER' and status='POSTED'
 ), opening as (
   select coalesce(sum(amount),0) v from entries where p_from is not null and entry_date<p_from
 ), windowed as (
   select e.*,sum(amount) over(order by entry_date,created,id) run from entries e
   where (p_from is null or entry_date>=p_from) and (p_to is null or entry_date<=p_to)
 )
 select jsonb_build_object('shopId',p_shop_id,'partyId',p_party_id,'from',p_from,'to',p_to,
   'openingBalancePaise',o.v::text,
   'entries',coalesce((select jsonb_agg(jsonb_build_object('date',w.entry_date,'kind',w.kind,'document',w.document,'id',w.id,
      'amountPaise',w.amount::text,'runningBalancePaise',(o.v+w.run)::text) order by w.entry_date,w.created,w.id) from windowed w),'[]'::jsonb),
   'closingBalancePaise',(o.v+coalesce((select sum(amount) from windowed),0))::text,
   'signConvention','positive = amount owed to supplier')
 into v_result from opening o;
 return v_result;
end $function$;

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
     where a.tenant_id=p.tenant_id and a.payment_id=p.id and a.status='POSTED'),0)) unallocated
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
   select party_id,sum(greatest(amount_paise,0)) pos,sum(greatest(-amount_paise,0)) neg from account_openings
   where tenant_id=v_tenant and shop_id=p_shop_id and account_kind='SUPPLIER' and status='POSTED' and deleted_at is null group by party_id
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
   -- O1: openings have no settlements yet, so the whole opening remains (O2 adds settlements).
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
  select o.customer_id,o.id,'Opening balance',o.as_of_date,o.amount_paise,0,0,o.amount_paise,false
  from account_openings o where o.tenant_id=v_tenant and o.shop_id=p_shop_id and o.account_kind='CUSTOMER'
    and o.status='POSTED' and o.deleted_at is null and o.as_of_date<=p_as_of
 ), cash as (
  select customer_id,sum(ua_in) ua_in,sum(ua_out) ua_out,sum(rcpt_total) rcpt_total from (
   select r.customer_id,r.amount_paise-coalesce(ap.v,0) ua_in,0 ua_out,r.amount_paise rcpt_total
   from rcpt r left join alloc_pay ap on ap.payment_id=r.id
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
  select o.party_id,o.id,'Opening balance',o.as_of_date,o.amount_paise,o.amount_paise,false
  from account_openings o where o.tenant_id=v_tenant and o.shop_id=p_shop_id and o.account_kind='SUPPLIER'
    and o.status='POSTED' and o.deleted_at is null and o.as_of_date<=p_as_of
 ), cash as (
  select party_id,sum(ua_out) ua_out,sum(ua_in) ua_in,sum(paid_total) paid_total from (
   select q.party_id,q.amount_paise-coalesce(ap.v,0) ua_out,0 ua_in,q.amount_paise paid_total
   from paid q left join alloc_pay ap on ap.payment_id=q.id
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

-- Export (from 0036): + accountOpenings.
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
  'accountOpenings',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from account_openings where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb)
 );
end $$;
