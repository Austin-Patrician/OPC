#!/usr/bin/env python3
"""Local offline PDF toolkit CLI backed by pypdf, pdfplumber, pypdfium2 and reportlab."""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sys
from pathlib import Path
from typing import Iterable, List, Optional, Sequence

import pdfplumber
import pypdfium2 as pdfium
from pypdf import PdfReader, PdfWriter
from reportlab.lib.colors import Color
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas


def parse_pages(spec: Optional[str], total: int) -> List[int]:
    """Parse 1-based page spec like '1-3,5' into sorted 0-based page indices."""
    if not spec or not spec.strip():
        return list(range(total))
    indices: List[int] = []
    seen = set()
    for raw_part in spec.split(","):
        part = raw_part.strip()
        if not part:
            continue
        if "-" in part:
            start_s, end_s = part.split("-", 1)
            start = int(start_s.strip()) if start_s.strip() else 1
            end = int(end_s.strip()) if end_s.strip() else total
            if start < 1 or end < start or end > total:
                raise ValueError(f"页码范围越界：{part}（总页数 {total}）")
            for p in range(start - 1, end):
                if p not in seen:
                    seen.add(p)
                    indices.append(p)
        else:
            page = int(part)
            if page < 1 or page > total:
                raise ValueError(f"页码越界：{page}（总页数 {total}）")
            idx = page - 1
            if idx not in seen:
                seen.add(idx)
                indices.append(idx)
    return indices


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


def register_watermark_font() -> str:
    font_path = find_cjk_font()
    if font_path:
        font_name = "OpcCjkWatermark"
        try:
            if font_path.lower().endswith(".ttc"):
                pdfmetrics.registerFont(TTFont(font_name, font_path, subfontIndex=0))
            else:
                pdfmetrics.registerFont(TTFont(font_name, font_path))
            return font_name
        except Exception:
            pass
    return "Helvetica-Bold"


def cmd_inspect(args: argparse.Namespace) -> None:
    reader = PdfReader(args.input)
    total = len(reader.pages)
    meta = {}
    if reader.metadata:
        for k, v in reader.metadata.items():
            meta[str(k).lstrip("/")] = str(v) if v is not None else ""
    fields = reader.get_fields() or {}
    sample_count = min(total, 3)
    text_chars = 0
    for idx in range(sample_count):
        text_chars += len((reader.pages[idx].extract_text() or "").strip())
    result = {
        "file": str(args.input),
        "page_count": total,
        "encrypted": reader.is_encrypted,
        "metadata": meta,
        "has_form": len(fields) > 0,
        "form_fields_count": len(fields),
        "sample_text_chars": text_chars,
        "likely_scanned": total > 0 and text_chars < 20,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


def cmd_extract_text(args: argparse.Namespace) -> None:
    reader = PdfReader(args.input)
    indices = parse_pages(args.pages, len(reader.pages))
    chunks: List[str] = []
    for idx in indices:
        text = reader.pages[idx].extract_text() or ""
        chunks.append(f"--- Page {idx + 1} ---\n{text.rstrip()}")
    output_text = "\n\n".join(chunks)
    if args.output:
        out = ensure_parent(args.output)
        out.write_text(output_text, encoding="utf-8")
        print(json.dumps({"ok": True, "pages": len(indices), "output": str(out), "chars": len(output_text)}, ensure_ascii=False))
    else:
        print(output_text)


def format_markdown_table(rows: Sequence[Sequence[Optional[str]]]) -> str:
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    norm = [
        [("" if cell is None else str(cell).replace("\n", " ").strip()) for cell in list(r) + [""] * (width - len(r))]
        for r in rows
    ]
    header = "| " + " | ".join(norm[0]) + " |"
    sep = "| " + " | ".join(["---"] * width) + " |"
    body = ["| " + " | ".join(row) + " |" for row in norm[1:]]
    return "\n".join([header, sep, *body])


def cmd_extract_tables(args: argparse.Namespace) -> None:
    tables_out = []
    with pdfplumber.open(args.input) as pdf:
        indices = parse_pages(args.pages, len(pdf.pages))
        for idx in indices:
            page_tables = pdf.pages[idx].extract_tables() or []
            for t_idx, table in enumerate(page_tables, start=1):
                cleaned = [[("" if c is None else str(c).strip()) for c in row] for row in table]
                tables_out.append({"page": idx + 1, "table_index": t_idx, "rows": cleaned})

    if args.format == "json":
        rendered = json.dumps({"tables": tables_out}, ensure_ascii=False, indent=2)
    elif args.format == "csv":
        buf = io.StringIO()
        writer = csv.writer(buf)
        for item in tables_out:
            writer.writerow([f"# Page {item['page']} Table {item['table_index']}"])
            for row in item["rows"]:
                writer.writerow(row)
        rendered = buf.getvalue()
    else:
        parts = []
        for item in tables_out:
            parts.append(f"### Page {item['page']} - Table {item['table_index']}\n\n{format_markdown_table(item['rows'])}")
        rendered = "\n\n".join(parts) if parts else "（未检测到表格）"

    if args.output:
        out = ensure_parent(args.output)
        out.write_text(rendered, encoding="utf-8")
        print(json.dumps({"ok": True, "table_count": len(tables_out), "output": str(out)}, ensure_ascii=False))
    else:
        print(rendered)


def cmd_merge(args: argparse.Namespace) -> None:
    writer = PdfWriter()
    total_pages = 0
    for file_path in args.inputs:
        reader = PdfReader(file_path)
        for page in reader.pages:
            writer.add_page(page)
            total_pages += 1
    out = ensure_parent(args.output)
    with out.open("wb") as fh:
        writer.write(fh)
    print(json.dumps({"ok": True, "inputs": len(args.inputs), "page_count": total_pages, "output": str(out)}, ensure_ascii=False))


def cmd_split(args: argparse.Namespace) -> None:
    reader = PdfReader(args.input)
    indices = parse_pages(args.pages, len(reader.pages))
    if args.output:
        writer = PdfWriter()
        for idx in indices:
            writer.add_page(reader.pages[idx])
        out = ensure_parent(args.output)
        with out.open("wb") as fh:
            writer.write(fh)
        print(json.dumps({"ok": True, "page_count": len(indices), "output": str(out)}, ensure_ascii=False))
    elif args.out_dir:
        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        files = []
        for idx in indices:
            writer = PdfWriter()
            writer.add_page(reader.pages[idx])
            target = out_dir / f"page_{idx + 1:04d}.pdf"
            with target.open("wb") as fh:
                writer.write(fh)
            files.append(str(target))
        print(json.dumps({"ok": True, "files": files}, ensure_ascii=False))
    else:
        raise ValueError("split 需要指定 --output 或 --out-dir")


def cmd_rotate(args: argparse.Namespace) -> None:
    reader = PdfReader(args.input)
    targets = set(parse_pages(args.pages, len(reader.pages)))
    writer = PdfWriter()
    for idx, page in enumerate(reader.pages):
        if idx in targets:
            page.rotate(args.angle)
        writer.add_page(page)
    out = ensure_parent(args.output)
    with out.open("wb") as fh:
        writer.write(fh)
    print(json.dumps({"ok": True, "rotated_pages": len(targets), "angle": args.angle, "output": str(out)}, ensure_ascii=False))


def cmd_delete_pages(args: argparse.Namespace) -> None:
    reader = PdfReader(args.input)
    drop = set(parse_pages(args.pages, len(reader.pages)))
    writer = PdfWriter()
    kept = 0
    for idx, page in enumerate(reader.pages):
        if idx not in drop:
            writer.add_page(page)
            kept += 1
    out = ensure_parent(args.output)
    with out.open("wb") as fh:
        writer.write(fh)
    print(json.dumps({"ok": True, "deleted": len(drop), "remaining": kept, "output": str(out)}, ensure_ascii=False))


def cmd_render(args: argparse.Namespace) -> None:
    doc = pdfium.PdfDocument(args.input)
    total = len(doc)
    indices = parse_pages(args.pages, total)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    scale = max(0.5, float(args.dpi) / 72.0)
    rendered_files: List[str] = []
    for idx in indices:
        page = doc[idx]
        bitmap = page.render(scale=scale)
        pil_image = bitmap.to_pil()
        target = out_dir / f"page_{idx + 1:04d}.png"
        pil_image.save(target, format="PNG")
        rendered_files.append(str(target))
    print(json.dumps({"ok": True, "rendered": len(rendered_files), "files": rendered_files}, ensure_ascii=False))


def build_watermark_page(width: float, height: float, text: str, opacity: float, font_name: str, font_size: int) -> PdfReader:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(width, height))
    c.saveState()
    c.setFillColor(Color(0.4, 0.4, 0.4, alpha=max(0.05, min(1.0, opacity))))
    c.setFont(font_name, font_size)
    c.translate(width / 2.0, height / 2.0)
    c.rotate(35)
    c.drawCentredString(0, 0, text)
    c.restoreState()
    c.save()
    buf.seek(0)
    return PdfReader(buf)


def cmd_watermark(args: argparse.Namespace) -> None:
    reader = PdfReader(args.input)
    font_name = register_watermark_font()
    writer = PdfWriter()
    for page in reader.pages:
        width = float(page.mediabox.width)
        height = float(page.mediabox.height)
        overlay = build_watermark_page(width, height, args.text, args.opacity, font_name, args.font_size)
        page.merge_page(overlay.pages[0])
        writer.add_page(page)
    out = ensure_parent(args.output)
    with out.open("wb") as fh:
        writer.write(fh)
    print(json.dumps({"ok": True, "pages": len(writer.pages), "font": font_name, "output": str(out)}, ensure_ascii=False))


def cmd_fill_form(args: argparse.Namespace) -> None:
    reader = PdfReader(args.input)
    fields = reader.get_fields() or {}
    if args.list:
        summary = {
            name: {
                "type": str(info.get("/FT", "")),
                "value": str(info.get("/V", "")) if info.get("/V") is not None else "",
            }
            for name, info in fields.items()
        }
        print(json.dumps({"fields": summary}, ensure_ascii=False, indent=2))
        return
    if not args.fields_json or not args.output:
        raise ValueError("填写表单需要 --fields-json 和 --output")
    values = json.loads(args.fields_json)
    if not isinstance(values, dict):
        raise ValueError("--fields-json 必须是 JSON 对象")
    writer = PdfWriter()
    writer.append(reader)
    for page in writer.pages:
        writer.update_page_form_field_values(page, values)
    out = ensure_parent(args.output)
    with out.open("wb") as fh:
        writer.write(fh)
    print(json.dumps({"ok": True, "updated_fields": list(values.keys()), "output": str(out)}, ensure_ascii=False))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="OPC Local PDF Toolkit")
    sub = parser.add_subparsers(dest="command", required=True)

    p_inspect = sub.add_parser("inspect")
    p_inspect.add_argument("input")
    p_inspect.set_defaults(func=cmd_inspect)

    p_text = sub.add_parser("extract-text")
    p_text.add_argument("input")
    p_text.add_argument("--pages", default=None)
    p_text.add_argument("--output", default=None)
    p_text.set_defaults(func=cmd_extract_text)

    p_tables = sub.add_parser("extract-tables")
    p_tables.add_argument("input")
    p_tables.add_argument("--pages", default=None)
    p_tables.add_argument("--format", choices=["json", "markdown", "csv"], default="markdown")
    p_tables.add_argument("--output", default=None)
    p_tables.set_defaults(func=cmd_extract_tables)

    p_merge = sub.add_parser("merge")
    p_merge.add_argument("inputs", nargs="+")
    p_merge.add_argument("--output", required=True)
    p_merge.set_defaults(func=cmd_merge)

    p_split = sub.add_parser("split")
    p_split.add_argument("input")
    p_split.add_argument("--pages", default=None)
    p_split.add_argument("--output", default=None)
    p_split.add_argument("--out-dir", default=None)
    p_split.set_defaults(func=cmd_split)

    p_rotate = sub.add_parser("rotate")
    p_rotate.add_argument("input")
    p_rotate.add_argument("--angle", type=int, required=True)
    p_rotate.add_argument("--pages", default=None)
    p_rotate.add_argument("--output", required=True)
    p_rotate.set_defaults(func=cmd_rotate)

    p_del = sub.add_parser("delete-pages")
    p_del.add_argument("input")
    p_del.add_argument("--pages", required=True)
    p_del.add_argument("--output", required=True)
    p_del.set_defaults(func=cmd_delete_pages)

    p_render = sub.add_parser("render")
    p_render.add_argument("input")
    p_render.add_argument("--pages", default=None)
    p_render.add_argument("--dpi", type=int, default=150)
    p_render.add_argument("--out-dir", required=True)
    p_render.set_defaults(func=cmd_render)

    p_wm = sub.add_parser("watermark")
    p_wm.add_argument("input")
    p_wm.add_argument("--text", required=True)
    p_wm.add_argument("--opacity", type=float, default=0.25)
    p_wm.add_argument("--font-size", type=int, default=42)
    p_wm.add_argument("--output", required=True)
    p_wm.set_defaults(func=cmd_watermark)

    p_form = sub.add_parser("fill-form")
    p_form.add_argument("input")
    p_form.add_argument("--list", action="store_true")
    p_form.add_argument("--fields-json", default=None)
    p_form.add_argument("--output", default=None)
    p_form.set_defaults(func=cmd_fill_form)

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
