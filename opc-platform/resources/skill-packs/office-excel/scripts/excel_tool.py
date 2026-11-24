#!/usr/bin/env python3
"""Local offline Excel and CSV toolkit CLI backed by openpyxl."""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import openpyxl
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter


def ensure_parent(path_str: str) -> Path:
    target = Path(path_str)
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    return str(value)


def is_csv_path(path_str: str) -> bool:
    return Path(path_str).suffix.lower() == ".csv"


def read_csv_rows(path_str: str) -> List[List[Any]]:
    with open(path_str, "r", encoding="utf-8-sig", newline="") as fh:
        return [list(row) for row in csv.reader(fh)]


def open_sheet(path_str: str, sheet_name: Optional[str], data_only: bool) -> Tuple[Any, str]:
    wb = openpyxl.load_workbook(path_str, data_only=data_only, read_only=True)
    name = sheet_name or wb.sheetnames[0]
    if name not in wb.sheetnames:
        wb.close()
        raise ValueError(f"找不到工作表：{name}（可用：{', '.join(wb.sheetnames)}）")
    return wb, name


def cmd_inspect(args: argparse.Namespace) -> None:
    if is_csv_path(args.input):
        rows = read_csv_rows(args.input)
        headers = rows[0] if rows else []
        print(
            json.dumps(
                {
                    "file": args.input,
                    "format": "csv",
                    "sheets": [
                        {
                            "name": "csv",
                            "rows": len(rows),
                            "cols": max((len(r) for r in rows), default=0),
                            "headers": headers,
                            "preview": rows[:5],
                        }
                    ],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return

    wb = openpyxl.load_workbook(args.input, data_only=True, read_only=True)
    try:
        sheets = []
        for name in wb.sheetnames:
            ws = wb[name]
            preview: List[List[Any]] = []
            row_count = 0
            col_count = 0
            for idx, row in enumerate(ws.iter_rows(values_only=True)):
                row_count += 1
                col_count = max(col_count, len(row))
                if idx < 5:
                    preview.append([json_safe(c) for c in row])
            sheets.append(
                {
                    "name": name,
                    "rows": row_count,
                    "cols": col_count,
                    "headers": preview[0] if preview else [],
                    "preview": preview,
                }
            )
        print(json.dumps({"file": args.input, "format": "xlsx", "sheets": sheets}, ensure_ascii=False, indent=2))
    finally:
        wb.close()


def cmd_read(args: argparse.Namespace) -> None:
    if is_csv_path(args.input):
        rows = read_csv_rows(args.input)
        sliced = rows[args.offset : args.offset + args.limit]
        print(json.dumps({"sheet": "csv", "total_rows": len(rows), "offset": args.offset, "rows": sliced}, ensure_ascii=False, indent=2))
        return

    wb, name = open_sheet(args.input, args.sheet, data_only=not args.formulas)
    try:
        ws = wb[name]
        if args.range:
            cells = ws[args.range]
            if not isinstance(cells, tuple):
                rows = [[json_safe(cells.value)]]
            elif cells and not isinstance(cells[0], tuple):
                rows = [[json_safe(c.value) for c in cells]]
            else:
                rows = [[json_safe(c.value) for c in row] for row in cells]
            print(json.dumps({"sheet": name, "range": args.range, "rows": rows}, ensure_ascii=False, indent=2))
            return

        rows_out: List[List[Any]] = []
        total = 0
        for idx, row in enumerate(ws.iter_rows(values_only=True)):
            total += 1
            if idx < args.offset:
                continue
            if len(rows_out) < args.limit:
                rows_out.append([json_safe(c) for c in row])
        print(
            json.dumps(
                {
                    "sheet": name,
                    "total_rows": total,
                    "offset": args.offset,
                    "limit": args.limit,
                    "formulas": bool(args.formulas),
                    "rows": rows_out,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    finally:
        wb.close()


def apply_sheet_data(ws: Any, headers: Optional[Sequence[Any]], rows: Sequence[Sequence[Any]], freeze_header: bool) -> None:
    header_fill = PatternFill(start_color="1F4E78", end_color="1F4E78", fill_type="solid")
    header_font = Font(bold=True, color="FFFFFF")
    thin = Side(border_style="thin", color="D9D9D9")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)

    start_row = 1
    if headers:
        for col_idx, text in enumerate(headers, start=1):
            cell = ws.cell(row=1, column=col_idx, value=text)
            cell.fill = header_fill
            cell.font = header_font
            cell.alignment = Alignment(horizontal="center", vertical="center")
            cell.border = border
        start_row = 2
        if freeze_header:
            ws.freeze_panes = "A2"

    for r_offset, row in enumerate(rows):
        row_idx = start_row + r_offset
        for c_idx, val in enumerate(row, start=1):
            cell = ws.cell(row=row_idx, column=c_idx, value=val)
            cell.border = border

    # Auto-fit column widths conservatively
    col_widths: Dict[int, int] = {}
    for row in ws.iter_rows(values_only=True):
        for c_idx, val in enumerate(row, start=1):
            text = "" if val is None else str(val)
            # CJK characters occupy ~2 display units
            display_len = sum(2 if ord(ch) > 127 else 1 for ch in text)
            col_widths[c_idx] = max(col_widths.get(c_idx, 8), min(48, display_len + 3))
    for c_idx, width in col_widths.items():
        ws.column_dimensions[get_column_letter(c_idx)].width = width


def cmd_write(args: argparse.Namespace) -> None:
    raw = sys.stdin.read() if args.stdin else Path(args.input_json).read_text(encoding="utf-8")
    spec = json.loads(raw)
    sheets_spec = spec.get("sheets") if isinstance(spec, dict) else None
    if not isinstance(sheets_spec, list) or not sheets_spec:
        raise ValueError("JSON 必须包含非空的 sheets 数组")

    wb = openpyxl.Workbook()
    # Remove default sheet after creating defined sheets
    default_ws = wb.active
    created_names: List[str] = []
    for entry in sheets_spec:
        title = str(entry.get("name") or f"Sheet{len(created_names) + 1}")[:31]
        ws = wb.create_sheet(title=title)
        headers = entry.get("headers")
        rows = entry.get("rows") or []
        freeze = entry.get("freeze_header", True)
        apply_sheet_data(ws, headers, rows, bool(freeze))
        created_names.append(ws.title)
    if default_ws is not None:
        wb.remove(default_ws)

    out = ensure_parent(args.output)
    wb.save(out)
    print(json.dumps({"ok": True, "sheets": created_names, "output": str(out)}, ensure_ascii=False))


def load_table_dicts(path_str: str, sheet_name: Optional[str]) -> Tuple[List[str], List[Dict[str, Any]]]:
    if is_csv_path(path_str):
        raw_rows = read_csv_rows(path_str)
    else:
        wb, name = open_sheet(path_str, sheet_name, data_only=True)
        try:
            raw_rows = [list(r) for r in wb[name].iter_rows(values_only=True)]
        finally:
            wb.close()
    if not raw_rows:
        return [], []
    headers = [str(h if h is not None else f"col_{idx + 1}") for idx, h in enumerate(raw_rows[0])]
    records: List[Dict[str, Any]] = []
    for row in raw_rows[1:]:
        if all(cell is None or str(cell).strip() == "" for cell in row):
            continue
        item = {headers[i]: json_safe(row[i]) if i < len(row) else None for i in range(len(headers))}
        records.append(item)
    return headers, records


def to_number(val: Any) -> Optional[float]:
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        return float(val)
    if isinstance(val, str):
        try:
            return float(val.replace(",", "").strip())
        except ValueError:
            return None
    return None


def cmd_query(args: argparse.Namespace) -> None:
    headers, records = load_table_dicts(args.input, args.sheet)
    for clause in args.where or []:
        if "=" not in clause:
            raise ValueError(f"--where 格式应为 列名=值：{clause}")
        col, expected = clause.split("=", 1)
        col = col.strip()
        expected = expected.strip()
        records = [r for r in records if str(r.get(col, "")).strip() == expected]

    if args.group_by:
        gb_col = args.group_by
        agg_op, _, agg_col = (args.agg or "count:").partition(":")
        agg_op = agg_op.strip().lower()
        agg_col = agg_col.strip()
        groups: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
        for r in records:
            groups[str(r.get(gb_col, ""))].append(r)
        summary_rows = []
        for key, items in groups.items():
            row_out: Dict[str, Any] = {gb_col: key, "count": len(items)}
            if agg_col:
                nums = [n for n in (to_number(it.get(agg_col)) for it in items) if n is not None]
                if agg_op == "sum":
                    row_out[f"sum_{agg_col}"] = sum(nums)
                elif agg_op == "avg":
                    row_out[f"avg_{agg_col}"] = (sum(nums) / len(nums)) if nums else 0
                elif agg_op == "max":
                    row_out[f"max_{agg_col}"] = max(nums) if nums else None
                elif agg_op == "min":
                    row_out[f"min_{agg_col}"] = min(nums) if nums else None
            summary_rows.append(row_out)
        print(json.dumps({"rows": summary_rows[: args.limit], "total_groups": len(summary_rows)}, ensure_ascii=False, indent=2))
        return

    if args.sort:
        desc = args.sort.startswith("-")
        sort_col = args.sort[1:] if desc else args.sort
        records.sort(
            key=lambda r: (to_number(r.get(sort_col)) is None, to_number(r.get(sort_col)) or 0.0, str(r.get(sort_col) or "")),
            reverse=desc,
        )

    print(json.dumps({"headers": headers, "total_matched": len(records), "rows": records[: args.limit]}, ensure_ascii=False, indent=2))


def cmd_csv_to_xlsx(args: argparse.Namespace) -> None:
    rows = read_csv_rows(args.input)
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = args.sheet[:31]
    headers = rows[0] if rows else None
    body = rows[1:] if len(rows) > 1 else []
    apply_sheet_data(ws, headers, body, True)
    out = ensure_parent(args.output)
    wb.save(out)
    print(json.dumps({"ok": True, "rows": len(rows), "output": str(out)}, ensure_ascii=False))


def cmd_xlsx_to_csv(args: argparse.Namespace) -> None:
    wb, name = open_sheet(args.input, args.sheet, data_only=True)
    try:
        out = ensure_parent(args.output)
        count = 0
        with out.open("w", encoding="utf-8-sig", newline="") as fh:
            writer = csv.writer(fh)
            for row in wb[name].iter_rows(values_only=True):
                writer.writerow(["" if v is None else json_safe(v) for v in row])
                count += 1
        print(json.dumps({"ok": True, "sheet": name, "rows": count, "output": str(out)}, ensure_ascii=False))
    finally:
        wb.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="OPC Local Excel/CSV Toolkit")
    sub = parser.add_subparsers(dest="command", required=True)

    p_ins = sub.add_parser("inspect")
    p_ins.add_argument("input")
    p_ins.set_defaults(func=cmd_inspect)

    p_read = sub.add_parser("read")
    p_read.add_argument("input")
    p_read.add_argument("--sheet", default=None)
    p_read.add_argument("--range", default=None)
    p_read.add_argument("--offset", type=int, default=0)
    p_read.add_argument("--limit", type=int, default=100)
    p_read.add_argument("--formulas", action="store_true")
    p_read.set_defaults(func=cmd_read)

    p_write = sub.add_parser("write")
    p_write.add_argument("--input-json", default=None)
    p_write.add_argument("--stdin", action="store_true")
    p_write.add_argument("--output", required=True)
    p_write.set_defaults(func=cmd_write)

    p_query = sub.add_parser("query")
    p_query.add_argument("input")
    p_query.add_argument("--sheet", default=None)
    p_query.add_argument("--where", action="append", default=[])
    p_query.add_argument("--sort", default=None)
    p_query.add_argument("--group-by", default=None)
    p_query.add_argument("--agg", default=None)
    p_query.add_argument("--limit", type=int, default=100)
    p_query.set_defaults(func=cmd_query)

    p_c2x = sub.add_parser("csv-to-xlsx")
    p_c2x.add_argument("input")
    p_c2x.add_argument("--sheet", default="Sheet1")
    p_c2x.add_argument("--output", required=True)
    p_c2x.set_defaults(func=cmd_csv_to_xlsx)

    p_x2c = sub.add_parser("xlsx-to-csv")
    p_x2c.add_argument("input")
    p_x2c.add_argument("--sheet", default=None)
    p_x2c.add_argument("--output", required=True)
    p_x2c.set_defaults(func=cmd_xlsx_to_csv)

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
