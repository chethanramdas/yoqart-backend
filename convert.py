import sys
from pathlib import Path

def pdf_to_word_pdf2docx(src, dst):
    from pdf2docx import Converter
    cv = Converter(src)
    try:
        cv.convert(dst)
    finally:
        cv.close()

def _docling_document(src):
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    opts = PdfPipelineOptions(do_ocr=True, do_table_structure=True, generate_page_images=False)
    converter = DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)}
    )
    return converter.convert(src).document

def _item_page(item):
    try:
        return item.prov[0].page_no
    except Exception:
        return 1

def _item_text(item):
    return str(getattr(item, "text", "") or "").strip()

def _add_docling_table_docx(docx_doc, table_item, dl_doc):
    try:
        df = table_item.export_to_dataframe(doc=dl_doc)
        values = [list(df.columns)] + df.fillna("").astype(str).values.tolist()
        if not values:
            return
        cols = max(1, max(len(r) for r in values))
        tbl = docx_doc.add_table(rows=len(values), cols=cols)
        tbl.style = "Table Grid"
        for r, row in enumerate(values):
            for c, value in enumerate(row):
                tbl.cell(r, c).text = str(value)
        docx_doc.add_paragraph()
        return
    except Exception:
        pass

    data = getattr(table_item, "data", None)
    rows = max(1, int(getattr(data, "num_rows", 1)))
    cols = max(1, int(getattr(data, "num_cols", 1)))
    tbl = docx_doc.add_table(rows=rows, cols=cols)
    tbl.style = "Table Grid"
    for cell in getattr(data, "table_cells", []) or []:
        r = int(getattr(cell, "start_row_offset_idx", 0))
        c = int(getattr(cell, "start_col_offset_idx", 0))
        if r < rows and c < cols:
            tbl.cell(r, c).text = str(getattr(cell, "text", "") or "")
    docx_doc.add_paragraph()

def pdf_to_word_docling(src, dst):
    from docx import Document
    from docx.shared import Pt
    dl_doc = _docling_document(src)
    out = Document()
    last_page = None
    for item, level in dl_doc.iterate_items():
        label = getattr(getattr(item, "label", None), "name", "")
        page = _item_page(item)
        if last_page is not None and page != last_page and page > last_page:
            out.add_page_break()
        last_page = page
        if label == "TABLE" and hasattr(item, "export_to_dataframe"):
            _add_docling_table_docx(out, item, dl_doc)
            continue
        text = _item_text(item)
        if not text:
            continue
        if label in ("TITLE", "SECTION_HEADER"):
            p = out.add_heading(text, level=max(1, min(3, int(level) + 1)))
        elif label == "LIST_ITEM":
            p = out.add_paragraph(text, style="List Bullet")
        else:
            p = out.add_paragraph(text)
        for run in p.runs:
            run.font.size = Pt(10)
    out.save(dst)

def pdf_to_word(src, dst):
    # Keep pdf2docx first for born-digital PDFs because it often preserves
    # visual layout more closely. Docling is the OCR/table-aware fallback.
    try:
        pdf_to_word_pdf2docx(src, dst)
        if Path(dst).stat().st_size > 1024:
            return "pdf2docx"
    except Exception as e:
        print(f"pdf2docx failed, trying Docling: {e}", file=sys.stderr)
    pdf_to_word_docling(src, dst)
    return "docling"

def _write_df_sheet(wb, name, df):
    from openpyxl.styles import Font, Border, Side, Alignment
    ws = wb.create_sheet(name[:31] or "Sheet")
    thin = Side(style="thin", color="B7BEC9")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    values = [list(df.columns)] + df.fillna("").astype(str).values.tolist()
    for r, row in enumerate(values, 1):
        for c, value in enumerate(row, 1):
            cell = ws.cell(r, c, str(value))
            cell.border = border
            cell.alignment = Alignment(vertical="top", wrap_text=True)
            if r == 1:
                cell.font = Font(bold=True)
    for c in range(1, ws.max_column + 1):
        ws.column_dimensions[ws.cell(1, c).column_letter].width = 20
    ws.freeze_panes = "A2"
    ws.sheet_view.showGridLines = False

def pdf_to_excel_docling(src, dst):
    from openpyxl import Workbook
    dl_doc = _docling_document(src)
    wb = Workbook()
    wb.remove(wb.active)
    tables = list(getattr(dl_doc, "tables", []) or [])
    for i, table in enumerate(tables, 1):
        df = table.export_to_dataframe(doc=dl_doc)
        _write_df_sheet(wb, f"Table {i}", df)
    if not tables:
        ws = wb.create_sheet("Document")
        row = 1
        for item, level in dl_doc.iterate_items():
            if getattr(getattr(item, "label", None), "name", "") == "TABLE":
                continue
            text = _item_text(item)
            if text:
                ws.cell(row, 1, text)
                row += 1
        ws.column_dimensions["A"].width = 100
        ws.sheet_view.showGridLines = False
    wb.save(dst)

def pdf_to_excel_fallback(src, dst):
    import fitz
    import pdfplumber
    from openpyxl import Workbook
    from openpyxl.styles import Border, Side, Alignment
    from openpyxl.utils import get_column_letter
    wb = Workbook()
    wb.remove(wb.active)
    thin = Side(style="thin", color="B7BEC9")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    doc = fitz.open(src)
    try:
        with pdfplumber.open(src) as pl:
            for pi, page in enumerate(doc):
                ws = wb.create_sheet(f"Page {pi + 1}")
                tables = []
                try:
                    tables = pl.pages[pi].extract_tables(table_settings={
                        "vertical_strategy": "lines",
                        "horizontal_strategy": "lines",
                        "intersection_tolerance": 5,
                        "snap_tolerance": 4,
                    }) or []
                except Exception:
                    pass
                row0 = 1
                for table in tables:
                    for row in table:
                        for ci, val in enumerate(row or [], 1):
                            c = ws.cell(row0, ci, val or "")
                            c.border = border
                            c.alignment = Alignment(vertical="top", wrap_text=True)
                        row0 += 1
                    row0 += 1
                if not tables:
                    for block in page.get_text("blocks"):
                        text = str(block[4]).strip() if len(block) > 4 else ""
                        if text:
                            ws.cell(row0, 1, text)
                            row0 += 1
                for ci in range(1, ws.max_column + 1):
                    ws.column_dimensions[get_column_letter(ci)].width = 20
                ws.sheet_view.showGridLines = False
    finally:
        doc.close()
    wb.save(dst)

def pdf_to_excel(src, dst):
    try:
        pdf_to_excel_docling(src, dst)
        if Path(dst).stat().st_size > 1024:
            return "docling"
    except Exception as e:
        print(f"Docling Excel conversion failed, using fallback: {e}", file=sys.stderr)
    pdf_to_excel_fallback(src, dst)
    return "fallback"

if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("Usage: convert.py word|excel input.pdf output")
    kind, src, dst = sys.argv[1:]
    if kind == "word":
        engine = pdf_to_word(src, dst)
    elif kind == "excel":
        engine = pdf_to_excel(src, dst)
    else:
        raise SystemExit("Unknown conversion")
    print(f"conversion_engine={engine}")
