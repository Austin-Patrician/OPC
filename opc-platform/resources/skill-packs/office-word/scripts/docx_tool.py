#!/usr/bin/env python3
"""Local offline Word (.docx) toolkit CLI backed by python-docx."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence

from docx import Document
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import nsdecls, qn
from docx.shared import Pt, RGBColor


def ensure_parent(path_str: str) -> Path:
    target = Path(path_str)
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def set_cjk_default_font(doc: Document, font_name: str = "PingFang SC") -> None:
    normal = doc.styles["Normal"]
    normal.font.name = font_name
    normal.font.size = Pt(11)
    rpr = normal.element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.insert(0, rfonts)
    rfonts.set(qn("w:eastAsia"), font_name)


def cmd_inspect(args: argparse.Namespace) -> None:
    doc = Document(args.input)
    headings = []
    for p in doc.paragraphs:
        style_name = p.style.name if p.style else ""
        if style_name.startswith("Heading") and p.text.strip():
            headings.append({"style": style_name, "text": p.text.strip()})
    props = doc.core_properties
    print(
        json.dumps(
            {
                "file": args.input,
                "paragraphs": len(doc.paragraphs),
                "tables": len(doc.tables),
                "sections": len(doc.sections),
                "metadata": {
                    "title": props.title or "",
                    "author": props.author or "",
                    "subject": props.subject or "",
                },
                "headings": headings,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def format_markdown_table(rows: Sequence[Sequence[str]]) -> str:
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    norm = [list(r) + [""] * (width - len(r)) for r in rows]
    header = "| " + " | ".join(norm[0]) + " |"
    sep = "| " + " | ".join(["---"] * width) + " |"
    body = ["| " + " | ".join(r) + " |" for r in norm[1:]]
    return "\n".join([header, sep, *body])


def cmd_read(args: argparse.Namespace) -> None:
    doc = Document(args.input)
    paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
    tables = [[[cell.text.replace("\n", " ").strip() for cell in row.cells] for row in t.rows] for t in doc.tables]
    if args.format == "json":
        print(json.dumps({"paragraphs": paragraphs, "tables": tables}, ensure_ascii=False, indent=2))
        return
    parts = list(paragraphs)
    for idx, t in enumerate(tables, start=1):
        parts.append(f"\n[Table {idx}]\n{format_markdown_table(t)}")
    print("\n\n".join(parts))


def add_styled_table(doc: Document, headers: Optional[Sequence[Any]], rows: Sequence[Sequence[Any]]) -> None:
    all_rows = ([list(headers)] if headers else []) + [list(r) for r in rows]
    if not all_rows:
        return
    cols = max(len(r) for r in all_rows)
    table = doc.add_table(rows=len(all_rows), cols=cols)
    table.style = "Table Grid"
    for r_idx, row_data in enumerate(all_rows):
        for c_idx in range(cols):
            val = "" if c_idx >= len(row_data) or row_data[c_idx] is None else str(row_data[c_idx])
            cell = table.cell(r_idx, c_idx)
            cell.text = val
            if headers and r_idx == 0:
                shading = parse_xml(f'<w:shd {nsdecls("w")} w:fill="1F4E78"/>')
                cell._tc.get_or_add_tcPr().append(shading)
                for p in cell.paragraphs:
                    for run in p.runs:
                        run.bold = True
                        run.font.color.rgb = RGBColor(255, 255, 255)


def cmd_create(args: argparse.Namespace) -> None:
    raw = sys.stdin.read() if args.stdin else Path(args.input_json).read_text(encoding="utf-8")
    spec = json.loads(raw)
    if not isinstance(spec, dict):
        raise ValueError("JSON 必须是对象")

    doc = Document()
    set_cjk_default_font(doc)

    title = spec.get("title")
    if isinstance(title, str) and title.strip():
        doc.add_heading(title.strip(), level=0)

    blocks = spec.get("blocks") or []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype == "heading":
            level = max(1, min(4, int(block.get("level", 1))))
            doc.add_heading(str(block.get("text", "")), level=level)
        elif btype == "paragraph":
            p = doc.add_paragraph(str(block.get("text", "")))
            if block.get("bold"):
                for r in p.runs:
                    r.bold = True
        elif btype == "bullets":
            for item in block.get("items") or []:
                doc.add_paragraph(str(item), style="List Bullet")
        elif btype == "numbered":
            for item in block.get("items") or []:
                doc.add_paragraph(str(item), style="List Number")
        elif btype == "table":
            add_styled_table(doc, block.get("headers"), block.get("rows") or [])

    out = ensure_parent(args.output)
    doc.save(out)
    print(json.dumps({"ok": True, "blocks": len(blocks), "output": str(out)}, ensure_ascii=False))


def replace_in_paragraph(paragraph: Any, mapping: Dict[str, str]) -> int:
    count = 0
    full_text = paragraph.text
    if not any(k in full_text for k in mapping):
        return 0

    # First try run-level replacement to keep per-run styling intact
    for run in paragraph.runs:
        text = run.text
        updated = text
        for old, new in mapping.items():
            if old in updated:
                count += updated.count(old)
                updated = updated.replace(old, new)
        if updated != text:
            run.text = updated

    # Fallback when a placeholder spans multiple XML runs
    remaining_text = paragraph.text
    if any(k in remaining_text for k in mapping):
        updated_full = remaining_text
        for old, new in mapping.items():
            if old in updated_full:
                count += updated_full.count(old)
                updated_full = updated_full.replace(old, new)
        if paragraph.runs:
            paragraph.runs[0].text = updated_full
            for extra_run in paragraph.runs[1:]:
                extra_run.text = ""
        else:
            paragraph.text = updated_full
    return count


def walk_paragraphs(container: Any) -> Iterable[Any]:
    for p in container.paragraphs:
        yield p
    for table in container.tables:
        for row in table.rows:
            for cell in row.cells:
                yield from walk_paragraphs(cell)


def cmd_replace(args: argparse.Namespace) -> None:
    mapping_raw = json.loads(args.map_json)
    if not isinstance(mapping_raw, dict) or not mapping_raw:
        raise ValueError("--map-json 必须是非空 JSON 对象")
    mapping = {str(k): str(v) for k, v in mapping_raw.items()}

    doc = Document(args.input)
    replaced = 0
    for p in walk_paragraphs(doc):
        replaced += replace_in_paragraph(p, mapping)
    for section in doc.sections:
        for container in (section.header, section.footer):
            for p in walk_paragraphs(container):
                replaced += replace_in_paragraph(p, mapping)

    out = ensure_parent(args.output)
    doc.save(out)
    print(json.dumps({"ok": True, "replacements": replaced, "output": str(out)}, ensure_ascii=False))


def cmd_extract_tables(args: argparse.Namespace) -> None:
    doc = Document(args.input)
    tables = [[[cell.text.replace("\n", " ").strip() for cell in row.cells] for row in t.rows] for t in doc.tables]
    if args.format == "json":
        print(json.dumps({"tables": tables}, ensure_ascii=False, indent=2))
        return
    parts = [f"### Table {idx}\n\n{format_markdown_table(t)}" for idx, t in enumerate(tables, start=1)]
    print("\n\n".join(parts) if parts else "（未检测到表格）")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="OPC Local Word (.docx) Toolkit")
    sub = parser.add_subparsers(dest="command", required=True)

    p_ins = sub.add_parser("inspect")
    p_ins.add_argument("input")
    p_ins.set_defaults(func=cmd_inspect)

    p_read = sub.add_parser("read")
    p_read.add_argument("input")
    p_read.add_argument("--format", choices=["text", "json"], default="text")
    p_read.set_defaults(func=cmd_read)

    p_create = sub.add_parser("create")
    p_create.add_argument("--input-json", default=None)
    p_create.add_argument("--stdin", action="store_true")
    p_create.add_argument("--output", required=True)
    p_create.set_defaults(func=cmd_create)

    p_rep = sub.add_parser("replace")
    p_rep.add_argument("input")
    p_rep.add_argument("--map-json", required=True)
    p_rep.add_argument("--output", required=True)
    p_rep.set_defaults(func=cmd_replace)

    p_tab = sub.add_parser("extract-tables")
    p_tab.add_argument("input")
    p_tab.add_argument("--format", choices=["markdown", "json"], default="markdown")
    p_tab.set_defaults(func=cmd_extract_tables)

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
