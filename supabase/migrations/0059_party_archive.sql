-- partyarchive: guarded archive of suppliers and customers; customer rewrites need master-data permission.
-- Rules (financial system): a party that has ANY bill, invoice, payment, return or opening balance is never
-- archived (its ledger rows must stay attributable); an unused party (a typo, a duplicate) can be.
-- Archive is soft (deleted_at), audited by the existing row trigger, idempotent, and only possible through
-- these functions: clients lose the right to write deleted_at/tenant_id/client_id directly.

create function dsb_supplier_has_history(p_party_id uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select exists(select 1 from purchase_bills where party_id=p_party_id)
     or exists(select 1 from payments where party_id=p_party_id)
     or exists(select 1 from purchase_returns where party_id=p_party_id)
     or exists(select 1 from account_openings where party_id=p_party_id)
$$;

create function dsb_customer_has_history(p_customer_id uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select exists(select 1 from sale_invoices where customer_id=p_customer_id)
     or exists(select 1 from payments where customer_id=p_customer_id)
     or exists(select 1 from sale_returns where customer_id=p_customer_id)
     or exists(select 1 from account_openings where customer_id=p_customer_id)
$$;

create function archive_party(p_party_id uuid) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_row parties%rowtype; v_now bigint:=(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 if not has_perm('MANAGE_MASTER_DATA') then raise exception 'not permitted'; end if;
 -- The row lock also serialises with any bill/payment being posted for this supplier (their FK check
 -- takes a KEY SHARE lock on this row), so history cannot appear between the check and the update.
 select * into v_row from parties where id=p_party_id and tenant_id=current_tenant_id() for update;
 if not found then raise exception 'DSB_PARTY_NOT_FOUND: supplier not found'; end if;
 if v_row.deleted_at is not null then return p_party_id; end if;
 if dsb_supplier_has_history(p_party_id) then
   raise exception 'DSB_PARTY_HAS_HISTORY: this supplier has bills, payments, returns or an opening balance and cannot be archived';
 end if;
 update parties set deleted_at=v_now where id=p_party_id;
 return p_party_id;
end $$;

create function archive_customer(p_customer_id uuid) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_row customers%rowtype; v_now bigint:=(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 if not has_perm('MANAGE_MASTER_DATA') then raise exception 'not permitted'; end if;
 select * into v_row from customers where id=p_customer_id and tenant_id=current_tenant_id() for update;
 if not found then raise exception 'DSB_PARTY_NOT_FOUND: customer not found'; end if;
 if v_row.deleted_at is not null then return p_customer_id; end if;
 if dsb_customer_has_history(p_customer_id) then
   raise exception 'DSB_PARTY_HAS_HISTORY: this customer has sales, payments, returns or an opening balance and cannot be archived';
 end if;
 update customers set deleted_at=v_now where id=p_customer_id;
 return p_customer_id;
end $$;

-- A ledger row may never be written for an archived party. The posting functions check "party is live" with a
-- plain SELECT and only take the FK lock at INSERT, which a concurrent archive can slip between. This guard
-- locks the party row FOR KEY SHARE at INSERT time: it waits for an in-flight archive (FOR UPDATE) and then
-- sees deleted_at, or it holds the lock first and the archive's history check then sees the new row.
create function dsb_assert_live_parties() returns trigger
language plpgsql security definer set search_path=public as $$
declare j jsonb:=to_jsonb(new);
begin
 if (j->>'party_id') is not null then
   perform 1 from parties where id=(j->>'party_id')::uuid and deleted_at is null for key share;
   if not found then raise exception 'DSB_PARTY_ARCHIVED: this supplier is archived and cannot receive new bills, payments or returns'; end if;
 end if;
 if (j->>'customer_id') is not null then
   perform 1 from customers where id=(j->>'customer_id')::uuid and deleted_at is null for key share;
   if not found then raise exception 'DSB_PARTY_ARCHIVED: this customer is archived and cannot receive new sales, payments or returns'; end if;
 end if;
 return new;
end $$;
create trigger dsb_live_party_guard before insert on purchase_bills for each row execute function dsb_assert_live_parties();
create trigger dsb_live_party_guard before insert on purchase_returns for each row execute function dsb_assert_live_parties();
create trigger dsb_live_party_guard before insert on sale_invoices for each row execute function dsb_assert_live_parties();
create trigger dsb_live_party_guard before insert on sale_returns for each row execute function dsb_assert_live_parties();
create trigger dsb_live_party_guard before insert on payments for each row execute function dsb_assert_live_parties();
create trigger dsb_live_party_guard before insert on account_openings for each row execute function dsb_assert_live_parties();

-- An archived customer must not reserve its name forever (it is invisible and cannot be restored).
alter table customers drop constraint customers_tenant_id_normalized_name_key;
create unique index customers_live_name_key on customers(tenant_id,normalized_name) where deleted_at is null;

-- The generic archive no longer handles suppliers: it had no history check.
create or replace function archive_master(p_table text,p_id uuid) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_now bigint:=(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 if not has_perm('MANAGE_MASTER_DATA') then raise exception 'not permitted'; end if;
 case p_table
  when 'categories' then update categories set deleted_at=v_now where id=p_id and tenant_id=current_tenant_id();
  when 'parties' then raise exception 'DSB_USE_ARCHIVE_PARTY: archive suppliers with archive_party()';
  when 'items' then update items set deleted_at=v_now,is_active=false where id=p_id and tenant_id=current_tenant_id();
  else raise exception 'unsupported master table';
 end case;
 if not found then raise exception 'row not found'; end if;
 return p_id;
end $$;

-- Clients may change only descriptive columns of parties/customers; archive goes through the functions above.
revoke update on parties from authenticated;
grant update(name,phone,gstin,address) on parties to authenticated;
revoke update on customers from authenticated;
grant update(name,phone,address,gstin,credit_limit_paise,notes) on customers to authenticated;

-- Cashiers keep creating customers at the till (MANAGE_CUSTOMERS) but can no longer rewrite them
-- (credit limit, notes, name): updates need MANAGE_MASTER_DATA (owner, manager). No client DELETE exists.
drop policy customers_write on customers;
create policy customers_insert on customers for insert
 with check(tenant_id=current_tenant_id() and has_perm('MANAGE_CUSTOMERS'));
create policy customers_update on customers for update
 using(tenant_id=current_tenant_id() and has_perm('MANAGE_MASTER_DATA'))
 with check(tenant_id=current_tenant_id() and has_perm('MANAGE_MASTER_DATA'));

-- parties_write was FOR ALL, so owners/managers could still SELECT archived suppliers through it (RLS policies
-- are OR-ed) and an archive would change nothing for them. Split it: only the read policy decides visibility.
drop policy parties_write on parties;
create policy parties_insert on parties for insert
 with check(tenant_id=current_tenant_id() and has_perm('MANAGE_MASTER_DATA'));
create policy parties_update on parties for update
 using(tenant_id=current_tenant_id() and has_perm('MANAGE_MASTER_DATA'))
 with check(tenant_id=current_tenant_id() and has_perm('MANAGE_MASTER_DATA'));

revoke all on function dsb_supplier_has_history(uuid) from public;
revoke all on function dsb_customer_has_history(uuid) from public;
revoke all on function dsb_assert_live_parties() from public;
revoke all on function archive_party(uuid) from public;
revoke all on function archive_customer(uuid) from public;
grant execute on function archive_party(uuid) to authenticated;
grant execute on function archive_customer(uuid) to authenticated;
