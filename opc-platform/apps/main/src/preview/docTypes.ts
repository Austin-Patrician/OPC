import path from 'node:path';
import type { DocPreviewKind } from '@opc/shared/ipc';

export const DOC_SCHEME = 'opc-doc';
export const DOC_ORIGIN = `${DOC_SCHEME}://asset`;
export const DOC_PDFJS_ORIGIN = `${DOC_SCHEME}://pdfjs`;

export const DOC_PREVIEW_LIMITS: Record<Exclude<DocPreviewKind, 'unsupported'>, number> = {
  pdf: 100 * 1024 * 1024,
  docx: 25 * 1024 * 1024,
  spreadsheet: 50 * 1024 * 1024,
  pptx: 25 * 1024 * 1024,
  text: 5 * 1024 * 1024,
  image: 25 * 1024 * 1024,
};

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.log',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.xml',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.sh',
  '.ps1',
  '.sql',
  '.toml',
  '.ini',
  '.env',
]);

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.svg',
  '.avif',
]);

const SPREADSHEET_EXTENSIONS = new Set(['.xlsx', '.xlsm', '.csv']);

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.csv': 'text/csv; charset=utf-8',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export interface DocClassification {
  kind: DocPreviewKind;
  ext: string;
  mimeType: string;
  tooLargeForInApp: boolean;
}

/**
 * Classifies a file for in-app preview and enforces per-format byte thresholds
 * so oversized archives never trigger renderer OOM.
 */
export function classifyDocPreview(fileName: string, bytes: number): DocClassification {
  const ext = path.extname(fileName).toLowerCase();
  let kind: DocPreviewKind = 'unsupported';

  if (ext === '.pdf') kind = 'pdf';
  else if (ext === '.docx') kind = 'docx';
  else if (SPREADSHEET_EXTENSIONS.has(ext)) kind = 'spreadsheet';
  else if (ext === '.pptx') kind = 'pptx';
  else if (IMAGE_EXTENSIONS.has(ext)) kind = 'image';
  else if (TEXT_EXTENSIONS.has(ext)) kind = 'text';

  const mimeType =
    MIME_BY_EXT[ext] ?? (kind === 'text' ? 'text/plain; charset=utf-8' : 'application/octet-stream');
  const limit = kind === 'unsupported' ? 0 : DOC_PREVIEW_LIMITS[kind];
  const tooLargeForInApp = kind !== 'unsupported' && bytes > limit;

  return { kind, ext, mimeType, tooLargeForInApp };
}

/** Parses an HTTP `Range: bytes=...` header against a known byte length. */
export function parseByteRange(
  rangeHeader: string | null,
  size: number,
): { kind: 'full' } | { kind: 'partial'; start: number; end: number } | { kind: 'invalid' } {
  if (!rangeHeader) return { kind: 'full' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return { kind: 'invalid' };
  const startRaw = match[1];
  const endRaw = match[2];

  if (!startRaw && !endRaw) return { kind: 'invalid' };
  if (size === 0) return { kind: 'invalid' };

  let start: number;
  let end: number;
  if (!startRaw && endRaw) {
    const suffixLength = Number(endRaw);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { kind: 'invalid' };
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw ? Math.min(Number(endRaw), size - 1) : size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= size) {
    return { kind: 'invalid' };
  }
  return { kind: 'partial', start, end };
}
