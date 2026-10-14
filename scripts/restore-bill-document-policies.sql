-- Local disposable restore only, after the matching public/Auth dump is restored.
-- DROP SCHEMA public CASCADE also drops storage policies that depend on public
-- permission/shop helpers. Recreate only document policies, not financial RPCs.
drop policy if exists bill_documents_read on storage.objects;
drop policy if exists bill_documents_insert on storage.objects;
create policy bill_documents_read on storage.objects for select to authenticated
using(bucket_id='bill-documents' and split_part(name,'/',1)=current_tenant_id()::text
 and (has_perm('POST_PURCHASES') or has_perm('VIEW_REPORTS'))
 and exists(select 1 from public.shops s where s.id::text=split_part(storage.objects.name,'/',2)
   and s.tenant_id=current_tenant_id() and c1_shop_visible(s.id)));
create policy bill_documents_insert on storage.objects for insert to authenticated
with check(bucket_id='bill-documents' and split_part(name,'/',1)=current_tenant_id()::text
 and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(webp|jpg|png|pdf)$'
 and has_perm('POST_PURCHASES')
 and exists(select 1 from public.shops s where s.id::text=split_part(storage.objects.name,'/',2)
   and s.tenant_id=current_tenant_id() and c1_shop_visible(s.id)));
