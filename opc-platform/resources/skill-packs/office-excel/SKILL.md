---
name: office-excel
description: 本地离线表格（.xlsx / .xlsm / .csv）处理工具箱：探查工作表与表头、分页或按区域读取值与公式、生成带样式与实时公式的 Excel 工作簿、支持筛选排序分组聚合以及 CSV 互转。
---

# 表格工具箱（本地离线）

使用预置隔离环境执行脚本（替换 `<skill_dir>` 为本技能所在目录）：

```bash
"$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/excel_tool.py" <子命令> [参数]
```

## 常用子命令

1. **检查工作簿结构与前几行预览（`.xlsx` / `.xlsm` / `.csv`）**：
   ```bash
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/excel_tool.py" inspect data.xlsx
   ```

2. **读取工作表（分页 / 指定范围 / 读取公式）**：
   ```bash
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/excel_tool.py" read data.xlsx --sheet Sheet1 --offset 0 --limit 100
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/excel_tool.py" read data.xlsx --range A1:E20 --formulas
   ```

3. **写入专业 `.xlsx`（支持多 Sheet、自动列宽、表头样式、冻结首行、实时公式）**：
   JSON 规范：
   ```json
   {
     "sheets": [
       {
         "name": "汇总",
         "headers": ["项目", "一月", "二月", "合计"],
         "rows": [
           ["研发", 100, 120, "=SUM(B2:C2)"],
           ["运营", 80, 90, "=SUM(B3:C3)"],
           ["总计", "=SUM(B2:B3)", "=SUM(C2:C3)", "=SUM(D2:D3)"]
         ]
       }
     ]
   }
   ```
   ```bash
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/excel_tool.py" write --input-json spec.json --output ./output/report.xlsx
   ```
   也可直接通过 `--stdin` 传入 JSON。

4. **筛选 / 排序 / 分组统计**：
   ```bash
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/excel_tool.py" query data.xlsx --where "部门=研发" --sort "-金额" --limit 50
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/excel_tool.py" query data.xlsx --group-by "部门" --agg "sum:金额"
   ```

5. **CSV 与 XLSX 互转**：
   ```bash
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/excel_tool.py" csv-to-xlsx input.csv --output ./output/table.xlsx
   "$OPC_OFFICE_PYTHON" "<skill_dir>/scripts/excel_tool.py" xlsx-to-csv input.xlsx --sheet Sheet1 --output ./output/table.csv
   ```

## 工作区与自由编程
- 写入产出文件一律放在当前任务工作区的相对路径（如 `./output/report.xlsx`）。
- 若遇跨表合并、透视统计、条件格式等高度定制需求，可直接用 `"$OPC_OFFICE_PYTHON" -c "..."` 或运行工作区内临时 `.py` 脚本调用 `openpyxl`。
