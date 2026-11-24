---
name: office-convert
description: 本地离线文档格式转换工具箱：将 Markdown 转换为排版美观的 Word (.docx) 或支持中文的 PDF，或将 Word / PDF / Excel 文档转换为结构清晰的 Markdown。
---

# 文档格式转换（本地离线）

使用预置隔离环境执行脚本（替换 `<skill_dir>` 为本技能所在目录）：

```bash
"$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/convert_tool.py" <子命令> [参数]
```

## 常用子命令

1. **Markdown → Word (.docx)**（支持标题、列表、表格、代码块、粗斜体、中文字体）：
   ```bash
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/convert_tool.py" md-to-docx report.md --output ./output/report.docx
   ```

2. **Markdown → PDF**（自动加载系统 CJK 中文字体，支持标题、表格、列表、代码块、页码）：
   ```bash
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/convert_tool.py" md-to-pdf report.md --output ./output/report.pdf
   ```

3. **Word (.docx) → Markdown**：
   ```bash
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/convert_tool.py" docx-to-md input.docx --output ./output/input.md
   ```

4. **PDF → Markdown**（文本 + 自动识别表格合并）：
   ```bash
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/convert_tool.py" pdf-to-md input.pdf --pages 1-10 --output ./output/input.md
   ```

5. **Excel (.xlsx) → Markdown**：
   ```bash
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/convert_tool.py" xlsx-to-md data.xlsx --max-rows 200 --output ./output/data.md
   ```

## 工作区约定
- 转换产物请写到任务工作区下的相对路径（如 `./output/report.pdf`），任务结束时系统会自动将其登记为交付产物。
