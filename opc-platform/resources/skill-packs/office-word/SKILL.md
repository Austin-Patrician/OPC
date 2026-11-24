---
name: office-word
description: 本地离线 Word (.docx) 文档工具箱：查看结构大纲与统计、读取段落与表格正文、按结构化 JSON 生成规范排版的 .docx、在保留原有样式的前提下替换模板占位符。
---

# Word 文档工具箱（本地离线）

使用预置隔离环境执行脚本（替换 `<skill_dir>` 为本技能所在目录）：

```bash
"$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/docx_tool.py" <子命令> [参数]
```

## 常用子命令

1. **查看文档大纲与统计**：
   ```bash
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/docx_tool.py" inspect report.docx
   ```

2. **读取正文与表格（支持 `text` / `json`）**：
   ```bash
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/docx_tool.py" read report.docx --format text
   ```

3. **创建规范排版的 Word 文档**：
   JSON 规范示例（支持 `title`、`heading`、`paragraph`、`bullets`、`numbered`、`table`）：
   ```json
   {
     "title": "项目周报",
     "blocks": [
       {"type": "heading", "level": 1, "text": "一、本周进展"},
       {"type": "bullets", "items": ["完成 PDF 工具箱接入", "通过沙箱测试"]},
       {"type": "table", "headers": ["模块", "状态"], "rows": [["PDF", "完成"], ["表格", "完成"]]}
     ]
   }
   ```
   ```bash
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/docx_tool.py" create --input-json doc.json --output ./output/weekly.docx
   ```
   也支持通过 `--stdin` 传入 JSON。

4. **模板占位符替换（保留原段落/表格/页眉页脚样式）**：
   ```bash
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/docx_tool.py" replace template.docx --map-json '{"{{company}}":"星辰科技","{{date}}":"2026-11-24"}' --output ./output/contract.docx
   ```

5. **提取文档内全部表格**：
   ```bash
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/docx_tool.py" extract-tables report.docx --format markdown
   ```

## 工作区约定
- 新建或输出 `.docx` 请使用任务工作区相对路径（如 `./output/result.docx`），勿覆盖用户原始附件。
- 如需批量生成复杂排版，也可以直接用 `"$OPC_OFFICE_PYTHON" -c "..."` 调用 `python-docx`。
