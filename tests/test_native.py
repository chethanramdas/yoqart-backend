import unittest, tempfile, subprocess, os, io, json, time, urllib.request, urllib.error, zipfile
from pathlib import Path
from pypdf import PdfReader
from reportlab.pdfgen import canvas
from reportlab.platypus import SimpleDocTemplate, Table
from docx import Document
from openpyxl import load_workbook, Workbook

ROOT=Path(__file__).resolve().parents[1]
class NativeProcessing(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.temp=tempfile.TemporaryDirectory();cls.d=Path(cls.temp.name)
  c=canvas.Canvas(str(cls.d/'text.pdf'))
  for i in range(3):c.drawString(50,700,f'YoqArt page {i+1} integrity check.');c.showPage()
  c.save()
  SimpleDocTemplate(str(cls.d/'table.pdf')).build([Table([['Product','Qty','Amount'],['Apple','2','123.50'],['Pear','3','200.00']],colWidths=[180,100,100],style=[('GRID',(0,0),(-1,-1),1,'black')])])
  doc=Document();doc.add_paragraph('YoqArt Office conversion integrity check.');doc.save(cls.d/'office.docx')
  wb=Workbook();wb.active.append(['Product','Amount']);wb.active.append(['Apple',123.5]);wb.save(cls.d/'office.xlsx')
  env={**os.environ,'PORT':'3111','YOQART_USE_DOCLING':'0','YOQART_OCR':'0'}
  cls.server=subprocess.Popen(['node','server.js'],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  for _ in range(100):
   try:urllib.request.urlopen('http://localhost:3111/health',timeout=2);break
   except:time.sleep(.1)
 @classmethod
 def tearDownClass(cls):cls.server.terminate();cls.server.wait(timeout=10);cls.temp.cleanup()
 def request(self,path,file=None,fields=None):
  headers={};body=None
  if file:
   boundary='YoqArtBoundary';body=b''
   for k,v in (fields or {}).items():body+=f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
   body+=f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode()+file.read_bytes()+f'\r\n--{boundary}--\r\n'.encode();headers['Content-Type']='multipart/form-data; boundary='+boundary
  try:r=urllib.request.urlopen(urllib.request.Request('http://localhost:3111'+path,data=body,headers=headers),timeout=120)
  except urllib.error.HTTPError as e:r=e
  return r.status,r.headers,r.read()
 def test_01_health(self):
  status,h,b=self.request('/health');data=json.loads(b);self.assertEqual(status,200);self.assertTrue(data['engines']['gs']);self.assertTrue(data['engines']['pypdf'])
 def test_02_word(self):
  s,h,b=self.request('/api/processing/convert/pdf-to-word',self.d/'text.pdf');self.assertEqual(s,200,b);self.assertIn('wordprocessingml',h['Content-Type']);self.assertIn('YoqArt', '\n'.join(p.text for p in Document(io.BytesIO(b)).paragraphs));self.assertIsNone(zipfile.ZipFile(io.BytesIO(b)).testzip())
 def test_03_excel(self):
  s,h,b=self.request('/convert/pdf-to-excel',self.d/'table.pdf');self.assertEqual(s,200,b);w=load_workbook(io.BytesIO(b));values=[v for s in w for row in s for v in row if v.value is not None];self.assertTrue(any(v.value==123.5 for v in values));self.assertIsNone(zipfile.ZipFile(io.BytesIO(b)).testzip())
 def test_04_protect_unlock(self):
  s,h,b=self.request('/protect-pdf',self.d/'text.pdf',{'password':'test-password'});self.assertEqual(s,200,b);r=PdfReader(io.BytesIO(b));self.assertTrue(r.is_encrypted);self.assertEqual(r.decrypt('bad'),0);self.assertNotEqual(r.decrypt('test-password'),0);self.assertEqual(len(r.pages),3);(self.d/'encrypted.pdf').write_bytes(b)
  s,h,b=self.request('/unlock-pdf',self.d/'encrypted.pdf',{'password':'wrong'});self.assertEqual(s,422)
  s,h,b=self.request('/unlock-pdf',self.d/'encrypted.pdf',{'password':'test-password'});self.assertEqual(s,200,b);r=PdfReader(io.BytesIO(b));self.assertFalse(r.is_encrypted);self.assertEqual(len(r.pages),3)
 def test_05_compress(self):
  source=self.d/'text.pdf';s,h,b=self.request('/compress-pdf',source,{'quality':'printer'});self.assertEqual(s,200,b);self.assertEqual(len(PdfReader(io.BytesIO(b)).pages),3);self.assertEqual(h['X-YoqArt-Reduced'],str(len(b)<source.stat().st_size).lower());self.assertLessEqual(len(b),source.stat().st_size)
 def test_06_office_word(self):
  s,h,b=self.request('/convert/word-to-pdf',self.d/'office.docx');self.assertEqual(s,200,b);self.assertIn('YoqArt',''.join(p.extract_text() for p in PdfReader(io.BytesIO(b)).pages))
 def test_07_office_excel(self):
  s,h,b=self.request('/convert/excel-to-pdf',self.d/'office.xlsx');self.assertEqual(s,200,b);self.assertIn('123.5',''.join(p.extract_text() for p in PdfReader(io.BytesIO(b)).pages))
 def test_08_repair(self):
  s,h,b=self.request('/repair-pdf',self.d/'text.pdf');self.assertEqual(s,200,b);self.assertEqual(len(PdfReader(io.BytesIO(b)).pages),3)
 def test_09_invalid_upload(self):
  f=self.d/'fake.pdf';f.write_text('not a PDF');s,h,b=self.request('/compress-pdf',f);self.assertEqual(s,400);self.assertIn('not a valid PDF',json.loads(b)['error'])
 def test_10_missing_api(self):
  s,h,b=self.request('/api/nonexistent');self.assertEqual(s,404);self.assertIn('application/json',h['Content-Type'])
if __name__=='__main__':unittest.main()
