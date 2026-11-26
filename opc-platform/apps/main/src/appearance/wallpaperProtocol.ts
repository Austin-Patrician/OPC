import { protocol } from 'electron';
import type { Session } from 'electron';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

export const WALLPAPER_SCHEME = 'opc-wallpaper';
export const WALLPAPER_ORIGIN = `${WALLPAPER_SCHEME}://asset`;

const SAFE_ASSET_NAME = /^[A-Za-z0-9._-]+$/;
const STREAM_HIGH_WATER_MARK = 256 * 1024;

export const WALLPAPER_MIME_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

export const WALLPAPER_CORS_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, Content-Type',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

export type ParsedByteRange =
  | { invalid: true }
  | { invalid: false; start: number; end: number };

/** Parses an HTTP `Range: bytes=...` header against `fileSize`. */
export function parseByteRange(rangeHeader: string | null, fileSize: number): ParsedByteRange | null {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return { invalid: true };
  const rawStart = match[1] ?? '';
  const rawEnd = match[2] ?? '';
  if (!rawStart && !rawEnd) return { invalid: true };
  if (fileSize <= 0) return { invalid: true };

  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true };
    const start = Math.max(0, fileSize - suffix);
    return { invalid: false, start, end: fileSize - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd ? Math.min(Number(rawEnd), fileSize - 1) : fileSize - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= fileSize || end < start) {
    return { invalid: true };
  }
  return { invalid: false, start, end };
}

/** Resolves a wallpaper asset filename safely inside `wallpapersDir` without path traversal. */
export function resolveWallpaperAssetPath(wallpapersDir: string, rawName: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawName).replace(/^\/+/, '');
  } catch {
    return null;
  }
  if (!decoded || decoded === '.' || decoded === '..' || !SAFE_ASSET_NAME.test(decoded)) {
    return null;
  }
  const ext = path.extname(decoded).toLowerCase();
  if (!WALLPAPER_MIME_TYPES[ext]) return null;
  const root = path.resolve(wallpapersDir);
  const target = path.resolve(root, decoded);
  if (!target.startsWith(`${root}${path.sep}`)) return null;
  return target;
}

/** Registers `opc-wallpaper://` as a privileged streaming scheme before `app.whenReady()`. */
export function registerWallpaperScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: WALLPAPER_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/** Serves local wallpaper files over HTTP 206 Range streaming so large videos never hit JS heap. */
export function handleWallpaperProtocol(targetSession: Session, wallpapersDir: string): void {
  targetSession.protocol.handle(WALLPAPER_SCHEME, async (request) => {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: WALLPAPER_CORS_HEADERS });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: WALLPAPER_CORS_HEADERS });
    }
    try {
      const url = new URL(request.url);
      const absPath = resolveWallpaperAssetPath(wallpapersDir, url.pathname);
      if (!absPath) return new Response('Not Found', { status: 404, headers: WALLPAPER_CORS_HEADERS });

      const stat = statSync(absPath, { throwIfNoEntry: false });
      if (!stat || !stat.isFile()) {
        return new Response('Not Found', { status: 404, headers: WALLPAPER_CORS_HEADERS });
      }

      const mimeType = WALLPAPER_MIME_TYPES[path.extname(absPath).toLowerCase()] ?? 'application/octet-stream';
      const parsedRange = parseByteRange(request.headers.get('range'), stat.size);
      if (parsedRange?.invalid) {
        return new Response(null, {
          status: 416,
          headers: {
            ...WALLPAPER_CORS_HEADERS,
            'Content-Range': `bytes */${stat.size}`,
          },
        });
      }

      const headers = new Headers({
        ...WALLPAPER_CORS_HEADERS,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000, immutable',
      });

      if (request.method === 'HEAD') {
        headers.set('Content-Length', String(stat.size));
        return new Response(null, { status: 200, headers });
      }

      const start = parsedRange ? parsedRange.start : 0;
      const end = parsedRange ? parsedRange.end : stat.size - 1;
      const length = Math.max(0, end - start + 1);
      headers.set('Content-Length', String(length));

      if (parsedRange) {
        headers.set('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      }

      const stream = Readable.toWeb(
        createReadStream(absPath, {
          start,
          end,
          highWaterMark: STREAM_HIGH_WATER_MARK,
        }),
      ) as ReadableStream<Uint8Array>;

      return new Response(stream, {
        status: parsedRange ? 206 : 200,
        headers,
      });
    } catch {
      return new Response('Wallpaper unavailable', { status: 400 });
    }
  });
}
