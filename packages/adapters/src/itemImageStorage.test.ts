import { beforeEach,describe,expect,it,vi } from 'vitest';

const upload=vi.fn();
const remove=vi.fn();
const getSession=vi.fn();
vi.mock('./client',()=>({
  getSupabaseClient:()=>({
    auth:{getSession},
    storage:{from:()=>({upload,remove})},
  }),
}));

describe('item image storage adapter',()=>{
  beforeEach(()=>{
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    upload.mockResolvedValue({error:null});
    remove.mockResolvedValue({error:null});
    getSession.mockResolvedValue({data:{session:{access_token:'session-token'}},error:null});
  });

  it('uses Supabase Storage by default',async()=>{
    const {getItemImageStorageProvider,putItemImage,deleteItemImage}=await import('./itemImageStorage');
    expect(getItemImageStorageProvider()).toBe('supabase');
    const blob=new Blob(['x'],{type:'image/webp'});
    await putItemImage('tenant/items/item/a.webp',blob);
    await deleteItemImage('tenant/items/item/a.webp');
    expect(upload).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith(['tenant/items/item/a.webp']);
  });

  it('uses the authenticated same-origin R2 proxy when selected',async()=>{
    vi.stubEnv('VITE_ITEM_IMAGE_STORAGE_PROVIDER','r2');
    const fetchMock=vi.fn().mockResolvedValue(new Response('ok',{status:201}));
    vi.stubGlobal('fetch',fetchMock);
    const {getItemImageStorageProvider,putItemImage}=await import('./itemImageStorage');
    expect(getItemImageStorageProvider()).toBe('r2');
    await putItemImage('tenant/items/item/a.webp',new Blob(['x'],{type:'image/webp'}));
    expect(upload).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/item-images?path=tenant%2Fitems%2Fitem%2Fa.webp',
      expect.objectContaining({
        method:'PUT',
        headers:expect.objectContaining({Authorization:'Bearer session-token','Content-Type':'image/webp'}),
      }),
    );
  });

  it('never sends an R2 request without an authenticated session',async()=>{
    vi.stubEnv('VITE_ITEM_IMAGE_STORAGE_PROVIDER','r2');
    getSession.mockResolvedValue({data:{session:null},error:null});
    const fetchMock=vi.fn();
    vi.stubGlobal('fetch',fetchMock);
    const {putItemImage}=await import('./itemImageStorage');
    await expect(putItemImage('tenant/items/item/a.webp',new Blob(['x'],{type:'image/webp'}))).rejects.toThrow('Authentication session is unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
