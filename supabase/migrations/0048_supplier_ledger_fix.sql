-- Packet C2 (group c2): get_party_ledger_v2 from 0047 used a session temp table cleared with an
-- unqualified DELETE. PostgREST/Supabase rejects that ("DELETE requires a WHERE clause", safeupdate),
-- so the supplier ledger RPC failed for every API caller. Rewritten as a single read-only query:
-- same signature, grants, result shape and ordering; now STABLE with no temp state.
create or replace function get_party_ledger_v2(p_shop_id uuid,p_party_id uuid,p_from date,p_to date) returns jsonb
language plpgsql stable security definer set search_path=public as $$
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
end $$;
