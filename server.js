import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import {processingRouter,processingErrorHandler,startTempSweeper} from './processing.js';

const app=express();
const PORT=process.env.PORT||3000;
const ALLOWED_ORIGINS=String(process.env.ALLOWED_ORIGINS||'https://yoqart.in,https://www.yoqart.in').split(',').map(x=>x.trim()).filter(Boolean);
// Server-to-server calls (the Cloudflare proxy) send no Origin header; browsers must come from an allowed origin or *.pages.dev.
app.use(cors({origin:(origin,cb)=>cb(null,!origin||ALLOWED_ORIGINS.includes(origin)||/^https:\/\/([a-z0-9-]+\.)*yoqart[a-z0-9-]*\.pages\.dev$/.test(origin)||/^http:\/\/localhost(:\d+)?$/.test(origin))}));
app.use(express.json({limit:'100kb'}));
app.use(express.static('public',{extensions:['html']}));
// Routes are reachable as /<endpoint>, /api/<endpoint> and /api/processing/<endpoint>.
const proc=processingRouter();
app.use('/api/processing',proc);
app.use('/api',proc);
app.use('/',proc);
startTempSweeper();

const toolNames = {
  "merge-pdf":"Merge PDF","split-pdf":"Split PDF","remove-pages":"Remove Pages","extract-pages":"Extract Pages",
  "organize-pdf":"Organize PDF","rotate-pdf":"Rotate PDF","compress-pdf":"Compress PDF","pdf-to-jpg":"PDF to JPG",
  "jpg-to-pdf":"JPG to PDF","watermark-pdf":"Watermark PDF","page-numbers":"Page Numbers","crop-pdf":"Crop PDF",
  "pdf-editor":"Edit PDF","sign-pdf":"Sign PDF","unlock-pdf":"Unlock / Re-save PDF","repair-pdf":"Repair PDF",
  "ocr-pdf":"OCR PDF","pdf-forms":"PDF Forms","protect-pdf":"Protect PDF","compare-pdf":"Compare PDF",
  "pdf-to-word":"PDF to Word","word-to-pdf":"Word to PDF","pdf-to-excel":"PDF to Excel","excel-to-pdf":"Excel to PDF",
  "pdf-to-ppt":"PDF to PowerPoint","ppt-to-pdf":"PowerPoint to PDF","html-to-pdf":"HTML to PDF","pdf-to-pdfa":"PDF to PDF/A",
  "pdf-to-markdown":"PDF to Markdown","pdf-search":"Search PDF","pdf-translate":"Translate PDF",
  "pdf-summarize":"Summarize PDF","scan-to-pdf":"Scan to PDF","invoice":"Invoice Generator",
  "credit-note":"Credit Note Generator","debit-note":"Debit Note Generator","payslip":"Payslip Generator",
  "tds":"TDS Calculator","gst":"GST Calculator","emi":"EMI Calculator","percentage":"Percentage Calculator",
  "image-tools":"Image Converter","text-tools":"Text Tools","document-tools":"Document Creator",
  "excel-tools":"Excel Viewer","media-downloader":"Media Downloader"
};

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
app.get('/tools/:id', async (req,res,next)=>{
  const id = String(req.params.id || '').toLowerCase();
  const name = toolNames[id];
  if (!name) return res.status(404).send('Tool not found');
  try {
    let page = await fs.readFile(path.resolve('public/index.html'), 'utf8');
    const unlimited = ['invoice','credit-note','debit-note','payslip'].includes(id) || id.endsWith('-pdf') || ['merge-pdf','split-pdf','remove-pages','extract-pages','organize-pdf','rotate-pdf','compress-pdf','pdf-to-jpg','jpg-to-pdf','watermark-pdf','page-numbers','crop-pdf','pdf-editor','sign-pdf','unlock-pdf','repair-pdf','ocr-pdf','pdf-forms','protect-pdf','compare-pdf','pdf-to-word','word-to-pdf','pdf-to-excel','excel-to-pdf','pdf-to-ppt','ppt-to-pdf','html-to-pdf','pdf-to-pdfa','pdf-to-markdown','pdf-search','pdf-translate','pdf-summarize','scan-to-pdf'].includes(id);
    const title = `${name}${unlimited ? ' — Free Unlimited' : ' Online'} — YoqArt`;
    const description = unlimited ? `Use YoqArt's ${name} free with no artificial daily or monthly usage counter. Mobile-friendly online tools for everyday digital work.` : `Use YoqArt's ${name} online. Free, simple and mobile-friendly tools for everyday digital work.`;
    const schema = JSON.stringify({
      "@context":"https://schema.org",
      "@type":"WebPage",
      "name":title,
      "description":description,
      "url":`https://yoqart.in/tools/${encodeURIComponent(id)}`
    });
    page = page
      .replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`)
      .replace(/<meta name="description" content="[^"]*">/i, `<meta name="description" content="${escapeHtml(description)}">`)
      .replace(/<link rel="canonical" href="[^"]*">/i, `<link rel="canonical" href="https://yoqart.in/tools/${encodeURIComponent(id)}">`)
      .replace('</head>', `<meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="https://yoqart.in/tools/${encodeURIComponent(id)}"><script type="application/ld+json">${schema}</script></head>`);
    res.type('html').send(page);
  } catch (e) {
    next(e);
  }
});

app.use('/api',(req,res)=>res.status(404).json({error:'Not found.'}));
app.use(processingErrorHandler);
app.use((req,res)=>res.sendFile(path.resolve('public/index.html')));
app.listen(PORT,()=>console.log(`YoqArt server listening on ${PORT}`));
