-- supplierbillsearch: look for a duplicate purchase bill anywhere in a supplier's history, not only the latest 1,000.
--  * find_supplier_bill_duplicates(shop, supplier, bill_no, total_paise, business_date): read-only lookup for the
--    purchase entry WARNING (it never blocks or posts anything). Returns at most 20 rows {id, billNo, businessDate,
--    totalPaise, status}: bills of this supplier with the same bill number (trimmed, lower-cased, runs of spaces
--    collapsed -- the same rule the app uses), then, when a date is given, bills with exactly the same total within 3
--    days of that date. VOID bills are returned WITH their status so the app can let a VOID copy outrank a stale
--    cached POSTED copy. Tenant comes from the JWT (phase3_assert_shop); requires POST_PURCHASES.
--  * purchase_bills_supplier_billno_idx: (tenant, supplier, normalised bill number) so the lookup does not scan the
--    supplier's history. Non-unique (live data may already hold repeated numbers).
-- No new table, no column, no change to existing rows or policies. Forward-only.

create index purchase_bills_supplier_billno_idx on purchase_bills(
  tenant_id, party_id, (lower(regexp_replace(btrim(bill_no), '\s+', ' ', 'g'))))
  where deleted_at is null and bill_no is not null;

create function find_supplier_bill_duplicates(p_shop_id uuid,p_party_id uuid,p_bill_no text,p_total_paise bigint,
 p_business_date date default null)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid; v_no text; v_rows jsonb;
begin
 v_tenant:=phase3_assert_shop(p_shop_id);
 if not has_perm('POST_PURCHASES') then raise exception 'not permitted'; end if;
 if p_party_id is null then return '[]'::jsonb; end if;
 v_no:=lower(regexp_replace(btrim(coalesce(p_bill_no,'')),'\s+',' ','g'));
 with hits as (
   select b.id,b.bill_no,b.business_date,b.total_paise,b.status,1 as rank
     from purchase_bills b
    where v_no<>'' and b.tenant_id=v_tenant and b.shop_id=p_shop_id and b.party_id=p_party_id and b.deleted_at is null
      and b.bill_no is not null
      and lower(regexp_replace(btrim(b.bill_no),'\s+',' ','g'))=v_no
   union all
   select b.id,b.bill_no,b.business_date,b.total_paise,b.status,2
     from purchase_bills b
    where p_business_date is not null and p_total_paise is not null
      and b.tenant_id=v_tenant and b.shop_id=p_shop_id and b.party_id=p_party_id and b.deleted_at is null
      and b.total_paise=p_total_paise
      and b.business_date between p_business_date-3 and p_business_date+3
 ), one as (
   select distinct on (id) * from hits order by id,rank
 ), top as (
   select * from one order by rank,business_date desc,id limit 20
 )
 select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'billNo',t.bill_no,'businessDate',t.business_date,
     'totalPaise',t.total_paise::text,'status',t.status) order by t.rank,t.business_date desc,t.id),'[]'::jsonb)
   into v_rows from top t;
 return v_rows;
end $$;
revoke all on function find_supplier_bill_duplicates(uuid,uuid,text,bigint,date) from public,anon;
grant execute on function find_supplier_bill_duplicates(uuid,uuid,text,bigint,date) to authenticated;
