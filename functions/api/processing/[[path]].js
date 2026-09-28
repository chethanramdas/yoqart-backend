function response(data,status=200){return Response.json(data,{status})}

export async function onRequest(context){
  const {request,env}=context;
  const base=String(env.PROCESSING_API_URL||'').replace(/\/$/,'');
  if(!base)return response({error:'YoqArt processing backend is not configured. Set PROCESSING_API_URL in Cloudflare Pages.'},503);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{'Access-Control-Allow-Methods':'POST,GET,OPTIONS','Access-Control-Allow-Headers':'Content-Type'}});
  const parts=Array.isArray(context.params.path)?context.params.path:[context.params.path].filter(Boolean);
  if(!parts.length)return response({error:'Processing endpoint is required.'},404);
  const target=base+'/'+parts.map(x=>encodeURIComponent(x)).join('/');
  const headers=new Headers(request.headers);headers.delete('host');headers.delete('content-length');
  try{
    const upstream=await fetch(target,{method:request.method,headers,body:request.method==='GET'||request.method==='HEAD'?undefined:request.body,redirect:'manual'});
    const outHeaders=new Headers(upstream.headers);outHeaders.delete('set-cookie');
    return new Response(upstream.body,{status:upstream.status,statusText:upstream.statusText,headers:outHeaders});
  }catch(e){return response({error:'Unable to reach the YoqArt processing backend.'},502)}
}
