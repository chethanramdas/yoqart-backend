export function onRequest(){return Response.json({error:'API endpoint not found.'},{status:404,headers:{'Cache-Control':'no-store'}});}
