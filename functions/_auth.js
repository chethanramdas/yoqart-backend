import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 as sha256Hash } from '@noble/hashes/sha2.js';
const enc = new TextEncoder();
export function b64u(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function unb64u(s) { return Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')), c=>c.charCodeAt(0)); }
export function randomToken(n=32) { return b64u(crypto.getRandomValues(new Uint8Array(n))); }
export async function sha256(text) { return b64u(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(text)))); }
async function derive(password,salt,iterations) {
 const key=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);
 try { return new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',salt:unb64u(salt),iterations,hash:'SHA-256'},key,256)); }
 catch(e) { // Preserve legacy 120,000-iteration records on runtimes with the 100,000 per-call limit.
  if(e.name!=='NotSupportedError')throw e;
  return pbkdf2Async(sha256Hash,enc.encode(password),unb64u(salt),{c:iterations,dkLen:32,asyncTick:8});
 }
}
export async function hashPassword(password,salt,stored='') {
 if(!stored.startsWith('chain6$'))return b64u(await derive(password,salt,120000));
 let value=password;
 for(let i=0;i<6;i++)value=b64u(await derive(value,salt,100000));
 return 'chain6$'+value;
}
export async function newPasswordRecord(password) { const salt=randomToken(16);return {salt,hash:await hashPassword(password,salt,'chain6$')}; }
export function sameHash(a,b) { let d=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)d|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return d===0; }
export function cookie(name,value,maxAge=2592000) { return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`; }
export function clearCookie(name) {return cookie(name,'',0);}
export function cookies(req) { const out={};for(const p of (req.headers.get('Cookie')||'').split(';')){const i=p.indexOf('=');if(i>0)try{out[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim());}catch{}}return out; }
export async function jsonBody(req) { if(Number(req.headers.get('content-length'))>16384)throw Error('INVALID_BODY');const text=await req.text();if(text.length>16384)throw Error('INVALID_BODY');try{return JSON.parse(text);}catch{throw Error('INVALID_BODY');} }
export function response(data,status=200,headers={}) {return Response.json(data,{status,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',...headers}});}
export function originOk(req) {const o=req.headers.get('Origin');return (!o||o===new URL(req.url).origin)&&req.headers.get('Sec-Fetch-Site')!=='cross-site';}
export async function getSession(ctx) {const token=cookies(ctx.request).yq_session;if(!token||!ctx.env.DB)return null;return ctx.env.DB.prepare('SELECT s.id,s.user_id,s.expires_at,u.email,u.name,u.email_verified_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?1 AND s.expires_at>?2').bind(await sha256(token),Date.now()).first();}
export async function rateLimit(ctx,action,limit=10,windowMs=600000) {
 const now=Date.now(),key=action+':'+await sha256(ctx.request.headers.get('CF-Connecting-IP')||'local');
 const row=await ctx.env.DB.prepare('INSERT INTO api_rate_limits(key,window_start,count) VALUES(?1,?2,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window_start<=?3 THEN 1 ELSE count+1 END,window_start=CASE WHEN window_start<=?3 THEN ?2 ELSE window_start END RETURNING count').bind(key,now,now-windowMs).first();
 return row.count<=limit;
}
export function emailReady(env) {return !!env.RESEND_API_KEY;}
export async function sendEmail(ctx,to,subject,html) {
 if(!emailReady(ctx.env))throw Error('EMAIL_UNAVAILABLE');
 const r=await fetch('https://api.resend.com/emails',{method:'POST',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${ctx.env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:ctx.env.AUTH_FROM_EMAIL||'YoqArt <noreply@yoqart.in>',to,subject,html})});
 if(!r.ok){console.error('Email delivery rejected',{status:r.status});throw Error('EMAIL_UNAVAILABLE');}
}
export function escapeHtml(s) {return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
export function emailTemplate(title,text,buttonText,url) {return `<!doctype html><html lang="en"><head><title>${escapeHtml(title)}</title></head><body style="font-family:Arial,sans-serif;color:#15223b"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p><p><a href="${escapeHtml(url)}">${escapeHtml(buttonText)}</a></p><p>If you did not request this, ignore this email.</p></body></html>`;}
