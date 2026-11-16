// The processing server also serves public/ for local integration and browser QA.
// Account APIs run in Cloudflare Pages; use the isolated D1/R2 test suite for those.
import {spawn} from 'node:child_process';
const args=process.argv.slice(2);const port=args.includes('--port')?args[args.indexOf('--port')+1]:'3000';
const child=spawn(process.execPath,['server.js'],{stdio:'inherit',env:{...process.env,PORT:port,YOQART_USE_DOCLING:'0'}});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));child.on('exit',code=>process.exit(code||0));
