import { getSupabaseClient } from './client';
import { classifyError, errorMessage } from './errors';
import { deleteItemImage, putItemImage } from './itemImageStorage';

const friendly=(error:unknown)=>errorMessage(classifyError(error),error);

export async function replaceItemImage(input:{tenantId:string;itemId:string;blob:Blob;oldPath?:string|null}):Promise<string> {
 if(input.blob.size>150*1024) throw new Error('Compressed item image must be 150 KB or smaller.');
 const client=getSupabaseClient();
 const path=`${input.tenantId}/items/${input.itemId}/${Date.now()}-${crypto.randomUUID()}.webp`;
 await putItemImage(path,input.blob);
 const updated=await client.from('items').update({image_path:path}).eq('id',input.itemId);
 if(updated.error){ await deleteItemImage(path).catch(()=>undefined); throw new Error(friendly(updated.error)); }
 if(input.oldPath && input.oldPath!==path){ await deleteItemImage(input.oldPath).catch(error=>console.warn('Old item image purge failed:',friendly(error))); }
 return path;
}
