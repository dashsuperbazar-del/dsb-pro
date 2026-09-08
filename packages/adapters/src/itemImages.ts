import { getSupabaseClient } from './client';
import { classifyError, errorMessage } from './errors';

const friendly=(error:unknown)=>errorMessage(classifyError(error),error);

export async function replaceItemImage(input:{tenantId:string;itemId:string;blob:Blob;oldPath?:string|null}):Promise<string> {
 if(input.blob.size>150*1024) throw new Error('Compressed item image must be 150 KB or smaller.');
 const client=getSupabaseClient();
 const path=`${input.tenantId}/items/${input.itemId}/${Date.now()}-${crypto.randomUUID()}.webp`;
 const uploaded=await client.storage.from('item-images').upload(path,input.blob,{contentType:'image/webp',upsert:false});
 if(uploaded.error) throw new Error(friendly(uploaded.error));
 const updated=await client.from('items').update({image_path:path}).eq('id',input.itemId);
 if(updated.error){ await client.storage.from('item-images').remove([path]); throw new Error(friendly(updated.error)); }
 if(input.oldPath && input.oldPath!==path){ const removed=await client.storage.from('item-images').remove([input.oldPath]); if(removed.error) console.warn('Old item image purge failed:',friendly(removed.error)); }
 return path;
}
