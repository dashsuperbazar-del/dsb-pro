-- billcode: a short, random-looking, unique BILL CODE on every purchase bill and sale invoice, for searching
-- and quoting a bill ("K7M2-QX9P"). Like the bill number in old DSB, but internal: the supplier's own typed
-- bill no. and the sequential sale doc_no are unchanged and stay separate.
--  * Trigger-only: a BEFORE INSERT trigger fills bill_code (any value a caller supplies is ignored), so no
--    posting function (post_purchase_v2, sp_sync_post_sale, phase4/5 sale paths, edit_purchase_bill) is
--    redefined and no money, stock or balance column is touched. A retry of a posted bill/invoice finds the
--    existing row and so returns the same code.
--  * Format: 4 + 4 characters from an unambiguous uppercase alphabet (no 0 O 1 I L), stored with the dash.
--  * Unique per shop, across purchase bills AND sale invoices (one code finds one document): generated under
--    a transaction advisory lock on (shop, candidate), checked against both tables, retried up to 20 times,
--    then the distinct error DSB_BILL_CODE_EXHAUSTED. A unique index per table is the backstop.
--  * Immutable once set: an UPDATE that changes it is refused (DSB_BILL_CODE_IMMUTABLE). Clients have no
--    INSERT/UPDATE grant on these tables anyway; RLS and grants are unchanged (the column inherits them).
--  * Backfill: every existing row gets a code in created_at, id order. User triggers are switched off for
--    the backfill only (the finalized-sale guard would refuse the update), so updated_at and the audit log
--    are not touched (devices do not pull bills; the app reads them from the server). Only bill_code is
--    written; no money/ledger column is read or written. The unique indexes exist before the backfill so
--    each free-code check is an index probe, not a scan.
--  * find_bills_by_code(shop, text): read-only search over the whole history (partial code from 4 characters,
--    case and dashes ignored), security invoker so row-level security still decides what is visible.
--  * Export/restore: the business export is `select *` per table, so the column is exported; the JSON
--    restore requires the target to have exactly the exported columns, which holds for the same schema.

alter table purchase_bills add column bill_code text;
alter table sale_invoices add column bill_code text;
-- Before the backfill (NULLs are allowed in a unique index): every free-code check below is an index probe.
create unique index purchase_bills_bill_code_key on purchase_bills(shop_id,bill_code);
create unique index sale_invoices_bill_code_key on sale_invoices(shop_id,bill_code);

-- One random candidate; replaceable in a test to force a collision.
create function dsb_bill_code_candidate() returns text language plpgsql volatile set search_path=public as $$
declare
 v_alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; -- 31 characters: no 0 O 1 I L
 v_bytes bytea := decode(replace(gen_random_uuid()::text,'-',''),'hex'); -- 16 random bytes (bytes 6 and 8 carry the uuid version bits)
 v_idx integer[] := array[0,1,2,3,4,5,9,10];
 v_out text := '';
 i integer;
begin
 for i in 1..8 loop
   v_out := v_out || substr(v_alphabet,(get_byte(v_bytes,v_idx[i]) % 31)+1,1);
   if i=4 then v_out := v_out || '-'; end if;
 end loop;
 return v_out;
end $$;

-- A free code for the shop. p_lock serialises two concurrent inserts that picked the same candidate: the
-- second waits for the first to commit, then sees the row and tries again.
create function dsb_new_bill_code(p_shop uuid,p_lock boolean) returns text language plpgsql volatile
security definer set search_path=public as $$
declare v_code text; v_try integer;
begin
 for v_try in 1..20 loop
   v_code := dsb_bill_code_candidate();
   if p_lock then perform pg_advisory_xact_lock(hashtextextended('dsb.bill_code:'||coalesce(p_shop::text,'')||':'||v_code,0)); end if;
   if not exists(select 1 from purchase_bills where shop_id=p_shop and bill_code=v_code)
      and not exists(select 1 from sale_invoices where shop_id=p_shop and bill_code=v_code) then
     return v_code;
   end if;
 end loop;
 raise exception 'DSB_BILL_CODE_EXHAUSTED: could not make a free bill code, try again';
end $$;

create function dsb_bill_code_guard() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if tg_op='INSERT' then
   new.bill_code := dsb_new_bill_code(new.shop_id,true);
   return new;
 end if;
 if new.bill_code is distinct from old.bill_code then
   raise exception 'DSB_BILL_CODE_IMMUTABLE: a bill code is set by the server once and never changed';
 end if;
 return new;
end $$;

revoke all on function dsb_bill_code_candidate() from public,anon,authenticated;
revoke all on function dsb_new_bill_code(uuid,boolean) from public,anon,authenticated;
revoke all on function dsb_bill_code_guard() from public,anon,authenticated;

-- Backfill (tables are locked by the ADD COLUMN above; no concurrent writer). Nothing but bill_code changes.
alter table purchase_bills disable trigger user;
alter table sale_invoices disable trigger user;
do $$
declare r record;
begin
 for r in select id from purchase_bills order by created_at,id loop
   update purchase_bills set bill_code=dsb_new_bill_code(shop_id,false) where id=r.id;
 end loop;
 for r in select id from sale_invoices order by created_at,id loop
   update sale_invoices set bill_code=dsb_new_bill_code(shop_id,false) where id=r.id;
 end loop;
end $$;
alter table purchase_bills enable trigger user;
alter table sale_invoices enable trigger user;

alter table purchase_bills alter column bill_code set not null,
 add constraint purchase_bills_bill_code_format check(bill_code ~ '^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$');
alter table sale_invoices alter column bill_code set not null,
 add constraint sale_invoices_bill_code_format check(bill_code ~ '^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$');

create trigger purchase_bills_bill_code before insert or update on purchase_bills
 for each row execute function dsb_bill_code_guard();
create trigger sale_invoices_bill_code before insert or update on sale_invoices
 for each row execute function dsb_bill_code_guard();

-- Find bills by code across the whole history of a shop (the app's search only holds the latest bills in
-- memory). Case-insensitive, dashes and spaces ignored, a partial code needs at least 4 characters. Read-only,
-- SECURITY INVOKER: the tables' own row-level security decides what the caller may see (purchase bills need
-- POST_PURCHASES or VIEW_REPORTS), plus the shop check below. At most 20 rows, an exact code first.
create function find_bills_by_code(p_shop_id uuid,p_query text)
returns table(kind text,id uuid,bill_code text,doc_no text,party_id uuid,business_date date,total_paise bigint,status text)
language sql stable set search_path=public as $$
 with q as (select upper(regexp_replace(coalesce(p_query,''),'[^A-Za-z0-9]','','g')) n)
 select x.kind,x.id,x.bill_code,x.doc_no,x.party_id,x.business_date,x.total_paise,x.status from (
   select 'purchase'::text kind,b.id,b.bill_code,b.bill_no doc_no,b.party_id,b.business_date,b.total_paise::bigint total_paise,b.status,
          (replace(b.bill_code,'-','')=q.n) exact,b.created_at
     from purchase_bills b,q where b.shop_id=p_shop_id and b.deleted_at is null and length(q.n)>=4
      and replace(b.bill_code,'-','') like '%'||q.n||'%'
   union all
   select 'sale'::text,s.id,s.bill_code,s.doc_no,s.customer_id,s.business_date,s.total_paise::bigint,s.status,
          (replace(s.bill_code,'-','')=q.n),s.created_at
     from sale_invoices s,q where s.shop_id=p_shop_id and length(q.n)>=4
      and replace(s.bill_code,'-','') like '%'||q.n||'%'
 ) x where c1_shop_visible(p_shop_id)
 order by x.exact desc,x.business_date desc,x.created_at desc,x.id
 limit 20
$$;
revoke all on function find_bills_by_code(uuid,text) from public,anon;
grant execute on function find_bills_by_code(uuid,text) to authenticated;
