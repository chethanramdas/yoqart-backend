import {originOk,response,rateLimit} from '../../_auth.js';
const allowed=new Set(['health','convert/pdf-to-word','convert/pdf-to-excel','convert/word-to-pdf','convert/excel-to-pdf','convert/ppt-to-pdf','compress-pdf','protect-pdf','unlock-pdf','repair-pdf','download']);
export async function onRequest(context){
 const {request,env}=context;
 if(!originOk(request))return response({error:'Invalid request origin.'},403);
 const parts=Array.isArray(context.params.path)?context.params.path:[context.params.path].filter(Boolean),endpoint=parts.join('/');
 if(!allowed.has(endpoint))return response({error:'Processing endpoint not found.'},404);
 if(request.method!==(endpoint==='health'?'GET':'POST'))return response({error:'Method not allowed.'},405);
 if(Number(request.headers.get('content-length'))>51*1024*1024)return response({error:'Upload exceeds the 50 MB file limit.'},413);
 const base=String(env.PROCESSING_API_URL||'');
 if(!base)return response({error:'The native processing service is not connected. Browser-based tools remain available.'},503);
 let target;try{target=new URL(base);if(target.protocol!=='https:'||target.username||target.password)throw Error();}catch{return response({error:'Processing service configuration is invalid.'},503);}
 if(env.DB&&endpoint!=='health'&&!(await rateLimit(context,'processing',30)))return response({error:'Too many requests. Please try again later.'},429);
 target.pathname=target.pathname.replace(/\/$/,'')+'/'+endpoint;target.search='';target.hash='';
 const headers=new Headers();const ct=request.headers.get('content-type');if(ct)headers.set('content-type',ct);
 if(env.PROCESSING_API_TOKEN)headers.set('X-YoqArt-Processing-Token',env.PROCESSING_API_TOKEN);
 try{
  const upstream=await fetch(target,{method:request.method,headers,body:request.method==='GET'?undefined:request.body,redirect:'manual',signal:AbortSignal.timeout(endpoint==='health'?8000:280000)});
  if(upstream.status>=300&&upstream.status<400)return response({error:'Processing service returned an unexpected redirect.'},502);
  if((upstream.headers.get('content-type')||'').includes('text/html'))return response({error:'Processing service returned an invalid response.'},502);
  const out=new Headers({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  for(const h of ['Content-Type','Content-Disposition','X-YoqArt-Original-Bytes','X-YoqArt-Compressed-Bytes','X-YoqArt-Reduced','X-YoqArt-Engine'])if(upstream.headers.has(h))out.set(h,upstream.headers.get(h));
  return new Response(upstream.body,{status:upstream.status,headers:out});
 }catch{return response({error:'Processing service is unavailable or timed out. Please try a smaller file later.'},502);}
}
