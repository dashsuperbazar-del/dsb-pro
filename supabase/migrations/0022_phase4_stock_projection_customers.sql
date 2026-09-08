-- Phase 4 foundation: lockable stock projection + customer master.
-- stock_movements remains the only stock truth; stock_current is only a trigger-maintained projection.

insert into permissions(code,description) values
 ('MANAGE_CUSTOMERS','Create and update customer master data'),
 ('POST_SALES','Finalize sales and collect customer payments'),
 ('VOID_SALES','Void finalized sales and payments')
on conflict(code) do nothing;
insert into role_permissions(role,code) values
 ('owner','MANAGE_CUSTOMERS'),('manager','MANAGE_CUSTOMERS'),('cashier','MANAGE_CUSTOMERS'),
 ('owner','POST_SALES'),('manager','POST_SALES'),('cashier','POST_SALES'),
 ('owner','VOID_SALES')
on conflict do nothing;

create table customers(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 name text not null,
 normalized_name text generated always as (lower(regexp_replace(btrim(name),'[[:space:]]+',' ','g'))) stored,
 phone text, address text, gstin text,
 credit_limit_paise bigint not null default 0 check(credit_limit_paise>=0),
 notes text,
 created_by uuid not null default auth.uid(), created_at timestamptz not null default now(),
 updated_at bigint not null default 0, deleted_at bigint, client_id text,
 unique(tenant_id,normalized_name), unique(tenant_id,client_id), unique(tenant_id,id)
);
create index customers_tenant_name_idx on customers(tenant_id,normalized_name);
create trigger customers_set_updated_at before insert or update on customers for each row execute function set_updated_at();
create trigger audit_customers after insert or update on customers for each row execute function audit_row_change();
alter table customers enable row level security;
grant select,insert,update on customers to authenticated;
create policy customers_read on customers for select using(tenant_id=current_tenant_id() and deleted_at is null);
create policy customers_write on customers for all
 using(tenant_id=current_tenant_id() and has_perm('MANAGE_CUSTOMERS'))
 with check(tenant_id=current_tenant_id() and has_perm('MANAGE_CUSTOMERS'));

-- Preserve the existing projection before replacing the aggregate view.
create temporary table phase4_stock_seed on commit drop as
 select tenant_id,shop_id,item_id,qty_base from stock_current;
drop view stock_current;

create table stock_current(
 tenant_id uuid not null,
 shop_id uuid not null,
 item_id uuid not null,
 on_hand numeric(18,6) not null default 0,
 reserved numeric(18,6) not null default 0 check(reserved>=0),
 available numeric(18,6) generated always as (on_hand-reserved) stored,
 -- Compatibility for Phase 3 adapters/tests while callers migrate to on_hand.
 qty_base numeric(18,6) generated always as (on_hand) stored,
 updated_at bigint not null default (extract(epoch from clock_timestamp())*1000)::bigint,
 primary key(tenant_id,shop_id,item_id),
 foreign key(tenant_id,shop_id) references shops(tenant_id,id),
 foreign key(tenant_id,item_id) references items(tenant_id,id)
);
insert into stock_current(tenant_id,shop_id,item_id,on_hand)
 select tenant_id,shop_id,item_id,qty_base from phase4_stock_seed;

alter table stock_current enable row level security;
grant select on stock_current to authenticated;
create policy stock_current_read on stock_current for select using(tenant_id=current_tenant_id());

create function apply_stock_movement() returns trigger
language plpgsql security definer set search_path=public as $$
declare v_on_hand numeric; v_reserved numeric;
begin
 insert into stock_current(tenant_id,shop_id,item_id,on_hand,reserved,updated_at)
 values(new.tenant_id,new.shop_id,new.item_id,new.qty_base,0,(extract(epoch from clock_timestamp())*1000)::bigint)
 on conflict(tenant_id,shop_id,item_id) do update
 set on_hand=stock_current.on_hand+excluded.on_hand,
     updated_at=(extract(epoch from clock_timestamp())*1000)::bigint
 returning on_hand,reserved into v_on_hand,v_reserved;
 if v_on_hand < 0 or v_on_hand < v_reserved then
   raise exception 'insufficient stock';
 end if;
 return new;
end $$;
revoke all on function apply_stock_movement() from public;
create trigger stock_movements_project after insert on stock_movements for each row execute function apply_stock_movement();

-- Harden the old sequence helper: a UUID from another tenant must never be usable
-- to allocate a document number, and cashiers must remain scoped to assigned shops.
create or replace function next_doc_no(p_shop_id uuid,p_series text)
returns bigint language plpgsql security definer set search_path=public as $$
declare v_tenant_id uuid; v_next bigint;
begin
 v_tenant_id:=phase3_assert_shop(p_shop_id);
 if p_series is null or btrim(p_series)='' then raise exception 'series required'; end if;
 insert into doc_sequences(tenant_id,shop_id,series,next_no)
 values(v_tenant_id,p_shop_id,btrim(p_series),0)
 on conflict(tenant_id,shop_id,series) do nothing;
 update doc_sequences set next_no=next_no+1
 where tenant_id=v_tenant_id and shop_id=p_shop_id and series=btrim(p_series)
 returning next_no into v_next;
 if v_next is null then raise exception 'document sequence unavailable'; end if;
 return v_next;
end $$;
revoke all on function next_doc_no(uuid,text) from public;
grant execute on function next_doc_no(uuid,text) to authenticated;
