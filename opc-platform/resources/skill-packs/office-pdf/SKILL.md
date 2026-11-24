---
name: office-pdf
description: 本地离线 PDF 处理工具箱：检查元信息与是否扫描件、按页提取文本、提取表格为 JSON/CSV/Markdown、合并、拆分、旋转、删页、渲染页面为 PNG、添加文字水印以及读写 AcroForm 表单。
---

# PDF 工具箱（本地离线）

使用预置隔离环境执行脚本（替换 `<skill_dir>` 为本技能所在目录，路径以 `read_skill` 返回的目录为准）：

```bash
"$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/pdf_tool.py" <子命令> [参数]
```

## 常用子命令

1. **检查 PDF 与扫描件探测**：
   ```bash
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/pdf_tool.py" inspect input.pdf
   ```
   - 返回 `page_count`、`metadata`、`has_form`、`form_fields_count`、`likely_scanned`（若为 `true`，说明缺少文本层，应先 `render` 渲染为 PNG 再用视觉或 `ocr_image` 识别）。

2. **按页提取文本**：
   ```bash
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/pdf_tool.py" extract-text input.pdf --pages 1-5 --output ./output/text.txt
   ```

3. **提取表格（支持 json / markdown / csv）**：
   ```bash
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/pdf_tool.py" extract-tables input.pdf --pages 1-3 --format markdown --output ./output/tables.md
   ```

4. **合并 / 拆分 / 旋转 / 删页**：
   ```bash
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/pdf_tool.py" merge a.pdf b.pdf --output ./output/merged.pdf
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/pdf_tool.py" split input.pdf --pages 1-3,5 --output ./output/part.pdf
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/pdf_tool.py" rotate input.pdf --angle 90 --pages 1-2 --output ./output/rotated.pdf
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/pdf_tool.py" delete-pages input.pdf --pages 2,4 --output ./output/trimmed.pdf
   ```

5. **渲染页面为 PNG（供视觉模型或 `ocr_image` 读取）**：
   ```bash
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/pdf_tool.py" render input.pdf --pages 1-3 --dpi 150 --out-dir ./output/pages
   ```

6. **添加文字水印（支持中文）**：
   ```bash
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/pdf_tool.py" watermark input.pdf --text "内部资料" --opacity 0.2 --output ./output/watermarked.pdf
   ```

7. **查看或填写 PDF 表单**：
   ```bash
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/pdf_tool.py" fill-form form.pdf --list
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/pdf_tool.py" fill-form form.pdf --fields-json '{"name":"张三"}' --output ./output/filled.pdf
   ```

## 工作区与产物约定
- 读取用户附件时直接使用任务提示词提供的附件路径；写入产物请一律使用当前任务工作区下的相对路径（如 `./output/result.pdf`），切勿覆盖原附件。
- 复杂定制需求也可以直接通过 `"$OPC_OFFICE_PYTHON" -c "..."` 调用 `pypdf`、`pdfplumber`、`pypdfium2`、`reportlab`。
