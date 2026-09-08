import sys,re

def pdf_to_word(src,dst):
 from pdf2docx import Converter
 cv=Converter(src)
 try: cv.convert(dst,start=0,end=None)
 finally: cv.close()
def cluster(vals,tol):
 out=[]
 for v in sorted(vals):
  if not out or abs(v-out[-1][-1])>tol: out.append([v])
  else: out[-1].append(v)
 return [sum(g)/len(g) for g in out]
def fontname(n):
 n=(n or 'Arial').split('+')[-1]; n=re.sub(r'[-,_](Bold|Italic|Roman|Regular|MT|PS)$','',n,flags=re.I); return n[:31] or 'Arial'
def pdf_to_excel(src,dst):
 import fitz,pdfplumber
 from openpyxl import Workbook
 from openpyxl.styles import Font,Border,Side,Alignment
 from openpyxl.utils import get_column_letter
 wb=Workbook();wb.remove(wb.active);doc=fitz.open(src);thin=Side(style='thin',color='B8BEC8');border=Border(left=thin,right=thin,top=thin,bottom=thin)
 with pdfplumber.open(src) as pl:
  for pi,page in enumerate(doc):
   ws=wb.create_sheet(f'Page {pi+1}'); tables=[]
   try: tables=pl.pages[pi].extract_tables(table_settings={'vertical_strategy':'lines','horizontal_strategy':'lines','intersection_tolerance':5,'snap_tolerance':4}) or []
   except: pass
   if tables:
    for table in tables:
     if not table: continue
     start=ws.max_row+2 if ws.max_row else 1
     for ri,row in enumerate(table,start):
      for ci,val in enumerate(row or [],1):
       c=ws.cell(ri,ci,val or '');c.border=border;c.alignment=Alignment(vertical='top',wrap_text=True);c.font=Font(name='Arial',bold=ri==start)
    for ci in range(1,ws.max_column+1): ws.column_dimensions[get_column_letter(ci)].width=18
   else:
    words=page.get_text('words');ys=cluster([w[1] for w in words],6) if words else [];xs=cluster([w[0] for w in words],14) if words else []
    for w in words:
     x0,y0,x1,y1,text=w[:5];r=min(range(len(ys)),key=lambda i:abs(ys[i]-y0))+1;c=min(range(len(xs)),key=lambda i:abs(xs[i]-x0))+1;cell=ws.cell(r,c);cell.value=(str(cell.value)+' '+text).strip() if cell.value else text;cell.border=border;cell.alignment=Alignment(vertical='top',wrap_text=True)
    for ci,x in enumerate(xs,1): ws.column_dimensions[get_column_letter(ci)].width=max(8,min(35,((xs[ci] if ci<len(xs) else x+90)-x)/7))
    try:
     for block in page.get_text('dict').get('blocks',[]):
      for line in block.get('lines',[]):
       for sp in line.get('spans',[]):
        if not sp.get('text','').strip(): continue
        r=min(range(len(ys)),key=lambda i:abs(ys[i]-sp['bbox'][1]))+1;c=min(range(len(xs)),key=lambda i:abs(xs[i]-sp['bbox'][0]))+1;ws.cell(r,c).font=Font(name=fontname(sp.get('font')),size=max(8,min(18,float(sp.get('size',10)))),bold=bool(sp.get('flags',0)&16),italic=bool(sp.get('flags',0)&2));break
    except: pass
   ws.sheet_view.showGridLines=False;ws.page_setup.fitToWidth=1;ws.page_setup.fitToHeight=0
 doc.close();wb.save(dst)
if __name__=='__main__':
 kind,src,dst=sys.argv[1:];pdf_to_word(src,dst) if kind=='word' else pdf_to_excel(src,dst)
