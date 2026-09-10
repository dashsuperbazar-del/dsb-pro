async function currentMembership(env,authorization){
  if(!env.SUPABASE_URL||!env.SUPABASE_ANON_KEY)throw new Error('Storage auth verifier is not configured.');
  const response=await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/current_membership`,{
    method:'POST',
    headers:{
      apikey:env.SUPABASE_ANON_KEY,
      Authorization:authorization,
      'Content-Type':'application/json',
    },
    body:'{}',
  });
  if(!response.ok)return null;
  const rows=await response.json();
  return Array.isArray(rows)&&rows.length?rows[0]:null;
}

function plain(message,status=400){
  return new Response(message,{status,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});
}

export async function onRequest(context){
  const {request,env}=context;
  if(!env.ITEM_IMAGES)return plain('R2 item-image binding is not configured.',503);

  const authorization=request.headers.get('Authorization')||'';
  if(!authorization.startsWith('Bearer '))return plain('Authentication required.',401);

  const membership=await currentMembership(env,authorization).catch(()=>null);
  const tenantId=membership?.tenant_id;
  if(typeof tenantId!=='string'||!tenantId)return plain('Active tenant membership required.',403);

  const url=new URL(request.url);
  const path=url.searchParams.get('path')||'';
  if(!path.startsWith(`${tenantId}/items/`)||path.includes('..'))return plain('Invalid item-image path.',403);

  if(request.method==='PUT'){
    const type=request.headers.get('Content-Type')||'';
    if(type!=='image/webp')return plain('Only image/webp is accepted.',415);
    const declared=Number(request.headers.get('Content-Length')||'0');
    if(declared>150*1024)return plain('Item image exceeds 150 KB.',413);
    const body=await request.arrayBuffer();
    if(body.byteLength===0||body.byteLength>150*1024)return plain('Item image must be between 1 byte and 150 KB.',413);
    await env.ITEM_IMAGES.put(path,body,{httpMetadata:{contentType:'image/webp'}});
    return plain('stored',201);
  }

  if(request.method==='DELETE'){
    await env.ITEM_IMAGES.delete(path);
    return new Response(null,{status:204,headers:{'Cache-Control':'no-store'}});
  }

  if(request.method==='GET'){
    const object=await env.ITEM_IMAGES.get(path);
    if(!object)return plain('Not found.',404);
    const headers=new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag',object.httpEtag);
    headers.set('Cache-Control','private, max-age=300');
    return new Response(object.body,{headers});
  }

  return plain('Method not allowed.',405);
}
