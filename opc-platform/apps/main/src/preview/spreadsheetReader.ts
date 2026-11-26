import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import zlib from 'node:zlib';
import ExcelJS from 'exceljs';
import iconv from 'iconv-lite';
import type { SpreadsheetPageResult, SpreadsheetSheetMeta } from '@opc/shared/ipc';

export const DEFAULT_SPREADSHEET_PAGE_SIZE = 500;
export const MAX_SPREADSHEET_PAGE_SIZE = 1000;
export const MAX_SPREADSHEET_COLS = 200;

export interface ReadSpreadsheetPageInput {
  filePath: string;
  sheetIndex?: number;
  offset?: number;
  limit?: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatDateValue(date: Date): string {
  if (Number.isNaN(date.getTime())) return '';
  const y = date.getUTCFullYear();
  const m = pad2(date.getUTCMonth() + 1);
  const d = pad2(date.getUTCDate());
  const hh = date.getUTCHours();
  const mm = date.getUTCMinutes();
  const ss = date.getUTCSeconds();
  if (hh === 0 && mm === 0 && ss === 0) return `${y}-${m}-${d}`;
  return `${y}-${m}-${d} ${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
}

/** Converts an ExcelJS cell value union into concise display text without retaining cell objects. */
export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return formatDateValue(value);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if ('formula' in obj || 'result' in obj) {
      if (obj.result !== undefined && obj.result !== null) {
        return formatCellValue(obj.result);
      }
      return typeof obj.formula === 'string' ? `=${obj.formula}` : '';
    }
    if (Array.isArray(obj.richText)) {
      return obj.richText
        .map((part) =>
          part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
            ? (part as { text: string }).text
            : '',
        )
        .join('');
    }
    if ('text' in obj && obj.text !== undefined && obj.text !== null) {
      return formatCellValue(obj.text);
    }
    if (typeof obj.hyperlink === 'string') return obj.hyperlink;
    if (typeof obj.error === 'string') return obj.error;
  }
  return String(value);
}

function decodeCsvBuffer(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return iconv.decode(buf, 'gb18030');
  }
}

/**
 * Parses CSV text cleanly with RFC-4180 quote handling while capturing only the requested
 * row slice `[offset, offset + limit)` in memory.
 */
export function parseCsvWindow(
  text: string,
  offset: number,
  limit: number,
): {
  rows: string[][];
  totalRows: number;
  colCount: number;
  truncatedCols: boolean;
} {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let field = '';
  let inQuotes = false;
  let totalRows = 0;
  let colCount = 0;
  let truncatedCols = false;

  const flushField = () => {
    if (currentRow.length < MAX_SPREADSHEET_COLS) {
      currentRow.push(field);
    } else {
      truncatedCols = true;
    }
    field = '';
  };

  const flushRow = () => {
    flushField();
    // Skip trailing empty newline at EOF when nothing was written in the last line.
    if (currentRow.length === 1 && currentRow[0] === '' && totalRows > 0) {
      currentRow = [];
      return;
    }
    const rowIdx = totalRows;
    totalRows += 1;
    colCount = Math.max(colCount, currentRow.length);
    if (rowIdx >= offset && rows.length < limit) {
      rows.push(currentRow);
    }
    currentRow = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      flushField();
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      flushRow();
    } else if (ch === '\n') {
      flushRow();
    } else {
      field += ch;
    }
  }

  if (field.length > 0 || currentRow.length > 0) {
    flushRow();
  }

  return { rows, totalRows, colCount, truncatedCols };
}

function readCsvPage(filePath: string, offset: number, limit: number): SpreadsheetPageResult {
  const buf = fs.readFileSync(filePath);
  const text = decodeCsvBuffer(buf);
  const { rows, totalRows, colCount, truncatedCols } = parseCsvWindow(text, offset, limit);
  const sheetName = path.basename(filePath);
  const sheets: SpreadsheetSheetMeta[] = [
    { name: sheetName, index: 0, rowCount: totalRows, colCount },
  ];
  return {
    ok: true,
    sheets,
    activeSheetIndex: 0,
    startRow: offset,
    totalRows,
    colCount,
    rows,
    hasMore: offset + rows.length < totalRows,
    truncatedCols,
  };
}

function clampPageParams(input: ReadSpreadsheetPageInput): {
  sheetIndex: number;
  offset: number;
  limit: number;
} {
  const sheetIndex =
    typeof input.sheetIndex === 'number' && Number.isFinite(input.sheetIndex)
      ? Math.max(0, Math.floor(input.sheetIndex))
      : 0;
  const offset =
    typeof input.offset === 'number' && Number.isFinite(input.offset)
      ? Math.max(0, Math.floor(input.offset))
      : 0;
  const rawLimit =
    typeof input.limit === 'number' && Number.isFinite(input.limit)
      ? Math.floor(input.limit)
      : DEFAULT_SPREADSHEET_PAGE_SIZE;
  const limit = Math.max(1, Math.min(MAX_SPREADSHEET_PAGE_SIZE, rawLimit));
  return { sheetIndex, offset, limit };
}

interface PreloadedWorkbookSheet {
  id: number;
  name: string;
  rId: string;
  state?: string;
}

interface ResolvedXlsxSheet extends PreloadedWorkbookSheet {
  entryPath: string;
  sheetNo: string;
}

interface ZipEntryMeta {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

interface ZipIndex {
  fileSize: number;
  entries: Map<string, ZipEntryMeta>;
  lowerEntries: Map<string, ZipEntryMeta>;
}

interface ExcelWorksheetRowLike {
  number: number;
  cellCount?: number;
  getCell(col: number): { value: unknown };
}

interface ExcelWorksheetReaderLike extends AsyncIterable<ExcelWorksheetRowLike> {
  id?: number | string;
  name?: string;
  columns?: Array<{ width?: number } | undefined> | null;
}

interface ExcelWorkbookReaderInternals {
  model?: { sheets: PreloadedWorkbookSheet[] };
  sharedStrings?: unknown[];
  _parseRels(stream: NodeJS.ReadableStream): Promise<void>;
  _parseWorkbook(stream: NodeJS.ReadableStream): Promise<void>;
  _parseStyles(stream: NodeJS.ReadableStream): Promise<void>;
  _parseSharedStrings(stream: NodeJS.ReadableStream): AsyncIterable<unknown>;
  _parseWorksheet(
    stream: NodeJS.ReadableStream,
    sheetNo: string,
  ): AsyncIterable<{ eventType?: string; value?: ExcelWorksheetReaderLike }>;
}

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CD_SIG = 0x02014b50;
const ZIP_LFH_SIG = 0x04034b50;

function readExactSync(fd: number, length: number, position: number): Buffer {
  const buf = Buffer.allocUnsafe(length);
  let totalRead = 0;
  while (totalRead < length) {
    const n = fs.readSync(fd, buf, totalRead, length - totalRead, position + totalRead);
    if (n <= 0) {
      throw new Error(`Unexpected EOF reading zip at offset ${position + totalRead}`);
    }
    totalRead += n;
  }
  return buf;
}

function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[\da-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (entity, code: string) => {
    switch (code) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const num = code.startsWith('#x')
          ? Number.parseInt(code.slice(2), 16)
          : Number.parseInt(code.slice(1), 10);
        return Number.isFinite(num) && num > 0 ? String.fromCodePoint(num) : entity;
      }
    }
  });
}

function parseXmlAttributes(tagBody: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(tagBody)) !== null) {
    const key = match[1];
    const val = match[2] ?? match[3] ?? '';
    if (key) {
      attrs[key] = decodeXmlEntities(val);
    }
  }
  return attrs;
}

function indexZipEntries(filePath: string): ZipIndex | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    if (stat.size < 22) return null;

    const tailSize = Math.min(stat.size, 65536 + 22);
    const tailOffset = stat.size - tailSize;
    const tail = readExactSync(fd, tailSize, tailOffset);

    let eocdPos = -1;
    for (let pos = tailSize - 22; pos >= 0; pos -= 1) {
      if (tail.readUInt32LE(pos) === ZIP_EOCD_SIG) {
        const commentLen = tail.readUInt16LE(pos + 20);
        if (pos + 22 + commentLen === tailSize) {
          eocdPos = pos;
          break;
        }
      }
    }
    if (eocdPos < 0) return null;

    const cdSize = tail.readUInt32LE(eocdPos + 12);
    const cdOffset = tail.readUInt32LE(eocdPos + 16);
    if (
      cdSize === 0xffffffff ||
      cdOffset === 0xffffffff ||
      cdSize === 0 ||
      cdSize > 32 * 1024 * 1024 ||
      cdOffset + cdSize > stat.size
    ) {
      return null;
    }

    const cd = readExactSync(fd, cdSize, cdOffset);
    const entries = new Map<string, ZipEntryMeta>();
    const lowerEntries = new Map<string, ZipEntryMeta>();

    let offset = 0;
    while (offset + 46 <= cd.length) {
      if (cd.readUInt32LE(offset) !== ZIP_CD_SIG) break;
      const method = cd.readUInt16LE(offset + 10);
      const compressedSize = cd.readUInt32LE(offset + 20);
      const uncompressedSize = cd.readUInt32LE(offset + 24);
      const nameLen = cd.readUInt16LE(offset + 28);
      const extraLen = cd.readUInt16LE(offset + 30);
      const commentLen = cd.readUInt16LE(offset + 32);
      const localHeaderOffset = cd.readUInt32LE(offset + 42);
      const entryEnd = offset + 46 + nameLen + extraLen + commentLen;
      if (entryEnd > cd.length) break;

      const rawName = cd
        .toString('utf8', offset + 46, offset + 46 + nameLen)
        .replace(/\\/g, '/')
        .replace(/^\/+/, '');
      offset = entryEnd;

      if (!rawName || rawName.endsWith('/')) continue;
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
        return null;
      }

      const meta: ZipEntryMeta = {
        name: rawName,
        method,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      };
      entries.set(rawName, meta);
      lowerEntries.set(rawName.toLowerCase(), meta);
    }

    return entries.size > 0 ? { fileSize: stat.size, entries, lowerEntries } : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors while indexing archive entries.
      }
    }
  }
}

function findZipEntry(zip: ZipIndex, entryPath: string): ZipEntryMeta | undefined {
  const normalized = entryPath.replace(/\\/g, '/').replace(/^\/+/, '');
  return zip.entries.get(normalized) ?? zip.lowerEntries.get(normalized.toLowerCase());
}

function resolveZipDataOffset(filePath: string, zip: ZipIndex, meta: ZipEntryMeta): number | null {
  if (meta.localHeaderOffset + 30 > zip.fileSize) return null;
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const lfh = readExactSync(fd, 30, meta.localHeaderOffset);
    if (lfh.readUInt32LE(0) !== ZIP_LFH_SIG) return null;
    const dataOffset =
      meta.localHeaderOffset + 30 + lfh.readUInt16LE(26) + lfh.readUInt16LE(28);
    if (dataOffset + meta.compressedSize > zip.fileSize) return null;
    return dataOffset;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors.
      }
    }
  }
}

function readZipEntryUtf8(filePath: string, zip: ZipIndex, entryPath: string): string | null {
  const meta = findZipEntry(zip, entryPath);
  if (!meta) return null;
  if (
    (meta.method !== 0 && meta.method !== 8) ||
    meta.compressedSize > 8 * 1024 * 1024 ||
    meta.uncompressedSize > 16 * 1024 * 1024
  ) {
    return null;
  }
  if (meta.compressedSize === 0) return '';
  const dataOffset = resolveZipDataOffset(filePath, zip, meta);
  if (dataOffset === null) return null;

  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const compressed = readExactSync(fd, meta.compressedSize, dataOffset);
    const raw = meta.method === 0 ? compressed : zlib.inflateRawSync(compressed);
    return raw.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors.
      }
    }
  }
}

function openZipEntryStream(
  filePath: string,
  zip: ZipIndex,
  meta: ZipEntryMeta,
): NodeJS.ReadableStream {
  if (meta.method !== 0 && meta.method !== 8) {
    throw new Error(`Unsupported ZIP compression method: ${meta.method}`);
  }
  if (meta.compressedSize === 0) {
    return Readable.from([]);
  }
  const dataOffset = resolveZipDataOffset(filePath, zip, meta);
  if (dataOffset === null) {
    throw new Error(`Invalid ZIP local header for entry: ${meta.name}`);
  }
  const rawStream = fs.createReadStream(filePath, {
    start: dataOffset,
    end: dataOffset + meta.compressedSize - 1,
    highWaterMark: 64 * 1024,
  });
  if (meta.method === 0) {
    return rawStream;
  }
  const inflate = zlib.createInflateRaw({ chunkSize: 64 * 1024 });
  rawStream.on('error', (err) => inflate.destroy(err));
  inflate.once('close', () => rawStream.destroy());
  return rawStream.pipe(inflate);
}

function normalizeWorkbookRelTarget(target: string): string {
  const cleaned = target.replace(/\\/g, '/').replace(/^\.\//, '');
  if (cleaned.startsWith('/')) {
    return cleaned.replace(/^\/+/, '');
  }
  if (cleaned.startsWith('xl/')) {
    return cleaned;
  }
  return path.posix.normalize(`xl/${cleaned}`);
}

function resolveXlsxSheetEntries(filePath: string, zip: ZipIndex): ResolvedXlsxSheet[] {
  const relsXml = readZipEntryUtf8(filePath, zip, 'xl/_rels/workbook.xml.rels');
  const rIdToPath = new Map<string, string>();
  if (relsXml) {
    const relRe = /<Relationship\b([^>]*?)\/?>/g;
    let relMatch: RegExpExecArray | null;
    while ((relMatch = relRe.exec(relsXml)) !== null) {
      const attrs = parseXmlAttributes(relMatch[1] ?? '');
      const id = attrs.Id;
      const target = attrs.Target;
      if (!id || !target) continue;
      rIdToPath.set(id, normalizeWorkbookRelTarget(target));
    }
  }

  const workbookXml = readZipEntryUtf8(filePath, zip, 'xl/workbook.xml');
  const sheets: ResolvedXlsxSheet[] = [];
  if (workbookXml) {
    const sheetRe = /<(?:\w+:)?sheet\b([^>]*?)\/?>/g;
    let sheetMatch: RegExpExecArray | null;
    while ((sheetMatch = sheetRe.exec(workbookXml)) !== null) {
      const attrs = parseXmlAttributes(sheetMatch[1] ?? '');
      const name = attrs.name?.trim();
      const rId = attrs['r:id'] ?? attrs.id ?? '';
      const idNum = Number.parseInt(attrs.sheetId ?? '', 10);
      const entryPath = rIdToPath.get(rId);
      if (!name || !entryPath) continue;
      const sheetEntry = findZipEntry(zip, entryPath);
      if (!sheetEntry) continue;
      const sheetNoMatch = /sheet(\d+)\.xml$/i.exec(sheetEntry.name);
      sheets.push({
        id: Number.isFinite(idNum) && idNum > 0 ? idNum : sheets.length + 1,
        name,
        rId,
        ...(attrs.state ? { state: attrs.state } : {}),
        entryPath: sheetEntry.name,
        sheetNo: sheetNoMatch?.[1] ?? String(sheets.length + 1),
      });
    }
  }

  if (sheets.length > 0) {
    return sheets;
  }

  // Fallback for minimalist workbooks missing workbook.xml metadata.
  const numberedSheets: Array<{ sheetNoNum: number; sheetNo: string; entryName: string }> = [];
  for (const meta of zip.entries.values()) {
    const m = /^xl\/worksheets\/sheet(\d+)\.xml$/i.exec(meta.name);
    if (m?.[1]) {
      numberedSheets.push({
        sheetNoNum: Number.parseInt(m[1], 10),
        sheetNo: m[1],
        entryName: meta.name,
      });
    }
  }
  numberedSheets.sort((a, b) => a.sheetNoNum - b.sheetNoNum);
  return numberedSheets.map((item, idx) => ({
    id: item.sheetNoNum,
    name: `Sheet${idx + 1}`,
    rId: '',
    entryPath: item.entryName,
    sheetNo: item.sheetNo,
  }));
}

function parseExcelColLetters(letters: string): number {
  let col = 0;
  for (let i = 0; i < letters.length; i += 1) {
    const code = letters.toUpperCase().charCodeAt(i);
    if (code >= 65 && code <= 90) {
      col = col * 26 + (code - 64);
    }
  }
  return col;
}

/**
 * Counts row count and max column width for non-active sheets using an O(1) memory chunk scan
 * without constructing ExcelJS Row/Cell objects or creating temporary files.
 */
async function scanInactiveWorksheetDimensions(
  filePath: string,
  zip: ZipIndex,
  meta: ZipEntryMeta,
): Promise<{ rowCount: number; colCount: number }> {
  const stream = openZipEntryStream(filePath, zip, meta);
  const decoder = new StringDecoder('utf8');
  let carry = '';
  let rowTagCount = 0;
  let maxRowAttr = 0;
  let colCount = 0;

  const scanBody = (body: string) => {
    if (colCount === 0) {
      const dimMatch = /<dimension\b[^>]*\bref=(?:"|')(?:[A-Za-z]+\d+:)?([A-Za-z]+)(\d+)(?:"|')/.exec(
        body,
      );
      if (dimMatch?.[1]) {
        colCount = Math.min(MAX_SPREADSHEET_COLS, parseExcelColLetters(dimMatch[1]));
      }
    }
    const rowRe = /<(?:\w+:)?row\b([^>]*?)>/g;
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(body)) !== null) {
      rowTagCount += 1;
      const rMatch = /\br=(?:"|')(\d+)(?:"|')/.exec(m[1] ?? '');
      if (rMatch?.[1]) {
        const rNum = Number.parseInt(rMatch[1], 10);
        if (Number.isFinite(rNum) && rNum > maxRowAttr) {
          maxRowAttr = rNum;
        }
      }
    }
  };

  for await (const chunk of stream) {
    const decoded =
      typeof chunk === 'string' ? chunk : decoder.write(chunk as Buffer);
    const text = carry + decoded;
    const lastLt = text.lastIndexOf('<');
    const lastGt = text.lastIndexOf('>');
    if (lastLt > lastGt) {
      scanBody(text.slice(0, lastLt));
      carry = text.slice(lastLt);
    } else {
      scanBody(text);
      carry = '';
    }
  }
  const finalTail = carry + decoder.end();
  if (finalTail) {
    scanBody(finalTail);
  }

  return {
    rowCount: rowTagCount > 0 ? Math.max(rowTagCount, maxRowAttr) : 0,
    colCount,
  };
}

function consumeWorksheetRows(
  worksheetReader: ExcelWorksheetReaderLike,
  offset: number,
  limit: number,
): Promise<{
  rows: string[][];
  colWidths?: number[];
  totalRows: number;
  colCount: number;
  truncatedCols: boolean;
}> {
  return (async () => {
    const activeRows: string[][] = [];
    let sheetRows = 0;
    let sheetCols = 0;
    let truncatedCols = false;

    for await (const row of worksheetReader) {
      const zeroBasedRow = Math.max(0, row.number - 1);
      sheetRows = Math.max(sheetRows, zeroBasedRow + 1);

      const rowColCount = Math.min(MAX_SPREADSHEET_COLS, row.cellCount || 0);
      if ((row.cellCount || 0) > MAX_SPREADSHEET_COLS) {
        truncatedCols = true;
      }

      if (zeroBasedRow >= offset && zeroBasedRow < offset + limit) {
        while (activeRows.length < zeroBasedRow - offset) {
          activeRows.push([]);
        }
        const cells: string[] = [];
        for (let col = 1; col <= rowColCount; col += 1) {
          cells.push(formatCellValue(row.getCell(col).value));
        }
        while (cells.length > 0 && cells[cells.length - 1] === '') {
          cells.pop();
        }
        sheetCols = Math.max(sheetCols, cells.length);
        activeRows.push(cells);
      } else {
        sheetCols = Math.max(sheetCols, rowColCount);
      }
    }

    let colWidths: number[] | undefined;
    if (Array.isArray(worksheetReader.columns) && worksheetReader.columns.length > 0) {
      colWidths = worksheetReader.columns.slice(0, MAX_SPREADSHEET_COLS).map((col) => {
        const w =
          typeof col?.width === 'number' && Number.isFinite(col.width) ? col.width : 12;
        return Math.min(360, Math.max(72, Math.round(w * 8 + 16)));
      });
    }

    return {
      rows: activeRows,
      ...(colWidths ? { colWidths } : {}),
      totalRows: sheetRows,
      colCount: sheetCols,
      truncatedCols,
    };
  })();
}

/**
 * Streams an `.xlsx` / `.xlsm` / `.csv` file and extracts only the requested row window
 * for one sheet so giant spreadsheets stay within a tight memory envelope.
 */
export async function readSpreadsheetPageFromFile(
  input: ReadSpreadsheetPageInput,
): Promise<SpreadsheetPageResult> {
  const ext = path.extname(input.filePath).toLowerCase();
  const { sheetIndex, offset, limit } = clampPageParams(input);

  if (!fs.existsSync(input.filePath)) {
    return { ok: false, error: '表格文件不存在' };
  }

  if (ext === '.csv') {
    return readCsvPage(input.filePath, offset, limit);
  }

  const zip = indexZipEntries(input.filePath);
  if (!zip) {
    return readSpreadsheetViaFallbackWorkbookReader(input.filePath, sheetIndex, offset, limit);
  }

  const resolvedSheets = resolveXlsxSheetEntries(input.filePath, zip);
  if (resolvedSheets.length === 0) {
    return readSpreadsheetViaFallbackWorkbookReader(input.filePath, sheetIndex, offset, limit);
  }

  const resolvedIndex = sheetIndex < resolvedSheets.length ? sheetIndex : 0;
  const activeSheetMeta = resolvedSheets[resolvedIndex];
  if (!activeSheetMeta) {
    return { ok: false, error: '工作簿不包含可读取的工作表' };
  }

  const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(input.filePath, {
    worksheets: 'emit',
    sharedStrings: 'cache',
    styles: 'cache',
    hyperlinks: 'ignore',
    entries: 'ignore',
  });
  const internals = workbookReader as unknown as ExcelWorkbookReaderInternals;

  // Prepare workbook relationships, styles, and sharedStrings deterministically BEFORE
  // streaming the selected worksheet so ExcelJS never queues temp files or drops sheets.
  const relsEntry = findZipEntry(zip, 'xl/_rels/workbook.xml.rels');
  if (relsEntry) {
    await internals._parseRels(openZipEntryStream(input.filePath, zip, relsEntry));
  }
  const workbookEntry = findZipEntry(zip, 'xl/workbook.xml');
  if (workbookEntry) {
    await internals._parseWorkbook(openZipEntryStream(input.filePath, zip, workbookEntry));
  }
  if (!internals.model) {
    internals.model = { sheets: resolvedSheets };
  }
  const stylesEntry = findZipEntry(zip, 'xl/styles.xml');
  if (stylesEntry) {
    await internals._parseStyles(openZipEntryStream(input.filePath, zip, stylesEntry));
  }
  const sharedStringsEntry = findZipEntry(zip, 'xl/sharedStrings.xml');
  if (sharedStringsEntry) {
    for await (const _chunk of internals._parseSharedStrings(
      openZipEntryStream(input.filePath, zip, sharedStringsEntry),
    )) {
      // Cache sharedStrings directly on workbookReader.
    }
  } else if (!internals.sharedStrings) {
    internals.sharedStrings = [];
  }

  const activeEntry = findZipEntry(zip, activeSheetMeta.entryPath);
  if (!activeEntry) {
    return { ok: false, error: '找不到目标工作表数据' };
  }

  let activeResult: Awaited<ReturnType<typeof consumeWorksheetRows>> | null = null;
  for await (const ev of internals._parseWorksheet(
    openZipEntryStream(input.filePath, zip, activeEntry),
    activeSheetMeta.sheetNo,
  )) {
    if (ev.eventType === 'worksheet' && ev.value) {
      activeResult = await consumeWorksheetRows(ev.value, offset, limit);
      break;
    }
  }

  if (!activeResult) {
    return { ok: false, error: '无法解析目标工作表' };
  }

  const sheets: SpreadsheetSheetMeta[] = await Promise.all(
    resolvedSheets.map(async (sheet, idx) => {
      if (idx === resolvedIndex) {
        return {
          name: sheet.name,
          index: idx,
          rowCount: activeResult.totalRows,
          colCount: activeResult.colCount,
        };
      }
      const entry = findZipEntry(zip, sheet.entryPath);
      const dims = entry
        ? await scanInactiveWorksheetDimensions(input.filePath, zip, entry)
        : { rowCount: 0, colCount: 0 };
      return {
        name: sheet.name,
        index: idx,
        rowCount: dims.rowCount,
        colCount: dims.colCount,
      };
    }),
  );

  return {
    ok: true,
    sheets,
    activeSheetIndex: resolvedIndex,
    startRow: offset,
    totalRows: activeResult.totalRows,
    colCount: activeResult.colCount,
    rows: activeResult.rows,
    ...(activeResult.colWidths ? { colWidths: activeResult.colWidths } : {}),
    hasMore: offset + activeResult.rows.length < activeResult.totalRows,
    truncatedCols: activeResult.truncatedCols,
  };
}

async function readSpreadsheetViaFallbackWorkbookReader(
  filePath: string,
  sheetIndex: number,
  offset: number,
  limit: number,
): Promise<SpreadsheetPageResult> {
  const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    worksheets: 'emit',
    sharedStrings: 'cache',
    styles: 'cache',
    hyperlinks: 'ignore',
    entries: 'ignore',
  });
  const internals = workbookReader as unknown as ExcelWorkbookReaderInternals;
  if (!internals.model) {
    internals.model = { sheets: [] };
  }

  const sheets: SpreadsheetSheetMeta[] = [];
  let activeRows: string[][] = [];
  let activeColWidths: number[] | undefined;
  let activeTotalRows = 0;
  let activeColCount = 0;
  let activeTruncatedCols = false;
  let currentIndex = 0;

  for await (const worksheetReader of workbookReader) {
    const idx = currentIndex++;
    const wsLike = worksheetReader as unknown as ExcelWorksheetReaderLike;
    const name = wsLike.name?.trim() || `Sheet${idx + 1}`;
    const isActive = idx === sheetIndex;

    if (isActive) {
      const parsed = await consumeWorksheetRows(wsLike, offset, limit);
      activeRows = parsed.rows;
      activeColWidths = parsed.colWidths;
      activeTotalRows = parsed.totalRows;
      activeColCount = parsed.colCount;
      activeTruncatedCols = parsed.truncatedCols;
      sheets.push({
        name,
        index: idx,
        rowCount: parsed.totalRows,
        colCount: parsed.colCount,
      });
    } else {
      let rowCount = 0;
      let colCount = 0;
      for await (const row of worksheetReader) {
        const zeroBasedRow = Math.max(0, row.number - 1);
        rowCount = Math.max(rowCount, zeroBasedRow + 1);
        colCount = Math.max(colCount, Math.min(MAX_SPREADSHEET_COLS, row.cellCount || 0));
      }
      sheets.push({ name, index: idx, rowCount, colCount });
    }
  }

  if (sheets.length === 0) {
    return { ok: false, error: '工作簿不包含可读取的工作表' };
  }

  const resolvedIndex = sheetIndex < sheets.length ? sheetIndex : 0;
  if (resolvedIndex !== sheetIndex) {
    return readSpreadsheetViaFallbackWorkbookReader(filePath, 0, offset, limit);
  }

  return {
    ok: true,
    sheets,
    activeSheetIndex: resolvedIndex,
    startRow: offset,
    totalRows: activeTotalRows,
    colCount: activeColCount,
    rows: activeRows,
    ...(activeColWidths ? { colWidths: activeColWidths } : {}),
    hasMore: offset + activeRows.length < activeTotalRows,
    truncatedCols: activeTruncatedCols,
  };
}
