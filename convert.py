"""YoqArt PDF conversion engine.

Usage:
  convert.py word  <src.pdf> <dst.docx>
  convert.py excel <src.pdf> <dst.xlsx>
  convert.py verify-encrypted <file.pdf> <password>
  convert.py engines

Pipeline: Docling (layout / table structure / OCR) -> tested fallback (pdf2docx / pdfplumber + OCR) -> output validation.
Exit codes: 0 ok, 1 failure, 3 encrypted input, 4 no extractable content.
The last stdout line on success is the engine name that produced the file.
"""
import sys, os, re, io, json, shutil, subprocess, tempfile, zipfile, traceback

EXIT_FAIL, EXIT_ENCRYPTED, EXIT_EMPTY = 1, 3, 4
USE_DOCLING = os.environ.get('YOQART_USE_DOCLING', '1') != '0'
USE_OCR = os.environ.get('YOQART_OCR', '1') != '0'
MAX_PAGES = int(os.environ.get('YOQART_MAX_PAGES', '300'))


class Fail(Exception):
    def __init__(self, msg, code=EXIT_FAIL):
        super().__init__(msg); self.code = code


def log(*a):
    print(*a, file=sys.stderr)


# ---------------------------------------------------------------- input checks
def check_input(src):
    from pypdf import PdfReader
    try:
        r = PdfReader(src)
        if r.is_encrypted:
            try:
                ok = r.decrypt('')
            except Exception:
                ok = 0
            if not ok:
                raise Fail('encrypted', EXIT_ENCRYPTED)
        n = len(r.pages)
    except Fail:
        raise
    except Exception as e:
        raise Fail(f'unreadable pdf: {e}')
    if n == 0:
        raise Fail('pdf has no pages')
    if n > MAX_PAGES:
        raise Fail(f'pdf has {n} pages (limit {MAX_PAGES})')
    return n


# ---------------------------------------------------------------- OCR helper (tesseract CLI)
def have(binary):
    return shutil.which(binary) is not None


def ocr_pages(src, dpi=200):
    """Return list of per-page OCR text using poppler + tesseract. Empty list if tools missing."""
    if not (USE_OCR and have('pdftoppm') and have('tesseract')):
        return []
    out = []
    with tempfile.TemporaryDirectory(prefix='yq-ocr-') as d:
        subprocess.run(['pdftoppm', '-r', str(dpi), '-png', src, os.path.join(d, 'p')], check=True, timeout=240,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for f in sorted(x for x in os.listdir(d) if x.endswith('.png')):
            r = subprocess.run(['tesseract', os.path.join(d, f), '-', '--psm', '6'], capture_output=True, text=True, timeout=120)
            out.append(r.stdout if r.returncode == 0 else '')
    return out


# ---------------------------------------------------------------- number parsing for Excel
_num = re.compile(r'^\(?[-+]?\s*(?:[$€£₹¥]|Rs\.?|INR|USD)?\s*[-+]?\d[\d,]*(?:\.\d+)?\s*%?\)?$', re.I)


def coerce(val):
    """Turn '₹1,234.50', '(500)', '12%' into (number, number_format). Anything else stays text."""
    if val is None:
        return '', None
    if not isinstance(val, str):
        return val, None
    s = val.strip()
    if not s:
        return '', None
    if not _num.match(s):
        return s, None
    neg = s.startswith('(') and s.endswith(')') or s.startswith('-') or '(-' in s
    pct = s.endswith('%')
    sym = re.search(r'[$€£₹¥]|Rs\.?|INR|USD', s, re.I)
    digits = re.sub(r'[^\d.]', '', s)
    if digits.count('.') > 1 or not digits or digits == '.':
        return s, None
    # Leading zeros ("007", phone / account numbers) are identifiers, keep as text.
    if re.match(r'^0\d', digits) and '.' not in digits and not sym and not pct:
        return s, None
    try:
        n = float(digits)
    except ValueError:
        return s, None
    if neg:
        n = -n
    if pct:
        return n / 100.0, '0.00%' if '.' in digits else '0%'
    if n == int(n) and '.' not in digits:
        n = int(n)
        return n, '#,##0' if ',' in s or abs(n) >= 1000 else None
    return n, '#,##0.00'


# ---------------------------------------------------------------- XLSX writer
def write_workbook(sheets, dst):
    """sheets: list of (title, [ [cells...], ... ], header_rows_count)"""
    from openpyxl import Workbook
    from openpyxl.styles import Font, Border, Side, Alignment, PatternFill
    from openpyxl.utils import get_column_letter
    wb = Workbook(); wb.remove(wb.active)
    thin = Side(style='thin', color='B7BEC9'); border = Border(left=thin, right=thin, top=thin, bottom=thin)
    used = set()
    for title, rows, hdr in sheets:
        t = re.sub(r'[\[\]\*\?/\\:]', ' ', title)[:28] or 'Sheet'
        base, i = t, 2
        while t in used:
            t = f'{base[:25]} {i}'; i += 1
        used.add(t)
        ws = wb.create_sheet(t)
        for ri, row in enumerate(rows, 1):
            for ci, raw in enumerate(row, 1):
                v, fmt = coerce(raw)
                c = ws.cell(ri, ci, v)
                if isinstance(v,str): c.data_type = "s"  # PDF text must never become an Excel formula.
                if fmt: c.number_format = fmt
                c.alignment = Alignment(vertical='top', wrap_text=True, horizontal='right' if isinstance(v, (int, float)) else None)
                c.border = border
                if ri <= hdr:
                    c.font = Font(bold=True); c.fill = PatternFill('solid', fgColor='EEF0F7')
        widths = {}
        for row in rows:
            for ci, raw in enumerate(row, 1):
                widths[ci] = max(widths.get(ci, 8), min(48, len(str(raw or '')) + 2))
        for ci, w in widths.items():
            ws.column_dimensions[get_column_letter(ci)].width = w
        if hdr: ws.freeze_panes = ws.cell(hdr + 1, 1)
        ws.page_setup.fitToWidth = 1; ws.page_setup.fitToHeight = 0
    if not wb.sheetnames:
        raise Fail('no data', EXIT_EMPTY)
    wb.save(dst)


def validate_xlsx(path):
    from openpyxl import load_workbook
    if not os.path.isfile(path) or os.path.getsize(path) == 0:
        raise Fail('xlsx missing/empty')
    wb = load_workbook(path)
    if not wb.sheetnames:
        raise Fail('xlsx has no sheets')
    cells = sum(1 for ws in wb for row in ws.iter_rows() for c in row if c.value not in (None, ''))
    if cells == 0:
        raise Fail('xlsx has no data', EXIT_EMPTY)


def validate_docx(path):
    import docx
    if not os.path.isfile(path) or os.path.getsize(path) == 0:
        raise Fail('docx missing/empty')
    if not zipfile.is_zipfile(path):
        raise Fail('docx is not a zip package')
    with zipfile.ZipFile(path) as z:
        if z.testzip() is not None or 'word/document.xml' not in z.namelist():
            raise Fail('docx structure invalid')
    d = docx.Document(path)
    text = ''.join(p.text for p in d.paragraphs).strip()
    has_media = any(r.reltype.endswith('/image') for r in d.part.rels.values())
    if not text and not d.tables and not has_media:
        raise Fail('docx has no content', EXIT_EMPTY)


# ---------------------------------------------------------------- Docling
_docling_conv = None


def docling_converter():
    """Build a DocumentConverter once. Uses current documented Docling API (PdfPipelineOptions)."""
    global _docling_conv
    if _docling_conv is not None:
        return _docling_conv
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    opts = PdfPipelineOptions()
    opts.do_ocr = USE_OCR                       # OCRs bitmap regions; selectable text is read directly
    opts.do_table_structure = True              # TableFormer
    opts.table_structure_options.do_cell_matching = True
    opts.generate_picture_images = True         # needed for embedding figures in DOCX
    opts.images_scale = 2.0
    if os.environ.get('YOQART_OCR_ENGINE', '').lower() == 'tesseract':
        from docling.datamodel.pipeline_options import TesseractCliOcrOptions
        opts.ocr_options = TesseractCliOcrOptions()
    _docling_conv = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)})
    return _docling_conv


def docling_convert(src):
    res = docling_converter().convert(src)
    return res.document


def docling_table_rows(table, doc):
    """Rows (list of list of str) + number of header rows from a Docling TableItem."""
    data = table.data
    nrows, ncols = data.num_rows, data.num_cols
    grid = [[''] * ncols for _ in range(nrows)]
    hdr = 0
    for cell in data.table_cells:
        txt = (cell.text or '').strip()
        r0, r1 = cell.start_row_offset_idx, cell.end_row_offset_idx
        c0, c1 = cell.start_col_offset_idx, cell.end_col_offset_idx
        for r in range(r0, min(r1, nrows)):
            for c in range(c0, min(c1, ncols)):
                if r == r0 and c == c0:
                    grid[r][c] = txt
        if getattr(cell, 'column_header', False):
            hdr = max(hdr, r1)
    grid = [row for row in grid if any(x for x in row)]
    return grid, min(hdr, len(grid))


def table_page(item):
    try:
        return item.prov[0].page_no
    except Exception:
        return None


def docling_to_excel(src, dst):
    doc = docling_convert(src)
    sheets, counts = [], {}
    for t in doc.tables:
        rows, hdr = docling_table_rows(t, doc)
        if not rows or max(len(r) for r in rows) < 1:
            continue
        pg = table_page(t) or 0
        counts[pg] = counts.get(pg, 0) + 1
        sheets.append((f'P{pg} Table {counts[pg]}', rows, hdr))
    sheets = merge_continued_tables(sheets)
    if not sheets:
        # No tables detected: keep the text, one line per row, so the workbook is never empty.
        lines = [t.strip() for t in doc.export_to_text().splitlines() if t.strip()] if hasattr(doc, 'export_to_text') else []
        if not lines:
            raise Fail('docling found no tables or text', EXIT_EMPTY)
        sheets = [('Text', [[l] for l in lines], 0)]
    write_workbook(sheets, dst)


def merge_continued_tables(sheets):
    """Join tables on consecutive pages that share the same column count (multi-page tables)."""
    out = []
    for title, rows, hdr in sheets:
        m = re.match(r'P(\d+) ', title)
        pg = int(m.group(1)) if m else None
        if out and pg is not None and out[-1][3] is not None and pg == out[-1][3] + 1 \
                and rows and len(rows[0]) == len(out[-1][1][0]):
            prev = out[-1]
            body = rows[hdr:] if hdr and rows[:hdr] == prev[1][:prev[2]] else rows
            out[-1] = (prev[0], prev[1] + body, prev[2], pg)
        else:
            out.append((title, rows, hdr, pg))
    return [(t, r, h) for t, r, h, _ in out]


def docling_to_word(src, dst):
    import docx
    from docx.shared import Inches
    from docling_core.types.doc import DocItemLabel
    doc = docling_convert(src)
    d = docx.Document()
    wrote = False
    for item, level in doc.iterate_items():
        cls = type(item).__name__
        label = getattr(item, 'label', None)
        if cls == 'TableItem':
            rows, hdr = docling_table_rows(item, doc)
            if rows:
                ncols = max(len(r) for r in rows)
                t = d.add_table(rows=len(rows), cols=ncols)
                t.style = 'Table Grid'
                for ri, r in enumerate(rows):
                    for ci, v in enumerate(r):
                        cell = t.cell(ri, ci); cell.text = v
                        if ri < hdr:
                            for p in cell.paragraphs:
                                for run in p.runs: run.bold = True
                d.add_paragraph(); wrote = True
        elif cls == 'PictureItem':
            try:
                img = item.get_image(doc)
                if img is not None:
                    buf = io.BytesIO(); img.convert('RGB').save(buf, 'PNG'); buf.seek(0)
                    d.add_picture(buf, width=Inches(min(6.0, max(1.0, img.width / 144.0)))); wrote = True
            except Exception as e:
                log('picture skipped:', e)
        elif cls == 'SectionHeaderItem' or label == DocItemLabel.TITLE:
            txt = (getattr(item, 'text', '') or '').strip()
            if txt:
                lvl = 0 if label == DocItemLabel.TITLE else min(max(getattr(item, 'level', 1), 1), 4)
                d.add_heading(txt, level=lvl); wrote = True
        elif cls == 'ListItem':
            txt = (item.text or '').strip()
            if txt:
                d.add_paragraph(txt, style='List Number' if getattr(item, 'enumerated', False) else 'List Bullet'); wrote = True
        elif label in (DocItemLabel.PAGE_HEADER, DocItemLabel.PAGE_FOOTER):
            continue
        elif hasattr(item, 'text'):
            txt = (item.text or '').strip()
            if txt:
                d.add_paragraph(txt); wrote = True
    if not wrote:
        raise Fail('docling produced no content', EXIT_EMPTY)
    d.save(dst)


# ---------------------------------------------------------------- Fallback converters
def fallback_word(src, dst):
    """pdf2docx (layout-preserving) first; if unavailable/failing, pdfplumber+python-docx; scanned pages via OCR."""
    try:
        from pdf2docx import Converter
        cv = Converter(src)
        try:
            cv.convert(dst)
        finally:
            cv.close()
        validate_docx(dst)
        return 'pdf2docx'
    except Fail as e:
        if e.code == EXIT_EMPTY:
            log('pdf2docx output empty, trying text/OCR path')
        else:
            log('pdf2docx invalid output:', e)
    except Exception as e:
        log('pdf2docx unavailable/failed:', e)
    if os.path.exists(dst):
        os.remove(dst)
    return plumber_word(src, dst)



def page_blocks(page):
    """Split a pdfplumber page into ('h1'|'h2'|'h3'|'p', text) blocks using font size and line spacing."""
    chars = page.chars
    if not chars:
        return []
    from collections import defaultdict
    lines = defaultdict(list)
    for c in chars:
        if c['text'].strip() or True:
            lines[round(c['top'] / 2)].append(c)
    # merge buckets that belong to the same visual line
    rows = []
    for k in sorted(lines):
        cs = sorted(lines[k], key=lambda c: c['x0'])
        top = min(c['top'] for c in cs)
        if rows and abs(top - rows[-1]['top']) < 2.5:
            rows[-1]['chars'] += cs; rows[-1]['chars'].sort(key=lambda c: c['x0'])
        else:
            rows.append({'top': top, 'bottom': max(c['bottom'] for c in cs), 'chars': cs})
    sizes = sorted(c['size'] for r in rows for c in r['chars'] if c['text'].strip())
    if not sizes:
        return []
    body = sizes[len(sizes) // 2]
    out, cur, prev_bottom, prev_kind = [], [], None, None
    def flush():
        nonlocal cur
        if cur:
            out.append((prev_kind, ' '.join(cur))); cur = []
    for r in rows:
        txt = ''
        last = None
        for c in r['chars']:
            if last is not None and c['x0'] - last['x1'] > max(1.0, c['size'] * 0.2):
                txt += ' '
            txt += c['text']; last = c
        txt = ' '.join(txt.split())
        if not txt:
            continue
        sz = max(c['size'] for c in r['chars'] if c['text'].strip())
        kind = 'h1' if sz >= body * 1.6 else 'h2' if sz >= body * 1.3 else 'h3' if sz >= body * 1.12 else 'p'
        height = max(r['bottom'] - r['top'], 1)
        gap = (r['top'] - prev_bottom) if prev_bottom is not None else 0
        if cur and (kind != prev_kind or kind != 'p' or gap > height * 0.6):
            flush()
        prev_kind = kind
        cur.append(txt)
        prev_bottom = r['bottom']
    flush()
    return out

def plumber_word(src, dst):
    import pdfplumber, docx
    d = docx.Document()
    wrote = False
    ocr = None
    with pdfplumber.open(src) as pdf:
        for pi, page in enumerate(pdf.pages):
            if pi:
                d.add_page_break()
            tables = []
            try:
                tables = page.find_tables()
            except Exception:
                pass
            boxes = [t.bbox for t in tables]
            def outside(obj):
                cx, cy = (obj['x0'] + obj['x1']) / 2, (obj['top'] + obj['bottom']) / 2
                return not any(b[0] <= cx <= b[2] and b[1] <= cy <= b[3] for b in boxes)
            blocks = []
            try:
                blocks = page_blocks(page.filter(outside) if boxes else page)
            except Exception as e:
                log('layout analysis failed, plain text used:', e)
                txt = page.extract_text() or ''
                blocks = [('p', ' '.join(x.split())) for x in re.split(r'\n\s*\n', txt) if x.strip()]
            if not blocks and not tables:
                if ocr is None:
                    ocr = ocr_pages(src)
                txt = ocr[pi] if pi < len(ocr) else ''
                blocks = [('p', ' '.join(x.split())) for x in re.split(r'\n\s*\n', txt) if x.strip()]
            for kind, txt in blocks:
                if kind.startswith('h'):
                    d.add_heading(txt, level=int(kind[1])); wrote = True
                else:
                    d.add_paragraph(txt); wrote = True
            for t in tables:
                rows = [[(c or '').strip() for c in r] for r in (t.extract() or [])]
                rows = [r for r in rows if any(r)]
                if rows:
                    ncols = max(len(r) for r in rows)
                    tb = d.add_table(rows=len(rows), cols=ncols); tb.style = 'Table Grid'
                    for ri, r in enumerate(rows):
                        for ci, v in enumerate(r):
                            tb.cell(ri, ci).text = v
                    d.add_paragraph(); wrote = True
    if not wrote:
        raise Fail('no text found', EXIT_EMPTY)
    d.save(dst)
    return 'pdfplumber+python-docx'


def looks_like_table(t, strict=False):
    if not t or len(t) < 2 or max(len(r) for r in t) < 2:
        return False
    if not strict:
        return True
    # Text-alignment detection also fires on prose; require a real grid: >=3 rows, >=3 cols, most rows multi-cell,
    # and a meaningful share of numeric cells.
    ncols = max(len(r) for r in t)
    filled = [sum(1 for c in r if (c or '').strip()) for r in t]
    multi = sum(1 for f in filled if f >= 2)
    cells = [(c or '').strip() for r in t for c in r if (c or '').strip()]
    numeric = sum(1 for c in cells if _num.match(c))
    return len(t) >= 3 and ncols >= 3 and multi >= 0.7 * len(t) and numeric >= 0.25 * max(len(cells), 1)


def fallback_excel(src, dst):
    import pdfplumber
    sheets, counts = [], {}
    text_rows = {}
    strategies = [
        {'vertical_strategy': 'lines', 'horizontal_strategy': 'lines', 'snap_tolerance': 4, 'intersection_tolerance': 5},
        {'vertical_strategy': 'text', 'horizontal_strategy': 'text', 'snap_tolerance': 4, 'min_words_vertical': 2, 'min_words_horizontal': 2},
    ]
    with pdfplumber.open(src) as pdf:
        for pi, page in enumerate(pdf.pages, 1):
            found = []
            for ts in strategies:
                try:
                    found = [t for t in page.extract_tables(table_settings=ts) or [] if looks_like_table(t, strict=ts['vertical_strategy'] == 'text')]
                except Exception:
                    found = []
                if found:
                    break
            for t in found:
                rows = [[(c or '').replace('\n', ' ').strip() for c in r] for r in t]
                rows = [r for r in rows if any(r)]
                if rows:
                    counts[pi] = counts.get(pi, 0) + 1
                    sheets.append((f'P{pi} Table {counts[pi]}', rows, 1))
            if not found:
                try:
                    lines = (page.extract_text() or '').splitlines()
                except Exception:
                    lines = []
                text_rows[pi] = [re.split(r'\s{2,}', l.strip()) for l in lines if l.strip()]
    sheets = merge_continued_tables(sheets)
    if not sheets:
        if not any(text_rows.values()):
            ocr = ocr_pages(src)
            for pi, t in enumerate(ocr, 1):
                text_rows[pi] = [re.split(r'\s{2,}', l.strip()) for l in t.splitlines() if l.strip()]
        for pi, rows in text_rows.items():
            if rows:
                sheets.append((f'Page {pi}', rows, 0))
    if not sheets:
        raise Fail('no tables or text', EXIT_EMPTY)
    write_workbook(sheets, dst)
    return 'pdfplumber+openpyxl'


# ---------------------------------------------------------------- Orchestration
def convert(kind, src, dst):
    check_input(src)
    primary = docling_to_word if kind == 'word' else docling_to_excel
    fallback = fallback_word if kind == 'word' else fallback_excel
    validate = validate_docx if kind == 'word' else validate_xlsx
    engine = None
    if USE_DOCLING:
        try:
            primary(src, dst)
            validate(dst)
            engine = 'docling'
        except ImportError as e:
            log('Docling not installed:', e)
        except Exception as e:
            log('Docling failed, using fallback:', repr(e)); log(traceback.format_exc()[-1500:])
        if engine is None and os.path.exists(dst):
            os.remove(dst)
    if engine is None:
        engine = fallback(src, dst)
        validate(dst)
    print(engine)


def verify_encrypted(path, pw):
    from pypdf import PdfReader
    r = PdfReader(path)
    if not r.is_encrypted:
        raise Fail('output not encrypted')
    if r.decrypt('') != 0:
        raise Fail('output opens without password')
    if r.decrypt(pw) == 0:
        raise Fail('password does not open output')
    if len(r.pages) == 0:
        raise Fail('no pages')


def engines():
    out = {}
    for m in ('docling', 'pdf2docx', 'pdfplumber', 'openpyxl', 'docx', 'pypdf'):
        try:
            __import__(m); out[m] = True
        except Exception:
            out[m] = False
    out['tesseract'] = have('tesseract'); out['pdftoppm'] = have('pdftoppm')
    print(json.dumps(out))


if __name__ == '__main__':
    try:
        cmd = sys.argv[1]
        if cmd in ('word', 'excel'):
            convert(cmd, sys.argv[2], sys.argv[3])
        elif cmd == 'verify-encrypted':
            verify_encrypted(sys.argv[2], sys.argv[3])
        elif cmd == 'engines':
            engines()
        else:
            raise SystemExit('Unknown command')
    except Fail as e:
        log('FAIL:', e); sys.exit(e.code)
    except SystemExit:
        raise
    except Exception:
        log(traceback.format_exc()); sys.exit(EXIT_FAIL)
