import {randomToken,sha256,newPasswordRecord,hashPassword,sameHash,cookie,clearCookie,cookies,jsonBody,response,originOk,sendEmail,emailTemplate,getSession,rateLimit,emailReady} from '../../_auth.js';
const generic={ok:true,message:'If this account is eligible, an email has been sent. Check your inbox and spam folder.'};
const validEmail=s=>s.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const userView=u=>({id:u.user_id||u.id,email:u.email,name:u.name,displayName:u.name,firstName:u.name.trim().split(/\s+/)[0]});
async function issueEmail(ctx,u,reset=false){
 const table=reset?'reset_tokens':'email_tokens',token=randomToken(),now=Date.now();
 await ctx.env.DB.prepare(`INSERT INTO ${table}(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)`).bind(randomToken(16),u.id,await sha256(token),now+(reset?3600000:86400000),now).run();
 const url=new URL(reset?'/?reset='+encodeURIComponent(token):'/api/auth/verify?token='+encodeURIComponent(token),ctx.env.AUTH_BASE_URL||ctx.request.url);
 try{await sendEmail(ctx,u.email,reset?'Reset your YoqArt password':'Verify your YoqArt account',emailTemplate(reset?'Reset your password':'Verify your email',`Hi ${u.name}. This link expires in ${reset?'one hour':'24 hours'}.`,reset?'Reset password':'Verify email',url.toString()));}
 catch(e){await ctx.env.DB.prepare(`DELETE FROM ${table} WHERE token_hash=?1`).bind(await sha256(token)).run();throw e;}
}
export async function onRequest(context){
 const {request,env}=context,method=request.method;
 const path=Array.isArray(context.params.path)?context.params.path.join('/'):(context.params.path||'');
 if(!(path==='verify'&&method==='GET')&&!originOk(request))return response({error:'Invalid request origin.'},403);
 if(!env.DB)return response({error:'Account service is temporarily unavailable.'},503);
 try{
  if(path==='me'&&method==='GET'){const s=await getSession(context);return response({user:s?.email_verified_at?userView(s):null});}
  if(path==='logout'&&method==='POST'){const token=cookies(request).yq_session;if(token)await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?1').bind(await sha256(token)).run();return response({ok:true},200,{'Set-Cookie':clearCookie('yq_session')});}
  if(path==='verify'&&method==='GET'){
   const token=new URL(request.url).searchParams.get('token')||'';
   if(!/^[\w-]{43}$/.test(token))return response({error:'This verification link is invalid or expired.'},400);
   const h=await sha256(token),now=Date.now();
   const results=await env.DB.batch([
    env.DB.prepare('UPDATE users SET email_verified_at=?1 WHERE id=(SELECT user_id FROM email_tokens WHERE token_hash=?2 AND expires_at>?1)').bind(now,h),
    env.DB.prepare('DELETE FROM email_tokens WHERE user_id=(SELECT user_id FROM email_tokens WHERE token_hash=?1)').bind(h)
   ]);
   if(!results[0].meta.changes)return response({error:'This verification link is invalid or expired. Request a new verification email.'},400);
   return new Response(null,{status:302,headers:{Location:new URL('/?verified=1',request.url).toString(),'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
  }
  if(method!=='POST'||!['signup','login','resend','forgot','reset'].includes(path))return response({error:'Not found.'},404);
  if(!(await rateLimit(context,'auth:'+path,path==='login'?15:5)))return response({error:'Too many attempts. Please try again in 10 minutes.'},429,{'Retry-After':'600'});
  const b=await jsonBody(request),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||'');
  if(['signup','login','resend','forgot'].includes(path)&&!validEmail(email))return response({error:'Enter a valid email address.'},400);
  if(['signup','reset'].includes(path)&&(password.length<8||password.length>128))return response({error:'Use a password between 8 and 128 characters.'},400);
  if(path==='signup'){
   const name=String(b.name||'').trim();if(name.length<2||name.length>100)return response({error:'Enter a name between 2 and 100 characters.'},400);
   if(!emailReady(env))return response({error:'Account email service is temporarily unavailable. Please try again later.'},503);
   const existing=await env.DB.prepare('SELECT id FROM users WHERE email=?1').bind(email).first();if(existing)return response(generic);
   const pw=await newPasswordRecord(password),u={id:randomToken(16),email,name};
   const insert=await env.DB.prepare('INSERT OR IGNORE INTO users(id,email,name,password_hash,password_salt,email_verified_at,created_at) VALUES(?,?,?,?,?,NULL,?)').bind(u.id,email,name,pw.hash,pw.salt,Date.now()).run();
   if(insert.meta.changes)await issueEmail(context,u);
   return response(generic);
  }
  if(path==='login'){
   if(!password||password.length>128)return response({error:'Invalid email or password.'},401);
   const u=await env.DB.prepare('SELECT * FROM users WHERE email=?1').bind(email).first();
   const hash=await hashPassword(password,u?.password_salt||'AAAAAAAAAAAAAAAAAAAAAA',u?.password_hash||'chain6$');
   if(!u||!sameHash(hash,u.password_hash))return response({error:'Invalid email or password.'},401);
   if(!u.email_verified_at)return response({error:'Please verify your email before logging in. Use Resend verification if needed.'},403);
   const token=randomToken(),now=Date.now();
   await env.DB.prepare('INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)').bind(randomToken(16),u.id,await sha256(token),now+2592000000,now).run();
   return response({ok:true,user:userView(u)},200,{'Set-Cookie':cookie('yq_session',token)});
  }
  if(path==='resend'||path==='forgot'){
   if(!emailReady(env))return response({error:'Account email service is temporarily unavailable. Please try again later.'},503);
   const u=await env.DB.prepare('SELECT id,email,name,email_verified_at FROM users WHERE email=?1').bind(email).first();
   if(u&&(path==='forgot'||!u.email_verified_at))try{await issueEmail(context,u,path==='forgot');}catch(e){console.error('Account email could not be delivered');}
   return response(generic);
  }
  if(path==='reset'){
   const token=String(b.token||'');if(!/^[\w-]{43}$/.test(token))return response({error:'This reset link is invalid or expired.'},400);
   const h=await sha256(token),now=Date.now(),pw=await newPasswordRecord(password);
   const results=await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash=?1,password_salt=?2 WHERE id=(SELECT user_id FROM reset_tokens WHERE token_hash=?3 AND expires_at>?4)').bind(pw.hash,pw.salt,h,now),
    env.DB.prepare('DELETE FROM sessions WHERE user_id=(SELECT user_id FROM reset_tokens WHERE token_hash=?1 AND expires_at>?2)').bind(h,now),
    env.DB.prepare('DELETE FROM reset_tokens WHERE user_id=(SELECT user_id FROM reset_tokens WHERE token_hash=?1)').bind(h)
   ]);
   if(!results[0].meta.changes)return response({error:'This reset link is invalid or expired.'},400);
   return response({ok:true,message:'Password updated. Please log in again.'},200,{'Set-Cookie':clearCookie('yq_session')});
  }
 }catch(e){
  if(e.message==='INVALID_BODY')return response({error:'Invalid request body.'},400);
  console.error('Account request failed',{operation:path,code:e.message==='EMAIL_UNAVAILABLE'?'EMAIL_UNAVAILABLE':'INTERNAL'});
  return response({error:e.message==='EMAIL_UNAVAILABLE'?'Account saved, but email delivery is temporarily unavailable. Use Resend verification shortly.':'Account service is temporarily unavailable.'},e.message==='EMAIL_UNAVAILABLE'?503:500);
 }
}
