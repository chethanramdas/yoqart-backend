export async function onRequest({env}){
 let database=false;try{if(env.DB){await env.DB.prepare('SELECT 1').first();database=true;}}catch{}
 const dependencies={database,email:!!env.RESEND_API_KEY,documents:!!env.BUCKET,processingConfigured:!!env.PROCESSING_API_URL};
 const ready=Object.values(dependencies).every(Boolean);
 return Response.json({ok:database,status:ready?'ready':'degraded',service:'YoqArt Pages Functions',version:'3.0.0',dependencies},{status:database?200:503,headers:{'Cache-Control':'no-store'}});
}
