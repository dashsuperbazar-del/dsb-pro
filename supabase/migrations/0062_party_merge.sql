-- partymerge: merge a duplicate supplier into the one to keep (old DSB openMergeParty/confirmMergeParty).
-- Owner rule (2026-10-18): a merge KEEPS both suppliers' data. Nothing is deleted or summed: every bill,
-- payment, return, opening balance and payment schedule of the duplicate is re-attributed to the kept
-- supplier, the duplicate is archived, and party_merges records exactly which rows moved (plus the row
-- audit trail). Identical-looking bills are not cleaned automatically: get_supplier_duplicate_bills lists
-- them and the owner voids a real duplicate through the normal audited void.
-- Money safety:
--  * Amounts, dates, statuses and allocations never change; only party_id moves, and only inside
--    merge_parties (the guards below allow a party-only change solely for the merge in progress).
--  * Two POSTED opening balances in one shop cannot both live on one supplier: the merge is refused and
--    the owner decides (void one, record the combined opening). Never summed silently.
--  * An offline purchase retry that still names the duplicate is recognised (dsb_party_canonical), so a
--    committed bill is acknowledged instead of rejected and re-entered. Payment and return retries compare
--    their stored request, which the merge does not touch.
--  * Every shop finance lock and both supplier rows are held for the whole merge, so no posting can
--    interleave; new documents for the archived duplicate are refused by dsb_live_party_guard.

create table party_merges(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 source_party_id uuid not null,
 target_party_id uuid not null,
 source_name text not null,
 target_name text not null,
 moved jsonb not null,
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at bigint not null default 0,
 deleted_at bigint,
 client_id text not null check(char_length(client_id) between 1 and 128),
 unique(tenant_id,client_id),
 unique(tenant_id,id),
 unique(tenant_id,source_party_id),
 check(source_party_id<>target_party_id),
 foreign key(tenant_id,source_party_id) references parties(tenant_id,id),
 foreign key(tenant_id,target_party_id) references parties(tenant_id,id)
);
create index party_merges_target_idx on party_merges(tenant_id,target_party_id);

create function party_merge_immutable() returns trigger language plpgsql as $$
begin
 raise exception 'a supplier merge record is immutable';
end $$;
create trigger party_merges_set_updated_at before insert on party_merges
 for each row execute function set_updated_at();
create trigger party_merges_immutable before update or delete on party_merges
 for each row execute function party_merge_immutable();
create trigger audit_party_merges after insert on party_merges
 for each row execute function audit_row_change();

alter table party_merges enable row level security;
create policy party_merges_read on party_merges for select using(
 tenant_id=current_tenant_id() and (has_perm('MANAGE_MASTER_DATA') or has_perm('VIEW_REPORTS')));
revoke all on party_merges from public,anon,authenticated;
grant select on party_merges to authenticated;
do $$
begin
 if exists (select 1 from pg_roles where rolname='backup_ro') then
   grant select on party_merges to backup_ro;
 end if;
end $$;

-- The supplier a (possibly merged) supplier now lives under. Follows a chain A->B->C.
create function dsb_party_canonical(p_party_id uuid) returns uuid
language plpgsql stable security definer set search_path=public as $$
declare v_id uuid:=p_party_id; v_next uuid; i int:=0;
begin
 loop
   select target_party_id into v_next from party_merges where source_party_id=v_id;
   exit when not found or v_next is null;
   v_id:=v_next; i:=i+1;
   if i>64 then raise exception 'supplier merge chain too long'; end if;
 end loop;
 return v_id;
end $$;

-- True only inside merge_parties, for the one source->target move it announced, when nothing but
-- party_id (and the server-set updated_at) changes.
create function dsb_party_merge_move(p_old anyelement,p_new anyelement) returns boolean
language plpgsql stable as $$
declare o jsonb:=to_jsonb(p_old); n jsonb:=to_jsonb(p_new);
begin
 return coalesce(current_setting('dsb.party_merge',true),'')<>''
  and current_setting('dsb.party_merge',true)=(o->>'party_id')||'>'||(n->>'party_id')
  and (o-'party_id'-'updated_at')=(n-'party_id'-'updated_at');
end $$;

create or replace function phase4_payment_guard() returns trigger language plpgsql as $$
begin
 if dsb_party_merge_move(old,new) then return new; end if;
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

create or replace function phase65_purchase_return_guard() returns trigger language plpgsql as $$
begin
 if dsb_party_merge_move(old,new) then return new; end if;
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

create or replace function o1_opening_guard() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' then raise exception 'account opening is immutable; void it instead'; end if;
 if dsb_party_merge_move(old,new) then return new; end if;
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

create function merge_parties(p_source_party_id uuid,p_target_party_id uuid,p_client_id text) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_prev party_merges%rowtype; v_src parties%rowtype; v_dst parties%rowtype;
 v_shop uuid; v_now bigint:=(extract(epoch from clock_timestamp())*1000)::bigint; v_id uuid;
 v_bills uuid[]; v_payments uuid[]; v_returns uuid[]; v_openings uuid[]; v_schedules uuid[]; v_removed uuid[];
begin
 if not has_perm('MANAGE_MASTER_DATA') then raise exception 'not permitted'; end if;
 if v_tenant is null then raise exception 'not permitted'; end if;
 if p_client_id is null or char_length(btrim(p_client_id)) not between 1 and 128 then
   raise exception 'DSB_INVALID_MERGE: a request id is required';
 end if;
 if p_source_party_id is null or p_target_party_id is null or p_source_party_id=p_target_party_id then
   raise exception 'DSB_INVALID_MERGE: choose two different suppliers';
 end if;
 -- Every shop's finance lock (fixed order), then both suppliers (fixed order): nothing posts meanwhile.
 for v_shop in select id from shops where tenant_id=v_tenant order by id loop
   perform dsb_lock_shop_finance(v_tenant,v_shop);
 end loop;
 perform 1 from parties where tenant_id=v_tenant and id in (p_source_party_id,p_target_party_id) order by id for update;
 select * into v_prev from party_merges where tenant_id=v_tenant and client_id=p_client_id;
 if found then
   if v_prev.source_party_id<>p_source_party_id or v_prev.target_party_id<>p_target_party_id then
     raise exception 'DSB_PAYLOAD_MISMATCH: request id already used for a different merge';
   end if;
   return v_prev.id;
 end if;
 select * into v_src from parties where tenant_id=v_tenant and id=p_source_party_id;
 if not found then raise exception 'DSB_PARTY_NOT_FOUND: supplier not found'; end if;
 select * into v_dst from parties where tenant_id=v_tenant and id=p_target_party_id;
 if not found then raise exception 'DSB_PARTY_NOT_FOUND: supplier not found'; end if;
 if v_src.deleted_at is not null or v_dst.deleted_at is not null then
   raise exception 'DSB_PARTY_ARCHIVED: an archived supplier cannot be merged';
 end if;
 if exists(select 1 from account_openings a join account_openings b
     on b.tenant_id=a.tenant_id and b.shop_id=a.shop_id and b.party_id=p_target_party_id
       and b.account_kind='SUPPLIER' and b.status='POSTED'
   where a.tenant_id=v_tenant and a.party_id=p_source_party_id and a.account_kind='SUPPLIER' and a.status='POSTED') then
   raise exception 'DSB_MERGE_OPENING_CONFLICT: both suppliers have an opening balance in the same shop; void one and record the combined opening first';
 end if;

 perform set_config('dsb.party_merge',p_source_party_id::text||'>'||p_target_party_id::text,true);
 with m as (update purchase_bills set party_id=p_target_party_id
   where tenant_id=v_tenant and party_id=p_source_party_id returning id)
 select coalesce(array_agg(id order by id),'{}') into v_bills from m;
 with m as (update payments set party_id=p_target_party_id
   where tenant_id=v_tenant and party_id=p_source_party_id returning id)
 select coalesce(array_agg(id order by id),'{}') into v_payments from m;
 with m as (update purchase_returns set party_id=p_target_party_id
   where tenant_id=v_tenant and party_id=p_source_party_id returning id)
 select coalesce(array_agg(id order by id),'{}') into v_returns from m;
 with m as (update account_openings set party_id=p_target_party_id
   where tenant_id=v_tenant and party_id=p_source_party_id returning id)
 select coalesce(array_agg(id order by id),'{}') into v_openings from m;
 perform set_config('dsb.party_merge','',true);
 -- A reminder, not money: where the kept supplier already has a live schedule in a shop, the duplicate's
 -- schedule there is removed (kept as history), then all of the duplicate's schedules move.
 with m as (update supplier_payment_schedules s set deleted_at=v_now
   where s.tenant_id=v_tenant and s.party_id=p_source_party_id and s.deleted_at is null
     and exists(select 1 from supplier_payment_schedules t where t.tenant_id=v_tenant and t.shop_id=s.shop_id
       and t.party_id=p_target_party_id and t.deleted_at is null) returning s.id)
 select coalesce(array_agg(id order by id),'{}') into v_removed from m;
 with m as (update supplier_payment_schedules set party_id=p_target_party_id
   where tenant_id=v_tenant and party_id=p_source_party_id returning id)
 select coalesce(array_agg(id order by id),'{}') into v_schedules from m;

 update parties set deleted_at=v_now where id=p_source_party_id;
 insert into party_merges(tenant_id,source_party_id,target_party_id,source_name,target_name,moved,client_id)
 values(v_tenant,p_source_party_id,p_target_party_id,v_src.name,v_dst.name,
   jsonb_build_object('purchaseBills',to_jsonb(v_bills),'payments',to_jsonb(v_payments),
     'purchaseReturns',to_jsonb(v_returns),'accountOpenings',to_jsonb(v_openings),
     'paymentSchedules',to_jsonb(v_schedules),'paymentSchedulesRemoved',to_jsonb(v_removed)),
   p_client_id)
 returning id into v_id;
 return v_id;
end $$;

-- Self-check after a merge: POSTED bills of one supplier that are identical (same date, total and bill
-- number, blank counting as blank). Read-only; a real duplicate is voided through the normal void.
create function get_supplier_duplicate_bills(p_shop_id uuid,p_party_id uuid) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=c1_assert_supplier_read(p_shop_id);
begin
 return coalesce((select jsonb_agg(jsonb_build_object('billNo',g.bill_no,'businessDate',g.business_date,
     'totalPaise',g.total_paise::text,'billIds',g.ids) order by g.business_date desc,g.bill_no)
   from (select coalesce(nullif(lower(btrim(bill_no)),''),'') bill_no,business_date,total_paise,
           jsonb_agg(id order by created_at,id) ids
         from purchase_bills where tenant_id=v_tenant and shop_id=p_shop_id and party_id=p_party_id and status='POSTED'
         group by 1,2,3 having count(*)>1) g),'[]'::jsonb);
end $$;


-- A purchase retry that names a merged supplier is the same purchase (the bill now lives under the kept one).
create or replace function post_purchase(
 p_shop_id uuid,p_party_id uuid,p_bill_no text,p_business_date date,p_discount_paise bigint,p_extra_charges_paise bigint,
 p_client_id text,p_lines jsonb,p_bill_image_path text default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_bill purchase_bills%rowtype; v_stored jsonb; v_given jsonb;
begin
 if not has_perm('POST_PURCHASES') then raise exception 'not permitted'; end if;
 v_tenant:=phase3_assert_shop(p_shop_id);
 perform dsb_lock_shop_finance(v_tenant,p_shop_id);
 if p_client_id is not null and btrim(p_client_id)<>'' then
   perform pg_advisory_xact_lock(hashtextextended(v_tenant::text||':purchase:'||p_client_id,0));
   select * into v_bill from purchase_bills where tenant_id=v_tenant and client_id=p_client_id;
   if found then
     select coalesce(jsonb_agg(jsonb_build_array(i.item_id::text,i.unit_level::int,round(i.qty,6),i.unit_price_paise) order by i.line_no),'[]'::jsonb)
       into v_stored from purchase_bill_items i where i.tenant_id=v_tenant and i.purchase_bill_id=v_bill.id;
     begin
       -- Normalized exactly as the body stores it: unit_level defaults to 1, qty is numeric(18,6).
       select coalesce(jsonb_agg(jsonb_build_array(lower(e->>'item_id'),coalesce((e->>'unit_level')::int,1),round((e->>'qty')::numeric,6),
         (e->>'unit_price_paise')::bigint) order by o),'[]'::jsonb)
         into v_given from jsonb_array_elements(p_lines) with ordinality x(e,o);
     exception when others then v_given:=null;
     end;
     if v_given is null or v_bill.shop_id<>p_shop_id or (v_bill.party_id is distinct from p_party_id and v_bill.party_id is distinct from dsb_party_canonical(p_party_id))
        or coalesce(nullif(btrim(v_bill.bill_no),''),'') is distinct from coalesce(nullif(btrim(p_bill_no),''),'')
        or (p_business_date is not null and v_bill.business_date<>p_business_date)
        or v_bill.discount_paise<>coalesce(p_discount_paise,0) or v_bill.extra_charges_paise<>coalesce(p_extra_charges_paise,0)
        or (v_bill.bill_image_path is distinct from p_bill_image_path)
        or v_stored<>v_given then
       raise exception 'DSB_PAYLOAD_MISMATCH: client_id already used for a different purchase';
     end if;
     return v_bill.id;
   end if;
 end if;
 if p_bill_image_path is not null then
   if p_bill_image_path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(webp|jpg|png|pdf)$'
      or split_part(p_bill_image_path,'/',1)<>v_tenant::text
      or split_part(p_bill_image_path,'/',2)<>p_shop_id::text
      or split_part(p_bill_image_path,'/',3) is distinct from p_client_id
      or not exists(select 1 from storage.objects o where o.bucket_id='bill-documents' and o.name=p_bill_image_path
         and o.metadata->>'mimetype'=case when right(p_bill_image_path,4)='.pdf' then 'application/pdf'
           when right(p_bill_image_path,4)='.jpg' then 'image/jpeg' when right(p_bill_image_path,4)='.png' then 'image/png' else 'image/webp' end
         and coalesce(o.metadata->>'size','') ~ '^[0-9]+$'
         and case when coalesce(o.metadata->>'size','') ~ '^[0-9]+$' then (o.metadata->>'size')::numeric else 0 end between 1 and 5242880)
   then raise exception 'DSB_BILL_DOCUMENT_INVALID: upload a document for this purchase before posting'; end if;
 end if;
 return c0_post_purchase_body(p_shop_id,p_party_id,p_bill_no,p_business_date,p_discount_paise,p_extra_charges_paise,p_client_id,p_lines,p_bill_image_path);
end $$;

-- The business export carries the merge records (tenant-wide, like parties).
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
  'supplierPaymentSchedules',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from supplier_payment_schedules where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'partyMerges',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from party_merges where tenant_id=v_tenant) x),'[]'::jsonb)
 );
end $$;

revoke all on function party_merge_immutable() from public;
revoke all on function dsb_party_canonical(uuid) from public,anon,authenticated;
revoke all on function dsb_party_merge_move(anyelement,anyelement) from public,anon;
grant execute on function dsb_party_merge_move(anyelement,anyelement) to authenticated;
revoke all on function merge_parties(uuid,uuid,text) from public,anon;
revoke all on function get_supplier_duplicate_bills(uuid,uuid) from public,anon;
grant execute on function merge_parties(uuid,uuid,text) to authenticated;
grant execute on function get_supplier_duplicate_bills(uuid,uuid) to authenticated;
