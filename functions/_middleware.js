export async function onRequest(context){
 const r=await context.next();const headers=new Headers(r.headers);
 headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','no-referrer');
 if(new URL(context.request.url).pathname.startsWith('/api/'))headers.set('Cache-Control','no-store');
 return new Response(r.body,{status:r.status,statusText:r.statusText,headers});
}
