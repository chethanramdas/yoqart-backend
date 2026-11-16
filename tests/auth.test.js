import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {onRequest} from '../functions/api/auth/[[path]].js';
import {onRequest as documents} from '../functions/api/documents/[[id]].js';
import {newPasswordRecord,hashPassword,sha256,randomToken} from '../functions/_auth.js';

test('account lifecycle against isolated D1 and R2 with mocked email transport',async t=>{
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'test',modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-09-23',d1Databases:['DB'],r2Buckets:['BUCKET']}]}));
 const DB=await mf.getD1Database('DB'),BUCKET=await mf.getR2Bucket('BUCKET');
 const sql=await readFile('schema.sql','utf8');for(const stmt of sql.split(';').map(x=>x.trim()).filter(Boolean))await DB.prepare(stmt).run();
 const emails=[];const realFetch=globalThis.fetch;globalThis.fetch=async(url,opts)=>{assert.equal(String(url),'https://api.resend.com/emails');emails.push(JSON.parse(opts.body));return Response.json({id:'test-message'});};
 const env={DB,BUCKET,RESEND_API_KEY:'fake-test-key'},ip=()=>({'CF-Connecting-IP':randomToken(8)});
 const call=(path,body,headers={})=>onRequest({env,params:{path:path.split('?')[0]},request:new Request('https://test.example/api/auth/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...ip(),...headers},body:body?JSON.stringify(body):undefined})});
 let cookie;
 try{
  await t.test('signup and escaped verification email; duplicate does not insert',async()=>{const r=await call('signup',{name:'<b>Alice</b>',email:'alice@example.test',password:'test password 890'});assert.equal(r.status,200);assert.equal(emails.length,1);assert(!emails[0].html.includes('Hi <b>'));assert.equal((await call('signup',{name:'Alice',email:'alice@example.test',password:'test password 890'})).status,200);assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM users').first()).n,1);});
  await t.test('unverified login denied',async()=>assert.equal((await call('login',{email:'alice@example.test',password:'test password 890'})).status,403));
  await t.test('verification is single use and accepts email navigation',async()=>{const url=new URL(emails[0].html.match(/href="([^"]+)"/)[1].replaceAll('&amp;','&'));const p='verify'+url.search;assert.equal((await call(p,null,{'Sec-Fetch-Site':'cross-site'})).status,302);assert.equal((await call(p)).status,400);});
  await t.test('login creates HttpOnly Secure cookie and profile',async()=>{const r=await call('login',{email:'alice@example.test',password:'test password 890'});assert.equal(r.status,200);cookie=r.headers.get('set-cookie');for(const flag of ['HttpOnly','Secure','SameSite=Lax'])assert(cookie.includes(flag));assert.equal((await (await call('me',null,{Cookie:cookie})).json()).user.email,'alice@example.test');});
  await t.test('document access requires ownership',async()=>{await DB.prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?)').bind('other','not-alice','private.pdf','test','private','application/pdf',10,Date.now()).run().catch(()=>{});const r=await documents({env,params:{id:['missing']},request:new Request('https://test.example/api/documents/missing',{headers:{Cookie:cookie}})});assert.equal(r.status,404);});
  await t.test('password reset invalidates all sessions and token',async()=>{assert.equal((await call('forgot',{email:'alice@example.test'})).status,200);const url=new URL(emails.at(-1).html.match(/href="([^"]+)"/)[1].replaceAll('&amp;','&'));const body={token:url.searchParams.get('reset'),password:'new test password 890'};assert.equal((await call('reset',body)).status,200);assert.equal((await call('reset',body)).status,400);assert.equal((await (await call('me',null,{Cookie:cookie})).json()).user,null);assert.equal((await call('login',{email:'alice@example.test',password:'test password 890'})).status,401);assert.equal((await call('login',{email:'alice@example.test',password:body.password})).status,200);});
  await t.test('expired verification is rejected',async()=>{const token=randomToken();const u=await DB.prepare('SELECT id FROM users').first();await DB.prepare('INSERT INTO email_tokens VALUES(?,?,?,?,?)').bind('expired',u.id,await sha256(token),Date.now()-1,Date.now()-1000).run();assert.equal((await call('verify?token='+token)).status,400);});
  await t.test('malformed body, origin and rate limiting',async()=>{assert.equal((await call('login',{email:'alice@example.test',password:'a'},{Origin:'https://evil.example'})).status,403);let r;for(let i=0;i<16;i++)r=await call('login',{email:'nobody@example.test',password:'x'},{'CF-Connecting-IP':'rate-test'});assert.equal(r.status,429);});
  await t.test('nonexistent recovery response matches existing account',async()=>{const a=await (await call('forgot',{email:'alice@example.test'})).json(),b=await (await call('forgot',{email:'unknown@example.test'})).json();assert.deepEqual(a,b);});
 }finally{globalThis.fetch=realFetch;await mf.dispose();}
});
test('new and legacy password records remain verifiable',async()=>{const pw=await newPasswordRecord('test password');assert.equal(await hashPassword('test password',pw.salt,pw.hash),pw.hash);const legacy=await hashPassword('old password',pw.salt);assert.equal(await hashPassword('old password',pw.salt,legacy),legacy);assert.notEqual(await hashPassword('wrong',pw.salt,legacy),legacy);});
