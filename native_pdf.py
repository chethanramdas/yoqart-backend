"""Small, bounded native operations; input/output paths come from the server."""
import sys, os, subprocess, tempfile, shutil
from pypdf import PdfReader, PdfWriter

def validate(src, password=None):
 r=PdfReader(src)
 if r.is_encrypted and not r.decrypt(password or ''): raise ValueError('Password required or incorrect')
 if not 1 <= len(r.pages) <= int(os.getenv('YOQART_MAX_PAGES','300')): raise ValueError('Unsupported page count')
 return r

def process(kind,src,dst,password=''):
 if kind=='office':
  binary=shutil.which('libreoffice') or shutil.which('soffice')
  if not binary: raise RuntimeError('LibreOffice is not installed')
  with tempfile.TemporaryDirectory(prefix='yoqart-office-') as profile:
   r=subprocess.run([binary,'-env:UserInstallation=file://'+profile,'--headless','--convert-to','pdf','--outdir',os.path.dirname(dst),src],capture_output=True,timeout=100)
   generated=os.path.join(os.path.dirname(dst),os.path.splitext(os.path.basename(src))[0]+'.pdf')
   if r.returncode or not os.path.isfile(generated): raise ValueError('Office conversion failed')
   if generated!=dst: shutil.move(generated,dst)
  validate(dst)
 elif kind=='protect':
  r=validate(src);w=PdfWriter();w.append(r);w.encrypt(password,algorithm='AES-256')
  with open(dst,'wb') as f:w.write(f)
  validate(dst,password)
  if not PdfReader(dst).is_encrypted: raise ValueError('Encryption failed')
 elif kind=='unlock':
  r=validate(src,password);w=PdfWriter();w.append(r)
  with open(dst,'wb') as f:w.write(f)
  validate(dst)
 elif kind=='repair':
  import fitz
  d=fitz.open(src)
  if d.needs_pass:raise ValueError('Unlock the PDF first')
  if not 1<=len(d)<=300:raise ValueError('Unsupported page count')
  d.save(dst,garbage=4,deflate=True);d.close();validate(dst)
 elif kind=='verify':
  a=validate(src);b=validate(dst)
  if len(a.pages)!=len(b.pages):raise ValueError('Page count changed')
 else:raise ValueError('Unsupported operation')

if __name__=='__main__':
 try:process(sys.argv[1],sys.argv[2],sys.argv[3],sys.stdin.read(256))
 except Exception as e:
  # No document text, credential, or local path in logs.
  print(type(e).__name__,file=sys.stderr);sys.exit(1)
