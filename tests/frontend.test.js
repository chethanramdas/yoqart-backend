import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import * as PDFLib from 'pdf-lib';
import JSZip from 'jszip';
const html=await fs.readFile('public/index.html','utf8');
const source=await fs.readFile('public/app.js','utf8');
async function setup(){
 const dom=new JSDOM(html,{url:'https://test.example/',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,blobs=new Map();
 w.fetch=async()=>Response.json({user:null});w.scrollTo=()=>{};w.ArrayBuffer=ArrayBuffer;w.Uint8Array=Uint8Array;w.eval(await fs.readFile('public/vendor/pdf-lib.min.js','utf8'));w.JSZip=JSZip;w.Blob=Blob;w.File=File;w.AbortSignal=AbortSignal;
 w.URL.createObjectURL=b=>{const k='blob:test/'+blobs.size;blobs.set(k,b);return k};w.URL.revokeObjectURL=()=>{};
 w.eval(source.replace("$('floatingFeedback')?.addEventListener", "window.testing={renderTool,parsePages,files,renderFiles,merge,split,organize,rotate,crop,watermark,numberPdf,annotate,calc,invoice,payslip,numberWords,validateToolNumbers,spreadsheetPdf,meta,body};$('floatingFeedback')?.addEventListener"));
 w.dispatchEvent(new w.Event('DOMContentLoaded'));await new Promise(r=>setTimeout(r,1));
 // Disable canvas previews in this DOM-only suite; rendering is checked in browser QA.
 return {w,t:w.testing,blobs,close:()=>dom.window.close()};
}
async function file(pages=3,name='sample.pdf'){const doc=await PDFLib.PDFDocument.create();for(let i=0;i<pages;i++)doc.addPage([200+i*10,300]);return new File([await doc.save()],name,{type:'application/pdf'});}
async function output(ctx){const a=ctx.w.document.querySelector('#outputActions a');assert(a,'download action');const b=ctx.blobs.get(a.href);assert(b?.size>0);return b;}
test('every advertised tool has a valid view and unique control IDs',async()=>{const c=await setup();try{assert.equal(Object.keys(c.t.meta).length,46);for(const id of Object.keys(c.t.meta)){c.t.renderTool(id,false);assert(c.w.document.querySelector('.tool-title').textContent);const ids=[...c.w.document.querySelectorAll('#toolContent [id]')].map(n=>n.id);assert.equal(ids.length,new Set(ids).size,id);if(!['pdf-translate','pdf-to-pdfa'].includes(id))assert(c.w.document.querySelector('[data-run]'),id);}}finally{c.close()}});
test('page ranges reject malformed, duplicate, inverted and out-of-range requests',async()=>{const c=await setup();try{assert.deepEqual(Array.from(await c.t.parsePages('3,1-2',3)),[2,0,1]);for(const s of ['0','1-99','3-1','1,1','1,garbage',''])await assert.rejects(c.t.parsePages(s,3));}finally{c.close()}});
test('PDF transformations produce parseable downloads with correct pages',async t=>{const c=await setup();try{
 for(const [id,fn,expected,values] of [['merge-pdf','merge',5,{}],['split-pdf','split',2,{pages:'3,1'}],['organize-pdf','organize',3,{pages:'3,1,2'}],['rotate-pdf','rotate',3,{}],['crop-pdf','crop',3,{margin:'10'}],['watermark-pdf','watermark',3,{}],['page-numbers','numberPdf',3,{}],['pdf-editor','annotate',3,{}]])await t.test(id,async()=>{c.t.renderTool(id,false);await c.t.renderFiles(id==='merge-pdf'?[await file(3),await file(2,'other.pdf')]:[await file()]);for(const [k,v] of Object.entries(values))c.w.document.getElementById(k).value=v;if(fn==='annotate')await c.t[fn]('edit');else await c.t[fn]();const doc=await PDFLib.PDFDocument.load(await (await output(c)).arrayBuffer());assert.equal(doc.getPageCount(),expected);if(id==='organize-pdf')assert.equal(doc.getPage(0).getWidth(),220);if(id==='rotate-pdf')assert.equal(doc.getPage(0).getRotation().angle,90);if(id==='crop-pdf')assert.equal(doc.getPage(0).getCropBox().width,180);});
 await t.test('split each page ZIP integrity',async()=>{c.t.renderTool('split-pdf',false);await c.t.renderFiles([await file()]);c.w.document.getElementById('splitMode').value='individual';await c.t.split();const zip=await JSZip.loadAsync(await (await output(c)).arrayBuffer());assert.equal(Object.keys(zip.files).length,3);for(const f of Object.values(zip.files))assert.equal((await PDFLib.PDFDocument.load(await f.async('uint8array'))).getPageCount(),1);});
 await t.test('navigation resets upload state',async()=>{c.t.renderTool('merge-pdf',false);assert.equal(c.t.files().length,0);});
}finally{c.close()}});
test('GST, EMI, percentages and invoice totals are independently checked',async()=>{const c=await setup();try{
 c.t.renderTool('gst',false);c.t.calc('gst');assert.match(c.w.document.getElementById('out').textContent,/11,800/);c.w.document.getElementById('gstMode').value='total';c.w.document.getElementById('gstAmount').value='11800';c.t.calc('gst');assert.match(c.w.document.getElementById('out').textContent,/10,000/);
 c.t.renderTool('emi',false);c.w.document.getElementById('principal').value='1200';c.w.document.getElementById('interest').value='0';c.w.document.getElementById('months').value='12';c.t.calc('emi');assert.match(c.w.document.getElementById('out').textContent,/Monthly EMI: ₹100/);
 c.t.renderTool('percentage',false);c.t.calc('percentage');assert.match(c.w.document.getElementById('out').textContent,/₹15/);c.w.document.getElementById('pctBase').value='-1';c.w.document.getElementById('pctMode').value='percent';c.w.document.getElementById('pctMode').dispatchEvent(new c.w.Event('change'));c.w.document.getElementById('pctBase').value='0';assert.throws(()=>c.t.calc('percentage'),/zero/);
 c.t.renderTool('invoice',false);const row=c.w.document.querySelector('.invoice-item');row.querySelector('[data-field=qty]').value='2';row.querySelector('[data-field=rate]').value='100';c.t.invoice();assert.match(c.w.document.getElementById('out').textContent,/₹236/);
 assert.equal(c.t.numberWords(100000.25),'One Lakh Rupees and Twenty Five Paise Only');assert.match(c.t.numberWords(-1),/Minus One/);
}finally{c.close()}});
