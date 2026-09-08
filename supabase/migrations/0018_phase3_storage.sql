-- Phase 3 image storage. Bucket-level size limit is defense in depth beyond
-- client compression; object paths begin with tenant UUID for RLS isolation.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('item-images','item-images',false,153600,array['image/webp','image/jpeg','image/png'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

create policy item_images_read on storage.objects for select to authenticated
using(bucket_id='item-images' and split_part(name,'/',1)=current_tenant_id()::text);
create policy item_images_insert on storage.objects for insert to authenticated
with check(bucket_id='item-images' and split_part(name,'/',1)=current_tenant_id()::text and has_perm('MANAGE_MASTER_DATA'));
create policy item_images_update on storage.objects for update to authenticated
using(bucket_id='item-images' and split_part(name,'/',1)=current_tenant_id()::text and has_perm('MANAGE_MASTER_DATA'))
with check(bucket_id='item-images' and split_part(name,'/',1)=current_tenant_id()::text and has_perm('MANAGE_MASTER_DATA'));
create policy item_images_delete on storage.objects for delete to authenticated
using(bucket_id='item-images' and split_part(name,'/',1)=current_tenant_id()::text and has_perm('MANAGE_MASTER_DATA'));
