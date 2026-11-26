import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import iconv from 'iconv-lite';
import { afterEach, describe, expect, it } from 'vitest';
import { formatCellValue, parseCsvWindow, readSpreadsheetPageFromFile } from './spreadsheetReader';

const roots: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-sheet-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('formatCellValue', () => {
  it('formats formulas, rich text, dates, and hyperlinks concisely', () => {
    expect(formatCellValue({ formula: 'SUM(A1:A2)', result: 42 })).toBe('42');
    expect(formatCellValue({ formula: 'A1+1' })).toBe('=A1+1');
    expect(formatCellValue({ richText: [{ text: '你好' }, { text: '世界' }] })).toBe('你好世界');
    expect(formatCellValue(new Date(Date.UTC(2026, 10, 26, 0, 0, 0)))).toBe('2026-11-26');
    expect(formatCellValue({ text: 'Open', hyperlink: 'https://example.com' })).toBe('Open');
  });
});

describe('parseCsvWindow', () => {
  it('handles quoted commas/newlines and extracts only the requested row window', () => {
    const csv = '姓名,备注,金额\n"张三","包含,逗号\n和换行",100\n"李四","普通""引号""",200\n"王五",正常,300\n';
    const page1 = parseCsvWindow(csv, 0, 2);
    expect(page1.totalRows).toBe(4);
    expect(page1.colCount).toBe(3);
    expect(page1.rows).toEqual([
      ['姓名', '备注', '金额'],
      ['张三', '包含,逗号\n和换行', '100'],
    ]);

    const page2 = parseCsvWindow(csv, 2, 2);
    expect(page2.rows).toEqual([
      ['李四', '普通"引号"', '200'],
      ['王五', '正常', '300'],
    ]);
  });
});

describe('readSpreadsheetPageFromFile', () => {
  it('streams multi-sheet xlsx files with pagination and preserves sheet names', async () => {
    const dir = makeTempDir();
    const xlsxPath = path.join(dir, 'report.xlsx');
    const wb = new ExcelJS.Workbook();

    const s1 = wb.addWorksheet('销售汇总');
    s1.addRow(['部门', '金额']);
    for (let i = 1; i <= 15; i += 1) {
      s1.addRow([`部门-${i}`, { formula: `${i}*10`, result: i * 10 }]);
    }

    const s2 = wb.addWorksheet('人员明细');
    s2.addRow(['姓名', '入职日期']);
    s2.addRow(['张浮生', new Date(Date.UTC(2026, 0, 15))]);

    await wb.xlsx.writeFile(xlsxPath);

    const page1 = await readSpreadsheetPageFromFile({
      filePath: xlsxPath,
      sheetIndex: 0,
      offset: 0,
      limit: 5,
    });
    expect(page1.ok).toBe(true);
    expect(page1.sheets?.map((s) => s.name)).toEqual(['销售汇总', '人员明细']);
    expect(page1.totalRows).toBe(16);
    expect(page1.hasMore).toBe(true);
    expect(page1.rows).toEqual([
      ['部门', '金额'],
      ['部门-1', '10'],
      ['部门-2', '20'],
      ['部门-3', '30'],
      ['部门-4', '40'],
    ]);

    const sheet2 = await readSpreadsheetPageFromFile({
      filePath: xlsxPath,
      sheetIndex: 1,
      offset: 0,
      limit: 50,
    });
    expect(sheet2.ok).toBe(true);
    expect(sheet2.activeSheetIndex).toBe(1);
    expect(sheet2.rows).toEqual([
      ['姓名', '入职日期'],
      ['张浮生', '2026-01-15'],
    ]);
  });

  it('decodes GBK/GB18030 Chinese CSV files cleanly', async () => {
    const dir = makeTempDir();
    const csvPath = path.join(dir, 'gbk.csv');
    const encoded = iconv.encode('城市,销量\n上海,1200\n北京,980\n', 'gb18030');
    fs.writeFileSync(csvPath, encoded);

    const res = await readSpreadsheetPageFromFile({ filePath: csvPath, offset: 0, limit: 10 });
    expect(res.ok).toBe(true);
    expect(res.rows).toEqual([
      ['城市', '销量'],
      ['上海', '1200'],
      ['北京', '980'],
    ]);
  });

  it('handles workbooks with 3+ sheets and no sharedStrings.xml cleanly', async () => {
    const dir = makeTempDir();
    const xlsxPath = path.join(dir, 'numbers-only.xlsx');
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('One').addRow([1, 2]);
    wb.addWorksheet('Two').addRow([3, 4]);
    const third = wb.addWorksheet('Three');
    third.addRow([100, 200, 300]);
    third.addRow([400, 500, 600]);
    await wb.xlsx.writeFile(xlsxPath);

    const sheet3 = await readSpreadsheetPageFromFile({
      filePath: xlsxPath,
      sheetIndex: 2,
      offset: 1,
      limit: 10,
    });
    expect(sheet3.ok).toBe(true);
    expect(sheet3.activeSheetIndex).toBe(2);
    expect(sheet3.sheets).toEqual([
      { name: 'One', index: 0, rowCount: 1, colCount: 2 },
      { name: 'Two', index: 1, rowCount: 1, colCount: 2 },
      { name: 'Three', index: 2, rowCount: 2, colCount: 3 },
    ]);
    expect(sheet3.rows).toEqual([['400', '500', '600']]);
  });
});
