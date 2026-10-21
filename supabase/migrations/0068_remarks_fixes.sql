-- remarksfix: corrections to 0067 remarks found in the post-merge bug sweep. Notes only: nothing here posts or
-- changes money, stock or balances, and no remark or history row is rewritten.
--  * edit_document_remark: the "exact retry" answer is now given only for a real replay of the caller's own
--    edit: the change right after the expected version is an EDIT, by the caller, to the same text. Any
--    other change since the expected version (a settle or reopen, someone else's edit, another text) is
--    DSB_REMARK_STALE or DSB_REMARK_SETTLED, never "saved". Before, a settle by the same person whose text
--    happened to match was answered as a saved edit.
--  * list_open_remarks: set-based. The 500 oldest open remarks are chosen first, then their current bills are
--    resolved in one recursive query (open_chain) instead of a per-row loop over every open remark. The read
--    rule is checked once per document kind. Same signature, columns, order and 500-row cap: the app shows
--    "the oldest 500" when the cap is reached.

create or replace function edit_document_remark(p_remark_id uuid,p_body text,p_expected_version integer)
returns integer language plpgsql security definer set search_path=public as $$
declare v_row document_remarks%rowtype; v_body text:=btrim(coalesce(p_body,''));
begin
 v_row:=dr_lock_remark(p_remark_id);
 if v_row.created_by<>auth.uid() and coalesce("current_role"(),'') not in ('owner','manager') then
   raise exception 'not permitted';
 end if;
 if char_length(v_body) not between 1 and 300 then raise exception 'DSB_INVALID_REMARK: write 1 to 300 characters'; end if;
 -- Exact replay only: the one change since the expected version is this caller's EDIT to this text.
 if p_expected_version is not null and v_row.version=p_expected_version+1 and v_row.body=v_body
    and exists(select 1 from document_remark_events e
               where e.tenant_id=v_row.tenant_id and e.remark_id=v_row.id and e.version=v_row.version
                 and e.action='EDIT' and e.actor=auth.uid() and e.body=v_body) then
   return v_row.version;
 end if;
 if v_row.status<>'OPEN' then raise exception 'DSB_REMARK_SETTLED: reopen the remark before changing it'; end if;
 if p_expected_version is null or v_row.version<>p_expected_version then
   raise exception 'DSB_REMARK_STALE: the remark was changed by someone else; reload it';
 end if;
 if v_row.body=v_body then return v_row.version; end if;
 update document_remarks set body=v_body,version=version+1 where id=p_remark_id;
 return v_row.version+1;
end $$;

create or replace function list_open_remarks(p_shop_id uuid)
returns table(remark_id uuid,doc_kind text,doc_id uuid,doc_no text,party_name text,business_date date,
              doc_status text,body text,created_at timestamptz,version integer)
language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_purchase boolean; v_sale boolean;
begin
 if v_tenant is null then raise exception 'not authenticated'; end if;
 if not exists(select 1 from shops s where s.id=p_shop_id and s.tenant_id=v_tenant) or not c1_shop_visible(p_shop_id) then
   raise exception 'not permitted';
 end if;
 v_purchase:=dr_can_see(p_shop_id,'purchase');
 v_sale:=dr_can_see(p_shop_id,'sale');
 return query
 with recursive top_open as (
   select x.id as rid,x.doc_kind as kind,x.purchase_bill_id as pbid,x.sale_invoice_id as siid,x.body as txt,
          x.created_at as at,x.version as ver
   from document_remarks x
   where x.tenant_id=v_tenant and x.shop_id=p_shop_id and x.status='OPEN'
     and ((x.doc_kind='purchase' and v_purchase) or (x.doc_kind='sale' and v_sale))
   order by x.created_at,x.id
   limit 500),
 -- A replaced bill resolves to its corrected bill (0066 replaced_by_id chain, bounded).
 open_chain(rid,bid,depth) as (
   select t.rid,t.pbid,0 from top_open t where t.kind='purchase'
   union all
   select c.rid,b.replaced_by_id,c.depth+1
   from open_chain c join purchase_bills b on b.tenant_id=v_tenant and b.id=c.bid
   where b.replaced_by_id is not null and c.depth<100),
 cur_bill as (
   select distinct on (c.rid) c.rid,c.bid from open_chain c order by c.rid,c.depth desc)
 select t.rid,t.kind,coalesce(cb.bid,t.siid),
   coalesce(pb.bill_no,si.doc_no),coalesce(pa.name,cu.name),coalesce(pb.business_date,si.business_date),
   coalesce(pb.status,si.status),t.txt,t.at,t.ver
 from top_open t
 left join cur_bill cb on cb.rid=t.rid
 left join purchase_bills pb on t.kind='purchase' and pb.id=cb.bid and pb.tenant_id=v_tenant
 left join parties pa on pa.id=pb.party_id and pa.tenant_id=v_tenant
 left join sale_invoices si on t.kind='sale' and si.id=t.siid and si.tenant_id=v_tenant
 left join customers cu on cu.id=si.customer_id and cu.tenant_id=v_tenant
 order by t.at,t.rid;
end $$;

revoke all on function edit_document_remark(uuid,text,integer) from public,anon;
revoke all on function list_open_remarks(uuid) from public,anon;
grant execute on function edit_document_remark(uuid,text,integer) to authenticated;
grant execute on function list_open_remarks(uuid) to authenticated;
