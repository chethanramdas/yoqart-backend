const enc = new TextEncoder();
const dec = new TextDecoder();

function b64u(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64u(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

function randomToken(n = 32) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return b64u(a);
}

async function sha256(text) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return b64u(new Uint8Array(h));
}

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: unb64u(salt),
      iterations: 100000,
      hash: 'SHA-256'
    },
    key,
    256
  );

  return b64u(new Uint8Array(bits));
}

async function newPasswordRecord(password) {
  const salt = randomToken(16);
  return {
    salt,
    hash: await hashPassword(password, salt)
  };
}

function cookie(name, value, maxAge = 2592000) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie(name) {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function cookies(req) {
  const out = {};
  for (const p of (req.headers.get('Cookie') || '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0) {
      out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
    }
  }
  return out;
}

async function jsonBody(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function response(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers
  });
}

function originOk(req) {
  const o = req.headers.get('Origin');
  return !o || o === new URL(req.url).origin;
}

async function getSession(ctx) {
  const token = cookies(ctx.request).yq_session;
  if (!token) return null;

  const h = await sha256(token);

  const row = await ctx.env.DB
    .prepare(
      `SELECT s.id,s.user_id,s.expires_at,u.email,u.name,u.email_verified_at
       FROM sessions s
       JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=?1 AND s.expires_at>?2`
    )
    .bind(h, Date.now())
    .first();

  if (!row) return null;

  return row;
}

async function requireSession(ctx) {
  const s = await getSession(ctx);
  if (!s) throw new Error('UNAUTHORIZED');
  return s;
}

async function sendEmail(ctx, to, subject, html) {
  const key = ctx.env.RESEND_API_KEY;

  if (!key) {
    throw new Error(
      'Email service is not configured. Add the RESEND_API_KEY secret in Cloudflare before enabling account emails.'
    );
  }

  const from =
    ctx.env.AUTH_FROM_EMAIL || 'YoqArt <noreply@yoqart.in>';

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      html
    })
  });

  if (!r.ok) {
    const t = await r.text();
    console.error('Email provider error', t);
    throw new Error(
      'Unable to send email right now. Please try again later.'
    );
  }

  return r;
}

function emailTemplate(title, text, buttonText, url) {
  return `<!doctype html>
<html>
<body style="font-family:Arial,sans-serif;background:#f7f8fc;padding:30px;color:#15223b">
<div style="max-width:560px;margin:auto;background:white;border:1px solid #e2e6ef;border-radius:18px;padding:28px">
<h1 style="margin-top:0">${title}</h1>
<p>${text}</p>
<p>
<a href="${url}" style="display:inline-block;background:#6955e8;color:white;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700">${buttonText}</a>
</p>
<p style="color:#68738a;font-size:12px">If you did not request this, you can ignore this email.</p>
</div>
</body>
</html>`;
}

export {
  randomToken,
  sha256,
  newPasswordRecord,
  hashPassword,
  cookie,
  clearCookie,
  cookies,
  jsonBody,
  response,
  originOk,
  sendEmail,
  emailTemplate,
  getSession,
  requireSession
};
