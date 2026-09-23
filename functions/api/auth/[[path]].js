import {randomToken,sha256,newPasswordRecord,hashPassword,cookie,clearCookie,cookies,jsonBody,response,originOk,sendEmail,emailTemplate,getSession} from '../../_auth.js';

export async function onRequest(context){
  const {request,env}=context;
  if(!originOk(request))return response({error:'Invalid request origin.'},403);
  const method=request.method;
  const path=Array.isArray(context.params.path)?context.params.path.join('/'):(context.params.path||'');
  try{
    if(path==='me'&&method==='GET'){
      const s=await getSession(context);if(!s||!s.email_verified_at)return response({user:null});
      return response({user:{id:s.user_id,email:s.email,name:s.name}});
    }
    if(path==='signup'&&method==='POST'){
      const b=await jsonBody(request),name=String(b.name||'').trim().slice(0,100),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||'');
      if(name.length<2||!/^\S+@\S+\.\S+$/.test(email)||password.length<8)return response({error:'Enter a valid name, email and password of at least 8 characters.'},400);
      const exists=await env.DB.prepare('SELECT id FROM users WHERE email=?1').bind(email).first();if(exists)return response({error:'An account with this email already exists. Try logging in or resetting the password.'},409);
      const id=randomToken(16),pw=await newPasswordRecord(password),now=Date.now();
      await env.DB.prepare('INSERT INTO users(id,email,name,password_hash,password_salt,email_verified_at,created_at) VALUES(?,?,?,?,?,?,?)').bind(id,email,name,pw.hash,pw.salt,null,now).run();
      const token=randomToken(32),tokenHash=await sha256(token);await env.DB.prepare('INSERT INTO email_tokens(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)').bind(randomToken(16),id,tokenHash,now+86400000,now).run();
      const url=new URL(request.url);url.pathname='/api/auth/verify';url.search='?token='+encodeURIComponent(token);
      try{await sendEmail(context,email,'Verify your YoqArt account',emailTemplate('Verify your YoqArt account',`Hi ${name}, click below to verify your email address and activate your YoqArt account.`,'Verify email',url.toString()))}catch(e){await env.DB.prepare('DELETE FROM email_tokens WHERE user_id=?1').bind(id).run();await env.DB.prepare('DELETE FROM users WHERE id=?1').bind(id).run();throw e}
      return response({ok:true,message:'Account created. Check your email and click the verification link.'});
    }
    if(path==='verify'&&method==='GET'){
      const token=new URL(request.url).searchParams.get('token')||'';if(!token)return new Response('Missing verification token.',{status:400});const h=await sha256(token),row=await env.DB.prepare('SELECT id,user_id,expires_at FROM email_tokens WHERE token_hash=?1').bind(h).first();if(!row||row.expires_at<Date.now())return new Response('This verification link is invalid or expired. Please request a new one from YoqArt.',{status:400,headers:{'Content-Type':'text/plain;charset=UTF-8'}});
      await env.DB.prepare('UPDATE users SET email_verified_at=?1 WHERE id=?2').bind(Date.now(),row.user_id).run();await env.DB.prepare('DELETE FROM email_tokens WHERE user_id=?1').bind(row.user_id).run();return Response.redirect(new URL('/?verified=1',request.url),302);
    }
    if(path==='login'&&method==='POST'){
      const b=await jsonBody(request),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||'');const u=await env.DB.prepare('SELECT id,email,name,password_hash,password_salt,email_verified_at FROM users WHERE email=?1').bind(email).first();if(!u)return response({error:'Invalid email or password.'},401);if(!u.email_verified_at)return response({error:'Please verify your email before logging in.'},403);const hash=await hashPassword(password,u.password_salt);if(hash!==u.password_hash)return response({error:'Invalid email or password.'},401);const token=randomToken(32);await env.DB.prepare('INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)').bind(randomToken(16),u.id,await sha256(token),Date.now()+2592000000,Date.now()).run();return response({ok:true,user:{id:u.id,email:u.email,name:u.name} },200,{'Set-Cookie':cookie('yq_session',token)});
    }
    if(path==='logout'&&method==='POST'){
      const c=cookies(request).yq_session;if(c)await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?1').bind(await sha256(c)).run();return response({ok:true},200,{'Set-Cookie':clearCookie('yq_session')});
    }
    if(path==='resend'&&method==='POST'){
      const b=await jsonBody(request),email=String(b.email||'').trim().toLowerCase(),u=await env.DB.prepare('SELECT id,name,email_verified_at FROM users WHERE email=?1').bind(email).first();if(!u||u.email_verified_at)return response({ok:true,message:'If verification is needed, a new email has been sent.'});await env.DB.prepare('DELETE FROM email_tokens WHERE user_id=?1').bind(u.id).run();const token=randomToken(32),now=Date.now();await env.DB.prepare('INSERT INTO email_tokens(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)').bind(randomToken(16),u.id,await sha256(token),now+86400000,now).run();const url=new URL(request.url);url.pathname='/api/auth/verify';url.search='?token='+encodeURIComponent(token);await sendEmail(context,email,'Verify your YoqArt account',emailTemplate('Verify your YoqArt account',`Hi ${u.name}, click below to verify your email address.`,'Verify email',url.toString()));return response({ok:true,message:'Verification email sent.'});
    }
    if(path==='forgot'&&method==='POST'){
      const b=await jsonBody(request),email=String(b.email||'').trim().toLowerCase(),u=await env.DB.prepare('SELECT id,name FROM users WHERE email=?1').bind(email).first();const generic={ok:true,message:'If an account exists for that email, a password reset link has been sent.'};if(!u)return response(generic);await env.DB.prepare('DELETE FROM reset_tokens WHERE user_id=?1').bind(u.id).run();const token=randomToken(32),now=Date.now();await env.DB.prepare('INSERT INTO reset_tokens(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)').bind(randomToken(16),u.id,await sha256(token),now+3600000,now).run();const url=new URL(request.url);url.pathname='/';url.search='?reset='+encodeURIComponent(token);await sendEmail(context,email,'Reset your YoqArt password',emailTemplate('Reset your YoqArt password',`Hi ${u.name}, use the button below to choose a new password. This link expires in 1 hour.`,'Reset password',url.toString()));return response(generic);
    }
    if(path==='reset'&&method==='POST'){
      const b=await jsonBody(request),token=String(b.token||''),password=String(b.password||'');if(password.length<8)return response({error:'Password must be at least 8 characters.'},400);const row=await env.DB.prepare('SELECT id,user_id,expires_at FROM reset_tokens WHERE token_hash=?1').bind(await sha256(token)).first();if(!row||row.expires_at<Date.now())return response({error:'This reset link is invalid or expired.'},400);const pw=await newPasswordRecord(password);await env.DB.prepare('UPDATE users SET password_hash=?1,password_salt=?2 WHERE id=?3').bind(pw.hash,pw.salt,row.user_id).run();await env.DB.prepare('DELETE FROM reset_tokens WHERE user_id=?1').bind(row.user_id).run();await env.DB.prepare('DELETE FROM sessions WHERE user_id=?1').bind(row.user_id).run();return response({ok:true,message:'Password updated successfully.'});
    }
    return response({error:'Not found.'},404);
  }catch(e){console.error(e);return response({error:e.message||'Authentication service error.'},500)}
}
