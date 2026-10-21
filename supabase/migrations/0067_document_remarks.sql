-- remarks: pending remarks on purchase bills and sale invoices (old DSB "pending items" notes).
-- A kirana owner uses them for: items the supplier still has to deliver (short supply), items a customer will
-- collect later, a rate or damaged item to sort out with the supplier, a follow-up call. A remark is a NOTE,
-- never money or stock: it posts nothing and changes no balance.
--  * document_remarks holds the current state of each remark (OPEN or SETTLED). It is written only by the RPCs
--    below (no client insert/update/delete); a remark is never deleted (deleted_at must stay null).
--  * document_remark_events is the append-only history. A trigger on document_remarks writes one event for
--    every insert and change (ADD, EDIT with the new text, SETTLE, REOPEN), so the history cannot be skipped;
--    events are never updated or deleted. Every earlier text of an edited remark stays in its events.
--  * Who: anyone who can see the document can add, edit their own open remark and settle (the person who
--    hands over the items marks them received/given). Owner/manager can also edit anyone's open remark and are
--    the only ones who can REOPEN a settled remark. Purchase remarks need purchase access (POST_PURCHASES or
--    VIEW_REPORTS, same as purchase bills); sale remarks need the shop to be visible.
--  * Idempotent add: client_id per tenant. The same id with the same document and text returns the same remark;
--    anything else with that id is DSB_PAYLOAD_MISMATCH. Edits carry the expected version (DSB_REMARK_STALE on a
--    concurrent change: never last-write-wins).
--  * Bill edits (0066): remarks stay on the bill they were written on. Reads follow the immutable links: a
--    remark on a replaced bill is shown on the corrected bill (edited_from_id ancestors) and list_open_remarks
--    opens the current bill (replaced_by_id chain). No remark row is moved or rewritten.

create table document_remarks(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 shop_id uuid not null,
 doc_kind text not null check(doc_kind in ('purchase','sale')),
 purchase_bill_id uuid,
 sale_invoice_id uuid,
 body text not null check(char_length(body) between 1 and 300 and body=btrim(body)),
 status text not null default 'OPEN' check(status in ('OPEN','SETTLED')),
 version integer not null default 1 check(version>=1),
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 settled_by uuid,
 settled_at timestamptz,
 updated_at bigint not null default 0,
 deleted_at bigint check(deleted_at is null),
 client_id text not null check(char_length(client_id) between 1 and 128),
 unique(tenant_id,client_id),
 unique(tenant_id,id),
 constraint document_remarks_doc_check check(
   (doc_kind='purchase' and purchase_bill_id is not null and sale_invoice_id is null)
   or (doc_kind='sale' and sale_invoice_id is not null and purchase_bill_id is null)),
 constraint document_remarks_settled_check check(
   (status='SETTLED')=(settled_at is not null) and (settled_at is null)=(settled_by is null)),
 foreign key(tenant_id,shop_id) references shops(tenant_id,id),
 foreign key(tenant_id,purchase_bill_id) references purchase_bills(tenant_id,id),
 foreign key(tenant_id,sale_invoice_id) references sale_invoices(tenant_id,id)
);
create index document_remarks_open_idx on document_remarks(tenant_id,shop_id,created_at) where status='OPEN';
create index document_remarks_purchase_idx on document_remarks(tenant_id,purchase_bill_id) where purchase_bill_id is not null;
create index document_remarks_sale_idx on document_remarks(tenant_id,sale_invoice_id) where sale_invoice_id is not null;

create table document_remark_events(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 shop_id uuid not null,
 remark_id uuid not null,
 doc_kind text not null check(doc_kind in ('purchase','sale')),
 version integer not null check(version>=1),
 action text not null check(action in ('ADD','EDIT','SETTLE','REOPEN')),
 body text not null,
 status text not null check(status in ('OPEN','SETTLED')),
 actor uuid,
 created_at timestamptz not null default now(),
 updated_at bigint not null default 0,
 deleted_at bigint check(deleted_at is null),
 client_id text not null default gen_random_uuid()::text,
 unique(tenant_id,client_id),
 unique(remark_id,version),
 foreign key(tenant_id,shop_id) references shops(tenant_id,id),
 foreign key(tenant_id,remark_id) references document_remarks(tenant_id,id)
);
create index document_remark_events_remark_idx on document_remark_events(tenant_id,remark_id,version);

-- Current state: never deleted; identity columns fixed; every change is exactly one version step.
create function dr_remark_guard() returns trigger language plpgsql set search_path=public as $$
begin
 if tg_op='DELETE' then raise exception 'DSB_REMARK_IMMUTABLE: a remark is never deleted; settle it instead'; end if;
 if tg_op='UPDATE' then
   if new.id<>old.id or new.tenant_id<>old.tenant_id or new.shop_id<>old.shop_id or new.doc_kind<>old.doc_kind
      or new.purchase_bill_id is distinct from old.purchase_bill_id or new.sale_invoice_id is distinct from old.sale_invoice_id
      or new.created_by<>old.created_by or new.created_at<>old.created_at or new.client_id<>old.client_id then
     raise exception 'DSB_REMARK_IMMUTABLE: a remark keeps its document, author and id';
   end if;
   if new.version<>old.version+1 or (new.body=old.body and new.status=old.status) then
     raise exception 'DSB_REMARK_IMMUTABLE: a remark changes one version at a time';
   end if;
 elsif new.version<>1 or new.status<>'OPEN' then
   raise exception 'DSB_REMARK_IMMUTABLE: a remark starts open at version 1';
 end if;
 return new;
end $$;

-- History is written here, for every insert and change, so no path can change a remark without an event.
create function dr_remark_history() returns trigger language plpgsql security definer set search_path=public as $$
begin
 insert into document_remark_events(tenant_id,shop_id,remark_id,doc_kind,version,action,body,status,actor)
 values(new.tenant_id,new.shop_id,new.id,new.doc_kind,new.version,
   case when tg_op='INSERT' then 'ADD'
        when new.status<>old.status and new.status='SETTLED' then 'SETTLE'
        when new.status<>old.status then 'REOPEN'
        else 'EDIT' end,
   new.body,new.status,auth.uid());
 return null;
end $$;

create function dr_event_guard() returns trigger language plpgsql set search_path=public as $$
begin
 raise exception 'DSB_REMARK_HISTORY_IMMUTABLE: remark history is never changed or deleted';
end $$;

create trigger document_remarks_guard before insert or update or delete on document_remarks
 for each row execute function dr_remark_guard();
create trigger document_remarks_set_updated_at before insert or update on document_remarks
 for each row execute function set_updated_at();
create trigger document_remarks_history after insert or update on document_remarks
 for each row execute function dr_remark_history();
create trigger audit_document_remarks after insert or update on document_remarks
 for each row execute function audit_row_change();
create trigger document_remark_events_set_updated_at before insert on document_remark_events
 for each row execute function set_updated_at();
create trigger document_remark_events_guard before update or delete on document_remark_events
 for each row execute function dr_event_guard();

revoke all on function dr_remark_guard() from public,anon,authenticated;
revoke all on function dr_remark_history() from public,anon,authenticated;
revoke all on function dr_event_guard() from public,anon,authenticated;

-- Reading follows the document's own read rule.
create function dr_can_see(p_shop uuid,p_kind text) returns boolean
language sql stable security definer set search_path=public as $$
 select current_tenant_id() is not null and c1_shop_visible(p_shop)
  and (p_kind='sale' or has_perm('POST_PURCHASES') or has_perm('VIEW_REPORTS'))
$$;
revoke all on function dr_can_see(uuid,text) from public,anon;
grant execute on function dr_can_see(uuid,text) to authenticated;

alter table document_remarks enable row level security;
alter table document_remark_events enable row level security;
create policy document_remarks_read on document_remarks for select using(
 tenant_id=current_tenant_id() and dr_can_see(shop_id,doc_kind));
create policy document_remark_events_read on document_remark_events for select using(
 tenant_id=current_tenant_id() and dr_can_see(shop_id,doc_kind));
revoke all on document_remarks from public,anon,authenticated;
revoke all on document_remark_events from public,anon,authenticated;
grant select on document_remarks to authenticated;
grant select on document_remark_events to authenticated;
do $$
begin
 if exists (select 1 from pg_roles where rolname='backup_ro') then
   grant select on document_remarks to backup_ro;
   grant select on document_remark_events to backup_ro;
 end if;
end $$;

-- The current (live) bill of a purchase bill: follows replaced_by_id (0066) to the end. Bounded walk.
create function dr_current_purchase(p_bill uuid) returns uuid
language plpgsql stable security definer set search_path=public as $$
declare v_id uuid:=p_bill; v_next uuid; v_n int:=0;
begin
 loop
   select replaced_by_id into v_next from purchase_bills where id=v_id and tenant_id=current_tenant_id();
   exit when v_next is null or v_n>=100;
   v_id:=v_next; v_n:=v_n+1;
 end loop;
 return v_id;
end $$;
revoke all on function dr_current_purchase(uuid) from public,anon,authenticated;

create function add_document_remark(p_shop_id uuid,p_doc_kind text,p_doc_id uuid,p_body text,p_client_id text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_body text:=btrim(coalesce(p_body,'')); v_row document_remarks%rowtype; v_id uuid;
begin
 if v_tenant is null then raise exception 'not authenticated'; end if;
 if p_doc_kind is null or p_doc_kind not in ('purchase','sale') then raise exception 'DSB_INVALID_REMARK: unknown document kind'; end if;
 if not exists(select 1 from shops where id=p_shop_id and tenant_id=v_tenant) or not dr_can_see(p_shop_id,p_doc_kind) then
   raise exception 'not permitted';
 end if;
 if char_length(v_body) not between 1 and 300 then raise exception 'DSB_INVALID_REMARK: write 1 to 300 characters'; end if;
 if p_client_id is null or char_length(p_client_id) not between 1 and 128 then raise exception 'DSB_INVALID_REMARK: request id missing'; end if;
 -- Same id again: same remark only for the same document and text.
 select * into v_row from document_remarks where tenant_id=v_tenant and client_id=p_client_id;
 if found then
   if v_row.shop_id=p_shop_id and v_row.doc_kind=p_doc_kind
      and coalesce(v_row.purchase_bill_id,v_row.sale_invoice_id)=p_doc_id
      and (select e.body from document_remark_events e where e.remark_id=v_row.id and e.version=1)=v_body then
     return v_row.id;
   end if;
   raise exception 'DSB_PAYLOAD_MISMATCH: this remark id was already used for another remark';
 end if;
 -- The document must be in this shop (KEY SHARE: it cannot vanish between the check and the insert).
 if p_doc_kind='purchase' then
   perform 1 from purchase_bills where id=p_doc_id and tenant_id=v_tenant and shop_id=p_shop_id and deleted_at is null for key share;
 else
   perform 1 from sale_invoices where id=p_doc_id and tenant_id=v_tenant and shop_id=p_shop_id and deleted_at is null for key share;
 end if;
 if not found then raise exception 'DSB_REMARK_DOC_NOT_FOUND: bill or invoice not found in this shop'; end if;
 insert into document_remarks(tenant_id,shop_id,doc_kind,purchase_bill_id,sale_invoice_id,body,client_id)
 values(v_tenant,p_shop_id,p_doc_kind,case when p_doc_kind='purchase' then p_doc_id end,
        case when p_doc_kind='sale' then p_doc_id end,v_body,p_client_id)
 on conflict(tenant_id,client_id) do nothing returning id into v_id;
 if v_id is null then
   -- A concurrent first send with this id won; answer as a retry would.
   return add_document_remark(p_shop_id,p_doc_kind,p_doc_id,p_body,p_client_id);
 end if;
 return v_id;
end $$;

-- Locks the remark and checks the caller may see it.
create function dr_lock_remark(p_remark_id uuid) returns document_remarks
language plpgsql security definer set search_path=public as $$
declare v_row document_remarks%rowtype;
begin
 if current_tenant_id() is null then raise exception 'not authenticated'; end if;
 select * into v_row from document_remarks where id=p_remark_id and tenant_id=current_tenant_id() for update;
 if not found or not dr_can_see(v_row.shop_id,v_row.doc_kind) then
   raise exception 'DSB_REMARK_NOT_FOUND: remark not found';
 end if;
 return v_row;
end $$;
revoke all on function dr_lock_remark(uuid) from public,anon,authenticated;

create function edit_document_remark(p_remark_id uuid,p_body text,p_expected_version integer)
returns integer language plpgsql security definer set search_path=public as $$
declare v_row document_remarks%rowtype; v_body text:=btrim(coalesce(p_body,''));
begin
 v_row:=dr_lock_remark(p_remark_id);
 if v_row.created_by<>auth.uid() and coalesce("current_role"(),'') not in ('owner','manager') then
   raise exception 'not permitted';
 end if;
 if char_length(v_body) not between 1 and 300 then raise exception 'DSB_INVALID_REMARK: write 1 to 300 characters'; end if;
 if v_row.version=p_expected_version+1 and v_row.body=v_body
    and (select e.actor from document_remark_events e where e.remark_id=v_row.id and e.version=v_row.version)=auth.uid() then
   return v_row.version; -- exact retry by the person who made that change
 end if;
 if v_row.status<>'OPEN' then raise exception 'DSB_REMARK_SETTLED: reopen the remark before changing it'; end if;
 if v_row.version<>p_expected_version then
   raise exception 'DSB_REMARK_STALE: the remark was changed by someone else; reload it';
 end if;
 if v_row.body=v_body then return v_row.version; end if;
 update document_remarks set body=v_body,version=version+1 where id=p_remark_id;
 return v_row.version+1;
end $$;

create function settle_document_remark(p_remark_id uuid) returns integer
language plpgsql security definer set search_path=public as $$
declare v_row document_remarks%rowtype;
begin
 v_row:=dr_lock_remark(p_remark_id);
 if v_row.status='SETTLED' then return v_row.version; end if; -- idempotent
 update document_remarks set status='SETTLED',settled_by=auth.uid(),settled_at=now(),version=version+1 where id=p_remark_id;
 return v_row.version+1;
end $$;

create function reopen_document_remark(p_remark_id uuid) returns integer
language plpgsql security definer set search_path=public as $$
declare v_row document_remarks%rowtype;
begin
 v_row:=dr_lock_remark(p_remark_id);
 if coalesce("current_role"(),'') not in ('owner','manager') then raise exception 'not permitted'; end if;
 if v_row.status='OPEN' then return v_row.version; end if; -- idempotent
 update document_remarks set status='OPEN',settled_by=null,settled_at=null,version=version+1 where id=p_remark_id;
 return v_row.version+1;
end $$;

-- Remarks of one document, including those written on the bills it corrected (edited_from_id ancestors).
create function list_document_remarks(p_doc_kind text,p_doc_id uuid)
returns table(remark_id uuid,doc_id uuid,from_earlier_bill boolean,body text,status text,version integer,
              created_by uuid,created_at timestamptz,settled_by uuid,settled_at timestamptz)
language plpgsql stable security definer set search_path=public as $$
begin
 if current_tenant_id() is null then raise exception 'not authenticated'; end if;
 if p_doc_kind='purchase' then
   return query
   with recursive chain(id,depth) as (
     select b.id,0 from purchase_bills b where b.id=p_doc_id and b.tenant_id=current_tenant_id()
     union all
     select b.edited_from_id,c.depth+1 from chain c join purchase_bills b on b.id=c.id and b.tenant_id=current_tenant_id()
     where b.edited_from_id is not null and c.depth<100)
   select r.id,r.purchase_bill_id,r.purchase_bill_id<>p_doc_id,r.body,r.status,r.version,r.created_by,r.created_at,r.settled_by,r.settled_at
   from chain c join document_remarks r on r.tenant_id=current_tenant_id() and r.purchase_bill_id=c.id
   where dr_can_see(r.shop_id,r.doc_kind)
   order by r.created_at,r.id;
 elsif p_doc_kind='sale' then
   return query
   select r.id,r.sale_invoice_id,false,r.body,r.status,r.version,r.created_by,r.created_at,r.settled_by,r.settled_at
   from document_remarks r where r.tenant_id=current_tenant_id() and r.sale_invoice_id=p_doc_id and dr_can_see(r.shop_id,r.doc_kind)
   order by r.created_at,r.id;
 else
   raise exception 'DSB_INVALID_REMARK: unknown document kind';
 end if;
end $$;

-- Open remarks of a shop, oldest first, with the document to open (a replaced bill opens its corrected bill).
create function list_open_remarks(p_shop_id uuid)
returns table(remark_id uuid,doc_kind text,doc_id uuid,doc_no text,party_name text,business_date date,
              doc_status text,body text,created_at timestamptz,version integer)
language plpgsql stable security definer set search_path=public as $$
begin
 if current_tenant_id() is null then raise exception 'not authenticated'; end if;
 if not exists(select 1 from shops where id=p_shop_id and tenant_id=current_tenant_id()) or not c1_shop_visible(p_shop_id) then
   raise exception 'not permitted';
 end if;
 return query
 with r as (
   select x.*,case when x.doc_kind='purchase' then dr_current_purchase(x.purchase_bill_id) else x.sale_invoice_id end cur
   from document_remarks x
   where x.tenant_id=current_tenant_id() and x.shop_id=p_shop_id and x.status='OPEN' and dr_can_see(x.shop_id,x.doc_kind))
 select r.id,r.doc_kind,r.cur,
   coalesce(pb.bill_no,si.doc_no),coalesce(pa.name,cu.name),coalesce(pb.business_date,si.business_date),
   coalesce(pb.status,si.status),r.body,r.created_at,r.version
 from r
 left join purchase_bills pb on r.doc_kind='purchase' and pb.id=r.cur and pb.tenant_id=r.tenant_id
 left join parties pa on pa.id=pb.party_id and pa.tenant_id=r.tenant_id
 left join sale_invoices si on r.doc_kind='sale' and si.id=r.cur and si.tenant_id=r.tenant_id
 left join customers cu on cu.id=si.customer_id and cu.tenant_id=r.tenant_id
 order by r.created_at,r.id
 limit 500;
end $$;

revoke all on function add_document_remark(uuid,text,uuid,text,text) from public,anon;
revoke all on function edit_document_remark(uuid,text,integer) from public,anon;
revoke all on function settle_document_remark(uuid) from public,anon;
revoke all on function reopen_document_remark(uuid) from public,anon;
revoke all on function list_document_remarks(text,uuid) from public,anon;
revoke all on function list_open_remarks(uuid) from public,anon;
grant execute on function add_document_remark(uuid,text,uuid,text,text) to authenticated;
grant execute on function edit_document_remark(uuid,text,integer) to authenticated;
grant execute on function settle_document_remark(uuid) to authenticated;
grant execute on function reopen_document_remark(uuid) to authenticated;
grant execute on function list_document_remarks(text,uuid) to authenticated;
grant execute on function list_open_remarks(uuid) to authenticated;

-- The business export carries remarks and their full history (the coverage test fails on any unexported table).
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
  'partyMerges',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from party_merges where tenant_id=v_tenant) x),'[]'::jsonb),
  'purchaseCharges',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from purchase_bill_charges where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'purchaseImages',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from purchase_bill_images where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'documentRemarks',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (select * from document_remarks where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb),
  'documentRemarkEvents',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.version,x.id) from (select * from document_remark_events where tenant_id=v_tenant and shop_id=p_shop_id) x),'[]'::jsonb)
 );
end $$;
