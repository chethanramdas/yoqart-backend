import express from 'express';
import cors from 'cors';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const app=express(), PORT=process.env.PORT||3000;
const YTDLP=process.env.YTDLP_PATH||'yt-dlp';
const MAX_MB=Number(process.env.MAX_FILE_MB||500);
const MAX_SECONDS=Number(process.env.MAX_DURATION_SECONDS||3600);

app.use(cors());
app.use(express.json({limit:'20kb'}));
app.use(express.static('public'));

const allowed=u=>{try{const h=new URL(u).hostname.toLowerCase();return h==='youtu.be'||h==='youtube.com'||h.endsWith('.youtube.com')||h==='instagram.com'||h.endsWith('.instagram.com')}catch{return false}};
app.get('/api/health',(req,res)=>res.json({ok:true,service:'YoqArt media backend'}));

app.post('/api/download',async(req,res)=>{
 const {url,quality='Best available',format='mp4'}=req.body||{};
 if(typeof url!=='string'||!allowed(url))return res.status(400).json({error:'Unsupported or invalid URL.'});
 if(format!=='mp4')return res.status(400).json({error:'Only MP4 is enabled.'});
 const h=quality==='1080p'?1080:quality==='720p'?720:quality==='480p'?480:quality==='360p'?360:1080;
 const dir=path.join(os.tmpdir(),'yoqart',crypto.randomUUID()); await fs.mkdir(dir,{recursive:true});
 const output=path.join(dir,'video.%(ext)s');
 const args=['--no-playlist','--restrict-filenames','--max-filesize',`${MAX_MB}M`,'--match-filter',`duration <= ${MAX_SECONDS}`,'-f',`bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/b[height<=${h}][ext=mp4]/b[height<=${h}]`,'--merge-output-format','mp4','-o',output,'--print','after_move:filepath',url];
 try{
  const r=await new Promise((resolve,reject)=>{const c=spawn(YTDLP,args,{stdio:['ignore','pipe','pipe']});let o='',e='';c.stdout.on('data',d=>o+=d);c.stderr.on('data',d=>e+=d);c.on('error',reject);c.on('close',code=>resolve({code,o,e}))});
  if(r.code!==0)return res.status(502).json({error:(r.e||'Unable to process URL.').split('\n').filter(Boolean).pop()});
  const file=r.o.trim().split(/\r?\n/).filter(Boolean).pop(); if(!file)return res.status(502).json({error:'Media file was not created.'});
  const stat=await fs.stat(file); if(stat.size>MAX_MB*1024*1024){await fs.rm(dir,{recursive:true,force:true});return res.status(413).json({error:'File exceeds server limit.'})}
  res.download(file,'yoqart-video.mp4',async()=>{await fs.rm(dir,{recursive:true,force:true})});
 }catch(e){await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});res.status(500).json({error:e.code==='ENOENT'?'yt-dlp is not installed on the server.':'Server error.'})}
});
app.get('*',(req,res)=>res.sendFile(path.resolve('public/index.html')));
app.listen(PORT,()=>console.log(`YoqArt server listening on ${PORT}`));
