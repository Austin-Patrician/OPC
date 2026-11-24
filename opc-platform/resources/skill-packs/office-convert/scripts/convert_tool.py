#!/usr/bin/env python3
"""Local offline document format conversion CLI (Markdown / DOCX / PDF / XLSX)."""

from __future__ import annotations

import argparse
import html as html_lib
import json
import os
import sys
from pathlib import Path
from typing import Any, List, Optional, Sequence

import mammoth
import markdown as md_lib
import openpyxl
import pdfplumber
from bs4 import BeautifulSoup, NavigableString, Tag
from docx import Document
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import nsdecls, qn
from docx.shared import Pt, RGBColor
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, Preformatted, SimpleDocTemplate, Spacer, Table, TableStyle


def ensure_parent(path_str: str) -> Path:
    target = Path(path_str)
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def find_cjk_font() -> Optional[str]:
    candidates = [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/System/Library/Fonts/Supplemental/Songti.ttc",
        "/Library/Fonts/Arial Unicode.ttf",
        "C:\\Windows\\Fonts\\msyh.ttc",
        "C:\\Windows\\Fonts\\simsun.ttc",
        "C:\\Windows\\Fonts\\simhei.ttf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    return None


def register_pdf_font() -> str:
    font_path = find_cjk_font()
    if font_path:
        font_name = "OpcCjkBody"
        try:
            if font_path.lower().endswith(".ttc"):
                pdfmetrics.registerFont(TTFont(font_name, font_path, subfontIndex=0))
            else:
                pdfmetrics.registerFont(TTFont(font_name, font_path))
            return font_name
        except Exception:
            pass
    return "Helvetica"


def md_to_soup(md_text: str) -> BeautifulSoup:
    rendered = md_lib.markdown(
        md_text,
        extensions=["tables", "fenced_code", "sane_lists", "nl2br"],
    )
    return BeautifulSoup(rendered, "html.parser")


def set_docx_cjk(doc: Document, font_name: str = "PingFang SC") -> None:
    normal = doc.styles["Normal"]
    normal.font.name = font_name
    normal.font.size = Pt(11)
    rpr = normal.element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.insert(0, rfonts)
    rfonts.set(qn("w:eastAsia"), font_name)


def append_inline_runs(paragraph: Any, node: Any, bold: bool = False, italic: bool = False, code: bool = False) -> None:
    if isinstance(node, NavigableString):
        text = str(node)
        if text:
            run = paragraph.add_run(text)
            run.bold = bold
            run.italic = italic
            if code:
                run.font.name = "Courier New"
                run.font.size = Pt(9.5)
        return
    if not isinstance(node, Tag):
        return
    name = node.name.lower()
    next_bold = bold or name in ("strong", "b")
    next_italic = italic or name in ("em", "i")
    next_code = code or name == "code"
    if name == "br":
        paragraph.add_run("\n")
        return
    for child in node.children:
        append_inline_runs(paragraph, child, next_bold, next_italic, next_code)


def extract_table_rows(table_tag: Tag) -> List[List[str]]:
    rows: List[List[str]] = []
    for tr in table_tag.find_all("tr"):
        cells = [cell.get_text(" ", strip=True) for cell in tr.find_all(["th", "td"])]
        if cells:
            rows.append(cells)
    return rows


def cmd_md_to_docx(args: argparse.Namespace) -> None:
    md_text = Path(args.input).read_text(encoding="utf-8")
    soup = md_to_soup(md_text)
    doc = Document()
    set_docx_cjk(doc)

    for child in soup.children:
        if isinstance(child, NavigableString):
            if child.strip():
                doc.add_paragraph(child.strip())
            continue
        if not isinstance(child, Tag):
            continue
        tag = child.name.lower()
        if tag in ("h1", "h2", "h3", "h4"):
            level = min(4, int(tag[1]))
            doc.add_heading(child.get_text(" ", strip=True), level=level)
        elif tag == "p":
            p = doc.add_paragraph()
            append_inline_runs(p, child)
        elif tag in ("ul", "ol"):
            style = "List Bullet" if tag == "ul" else "List Number"
            for li in child.find_all("li", recursive=False):
                p = doc.add_paragraph(style=style)
                append_inline_runs(p, li)
        elif tag == "pre":
            p = doc.add_paragraph()
            run = p.add_run(child.get_text())
            run.font.name = "Courier New"
            run.font.size = Pt(9.5)
        elif tag == "blockquote":
            p = doc.add_paragraph(child.get_text(" ", strip=True))
            p.paragraph_format.left_indent = Pt(18)
        elif tag == "table":
            rows = extract_table_rows(child)
            if rows:
                cols = max(len(r) for r in rows)
                table = doc.add_table(rows=len(rows), cols=cols)
                table.style = "Table Grid"
                has_header = bool(child.find("th"))
                for r_idx, row in enumerate(rows):
                    for c_idx in range(cols):
                        cell = table.cell(r_idx, c_idx)
                        cell.text = row[c_idx] if c_idx < len(row) else ""
                        if has_header and r_idx == 0:
                            shading = parse_xml(f'<w:shd {nsdecls("w")} w:fill="1F4E78"/>')
                            cell._tc.get_or_add_tcPr().append(shading)
                            for p in cell.paragraphs:
                                for r in p.runs:
                                    r.bold = True
                                    r.font.color.rgb = RGBColor(255, 255, 255)
        else:
            text = child.get_text(" ", strip=True)
            if text:
                doc.add_paragraph(text)

    out = ensure_parent(args.output)
    doc.save(out)
    print(json.dumps({"ok": True, "output": str(out)}, ensure_ascii=False))


def cmd_md_to_pdf(args: argparse.Namespace) -> None:
    md_text = Path(args.input).read_text(encoding="utf-8")
    soup = md_to_soup(md_text)
    font_name = register_pdf_font()

    base = getSampleStyleSheet()
    body_style = ParagraphStyle(
        "OpcBody",
        parent=base["Normal"],
        fontName=font_name,
        fontSize=10.5,
        leading=16,
        spaceAfter=6,
        wordWrap="CJK",
    )
    h_styles = {
        "h1": ParagraphStyle("OpcH1", parent=body_style, fontSize=18, leading=24, spaceBefore=10, spaceAfter=8),
        "h2": ParagraphStyle("OpcH2", parent=body_style, fontSize=14.5, leading=20, spaceBefore=9, spaceAfter=6),
        "h3": ParagraphStyle("OpcH3", parent=body_style, fontSize=12.5, leading=18, spaceBefore=7, spaceAfter=4),
        "h4": ParagraphStyle("OpcH4", parent=body_style, fontSize=11, leading=16, spaceBefore=6, spaceAfter=4),
    }
    code_style = ParagraphStyle(
        "OpcCode",
        parent=body_style,
        fontName=font_name,
        fontSize=9,
        leading=13,
        backColor=colors.HexColor("#F4F5F7"),
        leftIndent=8,
        rightIndent=8,
        spaceBefore=4,
        spaceAfter=8,
    )
    quote_style = ParagraphStyle(
        "OpcQuote",
        parent=body_style,
        leftIndent=14,
        textColor=colors.HexColor("#4B5563"),
    )

    story: List[Any] = []
    for child in soup.children:
        if isinstance(child, NavigableString):
            if child.strip():
                story.append(Paragraph(html_lib.escape(child.strip()), body_style))
            continue
        if not isinstance(child, Tag):
            continue
        tag = child.name.lower()
        if tag in h_styles:
            story.append(Paragraph(html_lib.escape(child.get_text(" ", strip=True)), h_styles[tag]))
        elif tag == "p":
            story.append(Paragraph(html_lib.escape(child.get_text(" ", strip=True)), body_style))
        elif tag in ("ul", "ol"):
            for idx, li in enumerate(child.find_all("li", recursive=False), start=1):
                prefix = "• " if tag == "ul" else f"{idx}. "
                story.append(Paragraph(html_lib.escape(prefix + li.get_text(" ", strip=True)), body_style))
        elif tag == "pre":
            story.append(Preformatted(child.get_text().rstrip(), code_style))
        elif tag == "blockquote":
            story.append(Paragraph(html_lib.escape(child.get_text(" ", strip=True)), quote_style))
        elif tag == "table":
            rows = extract_table_rows(child)
            if rows:
                cols = max(len(r) for r in rows)
                table_data = [
                    [Paragraph(html_lib.escape(row[c] if c < len(row) else ""), body_style) for c in range(cols)]
                    for row in rows
                ]
                tbl = Table(table_data, repeatRows=1 if child.find("th") else 0)
                tbl.setStyle(
                    TableStyle(
                        [
                            ("FONTNAME", (0, 0), (-1, -1), font_name),
                            ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#D1D5DB")),
                            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F3F4F6")),
                            ("VALIGN", (0, 0), (-1, -1), "TOP"),
                            ("TOPPADDING", (0, 0), (-1, -1), 5),
                            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                        ]
                    )
                )
                story.append(tbl)
                story.append(Spacer(1, 6))
        else:
            text = child.get_text(" ", strip=True)
            if text:
                story.append(Paragraph(html_lib.escape(text), body_style))

    if not story:
        story.append(Paragraph("", body_style))

    out = ensure_parent(args.output)

    def draw_page_num(c: Any, doc_obj: Any) -> None:
        c.saveState()
        c.setFont(font_name, 8.5)
        c.setFillColor(colors.HexColor("#6B7280"))
        c.drawRightString(A4[0] - 18 * mm, 12 * mm, f"{doc_obj.page}")
        c.restoreState()

    pdf = SimpleDocTemplate(
        str(out),
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
    )
    pdf.build(story, onFirstPage=draw_page_num, onLaterPages=draw_page_num)
    print(json.dumps({"ok": True, "font": font_name, "output": str(out)}, ensure_ascii=False))


def html_to_markdown(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    lines: List[str] = []
    for child in soup.children:
        if not isinstance(child, Tag):
            text = str(child).strip()
            if text:
                lines.append(text)
            continue
        tag = child.name.lower()
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            level = int(tag[1])
            lines.append(f"{'#' * level} {child.get_text(' ', strip=True)}")
        elif tag == "p":
            text = child.get_text(" ", strip=True)
            if text:
                lines.append(text)
        elif tag in ("ul", "ol"):
            for idx, li in enumerate(child.find_all("li", recursive=False), start=1):
                prefix = "-" if tag == "ul" else f"{idx}."
                lines.append(f"{prefix} {li.get_text(' ', strip=True)}")
        elif tag == "table":
            rows = extract_table_rows(child)
            if rows:
                width = max(len(r) for r in rows)
                norm = [r + [""] * (width - len(r)) for r in rows]
                lines.append("| " + " | ".join(norm[0]) + " |")
                lines.append("| " + " | ".join(["---"] * width) + " |")
                for row in norm[1:]:
                    lines.append("| " + " | ".join(row) + " |")
        else:
            text = child.get_text(" ", strip=True)
            if text:
                lines.append(text)
    return "\n\n".join(lines)


def cmd_docx_to_md(args: argparse.Namespace) -> None:
    with open(args.input, "rb") as fh:
        res = mammoth.convert_to_html(fh)
    md_text = html_to_markdown(res.value)
    if args.output:
        out = ensure_parent(args.output)
        out.write_text(md_text, encoding="utf-8")
        print(json.dumps({"ok": True, "chars": len(md_text), "output": str(out)}, ensure_ascii=False))
    else:
        print(md_text)


def parse_pages(spec: Optional[str], total: int) -> List[int]:
    if not spec or not spec.strip():
        return list(range(total))
    indices: List[int] = []
    seen = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            s_str, e_str = part.split("-", 1)
            start = int(s_str.strip()) if s_str.strip() else 1
            end = int(e_str.strip()) if e_str.strip() else total
            for p in range(max(1, start) - 1, min(total, end)):
                if p not in seen:
                    seen.add(p)
                    indices.append(p)
        else:
            p = int(part) - 1
            if 0 <= p < total and p not in seen:
                seen.add(p)
                indices.append(p)
    return indices


def format_md_table(rows: Sequence[Sequence[Optional[str]]]) -> str:
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    norm = [
        [("" if c is None else str(c).replace("\n", " ").strip()) for c in list(r) + [""] * (width - len(r))]
        for r in rows
    ]
    return "\n".join(
        [
            "| " + " | ".join(norm[0]) + " |",
            "| " + " | ".join(["---"] * width) + " |",
            *["| " + " | ".join(r) + " |" for r in norm[1:]],
        ]
    )


def cmd_pdf_to_md(args: argparse.Namespace) -> None:
    sections: List[str] = []
    with pdfplumber.open(args.input) as pdf:
        for idx in parse_pages(args.pages, len(pdf.pages)):
            page = pdf.pages[idx]
            text = (page.extract_text() or "").strip()
            tables = page.extract_tables() or []
            chunk = [f"## Page {idx + 1}"]
            if text:
                chunk.append(text)
            for t in tables:
                chunk.append(format_md_table(t))
            sections.append("\n\n".join(chunk))
    md_text = "\n\n".join(sections)
    if args.output:
        out = ensure_parent(args.output)
        out.write_text(md_text, encoding="utf-8")
        print(json.dumps({"ok": True, "pages": len(sections), "output": str(out)}, ensure_ascii=False))
    else:
        print(md_text)


def cmd_xlsx_to_md(args: argparse.Namespace) -> None:
    wb = openpyxl.load_workbook(args.input, data_only=True, read_only=True)
    try:
        names = [args.sheet] if args.sheet else wb.sheetnames
        sections: List[str] = []
        for name in names:
            if name not in wb.sheetnames:
                raise ValueError(f"找不到工作表：{name}")
            ws = wb[name]
            rows: List[List[str]] = []
            for idx, row in enumerate(ws.iter_rows(values_only=True)):
                if idx >= args.max_rows:
                    break
                rows.append(["" if v is None else str(v) for v in row])
            if rows:
                sections.append(f"## {name}\n\n{format_md_table(rows)}")
            else:
                sections.append(f"## {name}\n\n（空表）")
        md_text = "\n\n".join(sections)
        if args.output:
            out = ensure_parent(args.output)
            out.write_text(md_text, encoding="utf-8")
            print(json.dumps({"ok": True, "sheets": len(names), "output": str(out)}, ensure_ascii=False))
        else:
            print(md_text)
    finally:
        wb.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="OPC Local Document Format Converter")
    sub = parser.add_subparsers(dest="command", required=True)

    p_m2d = sub.add_parser("md-to-docx")
    p_m2d.add_argument("input")
    p_m2d.add_argument("--output", required=True)
    p_m2d.set_defaults(func=cmd_md_to_docx)

    p_m2p = sub.add_parser("md-to-pdf")
    p_m2p.add_argument("input")
    p_m2p.add_argument("--output", required=True)
    p_m2p.set_defaults(func=cmd_md_to_pdf)

    p_d2m = sub.add_parser("docx-to-md")
    p_d2m.add_argument("input")
    p_d2m.add_argument("--output", default=None)
    p_d2m.set_defaults(func=cmd_docx_to_md)

    p_p2m = sub.add_parser("pdf-to-md")
    p_p2m.add_argument("input")
    p_p2m.add_argument("--pages", default=None)
    p_p2m.add_argument("--output", default=None)
    p_p2m.set_defaults(func=cmd_pdf_to_md)

    p_x2m = sub.add_parser("xlsx-to-md")
    p_x2m.add_argument("input")
    p_x2m.add_argument("--sheet", default=None)
    p_x2m.add_argument("--max-rows", type=int, default=200)
    p_x2m.add_argument("--output", default=None)
    p_x2m.set_defaults(func=cmd_xlsx_to_md)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.func(args)
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
