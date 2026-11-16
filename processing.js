// YoqArt native processing routes (PDF conversion, compress, protect, media download).
// Mounted at "/", "/api" and "/api/processing" so the Cloudflare proxy
// (/api/processing/<endpoint> -> <PROCESSING_API_URL>/<endpoint>) and direct calls both work.
import express from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {spawn} from 'child_process';
import {fileURLToPath} from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 50);
const MAX_SECONDS = Number(process.env.MAX_MEDIA_SECONDS || 900);
const CONVERT_TIMEOUT_MS = Number(process.env.CONVERT_TIMEOUT_MS || 280000);
const GS_TIMEOUT_MS = Number(process.env.GS_TIMEOUT_MS || 120000);
const MEDIA_TIMEOUT_MS = Number(process.env.MEDIA_TIMEOUT_MS || 280000);
const PYTHON = process.env.PYTHON_BIN || 'python3';
const UPLOAD_DIR = path.join(os.tmpdir(), 'yoqart-upload');

await fs.mkdir(UPLOAD_DIR, {recursive: true});
const upload = multer({dest: UPLOAD_DIR, limits: {fileSize: MAX_MB * 1024 * 1024, files: 1}});

const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  mp4: 'video/mp4'
};

const MSG = {
  noFile: 'Please upload a PDF file.',
  notPdf: 'This file is not a valid PDF.',
  tooBig: `This file is too large. The limit is ${MAX_MB} MB.`,
  fail: "We couldn't process this file. Please try again.",
  encrypted: 'This PDF is password protected. Please unlock it first.'
};

const allowedMedia = u => {
  try {
    const x = new URL(u);
    if (!['https:', 'http:'].includes(x.protocol)) return false;
    const h = x.hostname.toLowerCase();
    return ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'instagram.com', 'www.instagram.com'].includes(h) || false;
  } catch { return false; }
};

// Run a child process with a hard timeout. Never rejects for non-zero exit; resolves {code,out,err,timedOut}.
const run = (cmd, args, {timeoutMs = 120000, cwd, argumentsInput} = {}) => new Promise(resolve => {
  let out = '', err = '', timedOut = false, settled = false;
  const done = r => { if (!settled) { settled = true; resolve(r); } };
  let p;
  try { p = spawn(cmd, args, {stdio: ['pipe', 'pipe', 'pipe'], cwd, detached: process.platform !== 'win32'});
    p.stdin.on('error',()=>{}); p.stdin.end(argumentsInput || ''); }
  catch (e) { return done({code: -1, out, err: String(e), timedOut}); }
  const timer = setTimeout(() => { timedOut = true; try { if(process.platform !== 'win32')process.kill(-p.pid,'SIGKILL');else p.kill('SIGKILL'); } catch {} }, timeoutMs);
  p.stdout.on('data', d => { if (out.length < 1e6) out += d; });
  p.stderr.on('data', d => { if (err.length < 1e6) err += d; });
  p.on('error', e => { clearTimeout(timer); done({code: -1, out, err: err + String(e), timedOut}); });
  p.on('close', code => { clearTimeout(timer); done({code, out, err, timedOut}); });
});

async function cleanup(...xs) { for (const x of xs) if (x) await fs.rm(x, {recursive: true, force: true}).catch(() => {}); }

// Real PDF signature check (not just extension / client MIME).
async function hasPdfSignature(file) {
  let fh;
  try {
    fh = await fs.open(file, 'r');
    const buf = Buffer.alloc(1024);
    const {bytesRead} = await fh.read(buf, 0, 1024, 0);
    return buf.subarray(0, bytesRead).includes('%PDF-');
  } catch { return false; } finally { await fh?.close().catch(() => {}); }
}

async function checkPdfUpload(f) {
  if (!f) return {status: 400, error: MSG.noFile};
  if (!f.size) return {status: 400, error: 'The uploaded file is empty.'};
  if (!(await hasPdfSignature(f.path))) return {status: 400, error: MSG.notPdf};
  return null;
}

function sendFile(res, file, downloadName, kind, cleanupPaths, extraHeaders = {}) {
  res.setHeader('Content-Type', MIME[kind]);
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition,X-YoqArt-Original-Bytes,X-YoqArt-Compressed-Bytes,X-YoqArt-Reduced,X-YoqArt-Engine');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.download(file, downloadName, () => cleanup(...cleanupPaths));
}

// Wrap async handlers so an exception can never leak a stack trace or hang the request.
const safe = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    console.error('Processing request failed', {code:e.code||'INTERNAL'});
    await cleanup(req.file?.path);
    if (!res.headersSent) res.status(500).json({error: MSG.fail});
  }
};

// ---------- PDF -> Word / Excel ----------
async function conversion(req, res, kind) {
  const f = req.file;
  const bad = await checkPdfUpload(f);
  if (bad) { await cleanup(f?.path); return res.status(bad.status).json({error: bad.error}); }
  const dir = path.join(os.tmpdir(), 'yoqart-convert', crypto.randomUUID());
  await fs.mkdir(dir, {recursive: true});
  const ext = kind === 'word' ? 'docx' : 'xlsx';
  const out = path.join(dir, `yoqart-converted.${ext}`);
  const r = await run(PYTHON, [path.join(HERE, 'convert.py'), kind, f.path, out], {timeoutMs: CONVERT_TIMEOUT_MS});
  if (r.code !== 0) {
    console.error('Conversion failed',{kind,code:r.code,timedOut:r.timedOut});
    await cleanup(dir, f.path);
    if (r.timedOut) return res.status(504).json({error: 'Conversion took too long. Try a smaller PDF.'});
    if (r.code === 3) return res.status(422).json({error: MSG.encrypted});
    if (r.code === 4) return res.status(422).json({error: 'No readable text or tables were found in this PDF.'});
    return res.status(502).json({error: MSG.fail});
  }
  const engine = (r.out.trim().split('\n').pop() || '').replace(/[^a-z0-9_+-]/gi, '').slice(0, 40);
  sendFile(res, out, `yoqart-converted.${ext}`, ext, [dir, f.path], {'X-YoqArt-Engine': engine || 'unknown'});
}
const convertHandler = kind => [upload.single('file'), safe((req, res) => conversion(req, res, kind))];

// ---------- Protect ----------
async function protect(req, res) {
  const f = req.file, pw = String(req.body?.password || '');
  const bad = await checkPdfUpload(f);
  if (bad) { await cleanup(f?.path); return res.status(bad.status).json({error: bad.error}); }
  if (!pw) { await cleanup(f.path); return res.status(400).json({error: 'Please provide a password.'}); }
  if (pw.length > 128) { await cleanup(f.path); return res.status(400).json({error: 'Password is too long.'}); }
  const dir = path.join(os.tmpdir(), 'yoqart-protect', crypto.randomUUID());
  await fs.mkdir(dir, {recursive: true});
  const out = path.join(dir, 'yoqart-protected.pdf');
  const r = await run(PYTHON, [path.join(HERE,'native_pdf.py'),'protect',f.path,out], {timeoutMs:GS_TIMEOUT_MS,argumentsInput:pw});
  if (r.code !== 0) { await cleanup(dir,f.path); return res.status(422).json({error:'Unable to protect this PDF. Check that it is readable and unencrypted.'}); }
  sendFile(res, out, 'yoqart-protected.pdf', 'pdf', [dir, f.path]);
}

// ---------- Compress ----------
async function compress(req, res) {
  const f = req.file;
  const bad = await checkPdfUpload(f);
  if (bad) { await cleanup(f?.path); return res.status(bad.status).json({error: bad.error}); }
  const dir = path.join(os.tmpdir(), 'yoqart-compress', crypto.randomUUID());
  await fs.mkdir(dir, {recursive: true});
  const out = path.join(dir, 'yoqart-compressed.pdf');
  const quality = ['screen', 'ebook', 'printer', 'prepress'].includes(req.body?.quality) ? req.body.quality : 'ebook';
  const gs = (q, o) => run('gs', ['-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.4', `-dPDFSETTINGS=/${q}`, '-dSAFER', '-dNOPAUSE', '-dQUIET', '-dBATCH', `-sOutputFile=${o}`, f.path], {timeoutMs: GS_TIMEOUT_MS});
  const r = await gs(quality, out);
  if (r.code !== 0) {
    console.error('Compression failed',{code:r.code});
    await cleanup(dir, f.path);
    return res.status(502).json({error: MSG.fail});
  }
  const verified=await run(PYTHON,[path.join(HERE,'native_pdf.py'),'verify',f.path,out]);
  if(verified.code!==0){await cleanup(dir,f.path);return res.status(422).json({error:'PDF output validation failed. The source may be encrypted or malformed.'});}
  let st = await fs.stat(out), src = await fs.stat(f.path);
  // If compression could not shrink the file, be honest and return the original bytes unchanged, flagged as not reduced.
  let file = out;
  if (st.size >= src.size) { file = f.path; st = src; }
  sendFile(res, file, 'yoqart-compressed.pdf', 'pdf', [dir, f.path], {
    'X-YoqArt-Original-Bytes': String(src.size),
    'X-YoqArt-Compressed-Bytes': String(st.size),
    'X-YoqArt-Reduced': String(st.size < src.size)
  });
}

// ---------- Media downloader ----------
async function mediaDownload(req, res) {
  const {url, quality = 'Best available', format = 'mp4'} = req.body || {};
  if (!allowedMedia(url)) return res.status(400).json({error: 'Unsupported or invalid YouTube/Instagram URL.'});
  if (format !== 'mp4') return res.status(400).json({error: 'Only MP4 is enabled.'});
  const h = quality === '1080p' ? 1080 : quality === '720p' ? 720 : quality === '480p' ? 480 : quality === '360p' ? 360 : 1080;
  const dir = path.join(os.tmpdir(), 'yoqart-media', crypto.randomUUID());
  await fs.mkdir(dir, {recursive: true});
  const r = await run('yt-dlp', ['--no-playlist', '--restrict-filenames', '--max-filesize', `${MAX_MB}M`, '--match-filter', `duration <= ${MAX_SECONDS}`, '-f', `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/b[height<=${h}][ext=mp4]/b[height<=${h}]`, '--merge-output-format', 'mp4', '-o', path.join(dir, 'video.%(ext)s'), '--print', 'after_move:filepath', '--', url], {timeoutMs: MEDIA_TIMEOUT_MS});
  if (r.code !== 0) {
    console.error('Media processing failed',{code:r.code,timedOut:r.timedOut});
    await cleanup(dir);
    if (r.timedOut) return res.status(504).json({error: 'The download took too long.'});
    return res.status(502).json({error: 'Unable to download this media. It may be private, too long, too large or restricted.'});
  }
  const file = r.out.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!file || !path.resolve(file).startsWith(path.resolve(dir)+path.sep)) { await cleanup(dir); return res.status(502).json({error: 'Media file was not created.'}); }
  const st=await fs.stat(file);if(!st.size||st.size>MAX_MB*1024*1024){await cleanup(dir);return res.status(413).json({error:MSG.tooBig});}
  sendFile(res, file, 'yoqart-video.mp4', 'mp4', [dir]);
}

async function nativeOperation(req,res,kind,type) {
 const f=req.file;
 const bad=kind==='office'?(!f||!f.size?{status:400,error:'Choose an Office document.'}:null):await checkPdfUpload(f);
 if(bad){await cleanup(f?.path);return res.status(bad.status).json({error:bad.error});}
 const dir=path.join(os.tmpdir(),'yoqart-convert',crypto.randomUUID());await fs.mkdir(dir,{recursive:true});
 let src=f.path;
 try {
  if(kind==='office'){
   const ext=path.extname(f.originalname).toLowerCase();
   if(!({word:['.docx','.doc'],excel:['.xlsx','.xls','.csv'],ppt:['.pptx','.ppt']}[type]||[]).includes(ext))return res.status(400).json({error:'Choose a supported '+type+' document.'});
   src=path.join(dir,'input'+ext);await fs.copyFile(f.path,src);
  }
  const out=path.join(dir,'yoqart-'+kind+'.pdf');
  const r=await run(PYTHON,[path.join(HERE,'native_pdf.py'),kind,src,out],{timeoutMs:120000,argumentsInput:String(req.body?.password||'')});
  if(r.code!==0)return res.status(r.timedOut?504:422).json({error:kind==='unlock'?'Password incorrect or PDF unreadable.':'Conversion failed. Check that the required engine is installed and the file is readable.'});
  sendFile(res,out,'yoqart-'+kind+'.pdf','pdf',[dir,f.path]);return;
 } finally { if(!res.headersSent)await cleanup(dir,f.path); }
}

// ---------- Health (reports which engines are actually present) ----------
let engineCache = null;
async function engines() {
  if (engineCache && Date.now() - engineCache.t < 60000) return engineCache.v;
  const v = JSON.parse((await run(PYTHON, [path.join(HERE, 'convert.py'), 'engines'], {timeoutMs: 60000})).out.trim().split('\n').pop() || '{}');
  for (const b of ['gs', 'qpdf', 'yt-dlp', 'ffmpeg', 'libreoffice']) v[b] = (await run('which', [b])).code === 0;
  engineCache = {t: Date.now(), v};
  return v;
}

export function processingRouter() {
  const r = express.Router();
  let active=0;
  const clients=new Map();
  r.use((req,res,next)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    if(req.method==='GET')return next();
    if(process.env.PROCESSING_API_TOKEN&&req.get('X-YoqArt-Processing-Token')!==process.env.PROCESSING_API_TOKEN)return res.status(401).json({error:'Unauthorized processing request.'});
    const now=Date.now(),key=req.ip,old=clients.get(key),state=old&&now-old.start<600000?old:{start:now,count:0};state.count++;clients.set(key,state);
    if(clients.size>10000)for(const [k,v] of clients)if(now-v.start>=600000)clients.delete(k);
    if(state.count>30)return res.status(429).json({error:'Too many processing requests. Please try later.'});
    if(active>=Number(process.env.MAX_CONCURRENT_JOBS||2))return res.status(503).json({error:'Processing is busy. Please try again shortly.'});
    active++;let ended=false;const done=()=>{if(!ended){ended=true;active--;}};res.once('finish',done);res.once('close',done);next();
  });
  r.post('/convert/pdf-to-word', ...convertHandler('word'));
  r.post('/convert/pdf-to-excel', ...convertHandler('excel'));
  r.post('/protect-pdf', upload.single('file'), safe(protect));
  r.post('/compress-pdf', upload.single('file'), safe(compress));
  r.post('/download', safe(mediaDownload));
  r.post('/unlock-pdf',upload.single('file'),safe((req,res)=>nativeOperation(req,res,'unlock')));
  r.post('/repair-pdf',upload.single('file'),safe((req,res)=>nativeOperation(req,res,'repair')));
  for(const type of ['word','excel','ppt'])r.post('/convert/'+type+'-to-pdf',upload.single('file'),safe((req,res)=>nativeOperation(req,res,'office',type)));

  r.get('/health', safe(async (req,res)=>{const e=await engines();const ok=!!(e.pypdf&&e.docx&&e.openpyxl&&e.pdfplumber&&e.gs);res.status(ok?200:503).json({ok,service:'YoqArt backend',version:'3.0.0',engines:e});}));
  return r;
}

// Multer / body-parser errors -> clean JSON, no stack traces.
export function processingErrorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (req.file?.path) cleanup(req.file.path);
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({error: MSG.tooBig});
  if (err?.name === 'MulterError') return res.status(400).json({error: MSG.fail});
  console.error('Processing middleware failed',{code:err.code||'INTERNAL'});
  res.status(err?.status || 500).json({error: MSG.fail});
}

// Remove stale temp files left by crashed requests.
export function startTempSweeper() {
  const sweep = async () => {
    for (const d of [UPLOAD_DIR, ...['convert', 'protect', 'compress', 'media'].map(x => path.join(os.tmpdir(), 'yoqart-' + x))]) {
      for (const n of await fs.readdir(d).catch(() => [])) {
        const p = path.join(d, n);
        const st = await fs.stat(p).catch(() => null);
        if (st && Date.now() - st.mtimeMs > 30 * 60 * 1000) await cleanup(p);
      }
    }
  };
  setInterval(sweep, 10 * 60 * 1000).unref();
}
