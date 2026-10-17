import { getSupabaseClient } from './client';
import { classifyError,errorMessage } from './errors';

export type ItemImageStorageProvider='supabase'|'r2';

const friendly=(error:unknown)=>errorMessage(classifyError(error),error);

export function getItemImageStorageProvider():ItemImageStorageProvider{
  return import.meta.env.VITE_ITEM_IMAGE_STORAGE_PROVIDER==='r2'?'r2':'supabase';
}

async function authHeader():Promise<Record<string,string>>{
  const client=getSupabaseClient();
  const {data,error}=await client.auth.getSession();
  if(error)throw new Error(friendly(error));
  const token=data.session?.access_token;
  if(!token)throw new Error('Authentication session is unavailable. Sign in again before changing item images.');
  return {Authorization:`Bearer ${token}`};
}

export async function putItemImage(path:string,blob:Blob):Promise<void>{
  if(blob.size>150*1024)throw new Error('Compressed item image must be 150 KB or smaller.');
  if(getItemImageStorageProvider()==='supabase'){
    const {error}=await getSupabaseClient().storage.from('item-images').upload(path,blob,{contentType:'image/webp',upsert:false});
    if(error)throw new Error(friendly(error));
    return;
  }
  const response=await fetch(`/api/item-images?path=${encodeURIComponent(path)}`,{
    method:'PUT',
    headers:{...(await authHeader()),'Content-Type':'image/webp'},
    body:blob,
  });
  if(!response.ok)throw new Error((await response.text())||`R2 image upload failed (${response.status}).`);
}

export async function deleteItemImage(path:string):Promise<void>{
  if(getItemImageStorageProvider()==='supabase'){
    const {error}=await getSupabaseClient().storage.from('item-images').remove([path]);
    if(error)throw new Error(friendly(error));
    return;
  }
  const response=await fetch(`/api/item-images?path=${encodeURIComponent(path)}`,{
    method:'DELETE',
    headers:await authHeader(),
  });
  if(!response.ok)throw new Error((await response.text())||`R2 image delete failed (${response.status}).`);
}
