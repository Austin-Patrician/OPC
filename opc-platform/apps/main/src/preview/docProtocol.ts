import { protocol, type Session } from 'electron';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DOC_ORIGIN, DOC_PDFJS_ORIGIN, DOC_SCHEME, parseByteRange } from './docTypes';

export { DOC_ORIGIN, DOC_PDFJS_ORIGIN, DOC_SCHEME };

const PDFJS_MIME: Record<string, string> = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.json': 'application/json; charset=utf-8',
  '.properties': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export interface DocProtocolOptions {
  /** Directory hosting bundled `pdf.worker.min.mjs`, `cmaps/`, `standard_fonts/`, `wasm/`. */
  pdfjsAssetsDir: string;
  /** Resolves an active preview session id to its authorized local file path. */
  resolveSessionFile: (sessionId: string) => { filePath: string; mimeType: string } | undefined;
}

/** Must run before `app.whenReady()` so `fetch()`, `Range`, and workers work cleanly. */
export function registerDocScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: DOC_SCHEME,
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

/**
 * Resolves the directory containing PDF.js worker/CMap/font assets across dev and packaged builds.
 */
export function resolvePdfjsAssetsDir(input: {
  rendererDir: string;
  appPath: string;
}): string {
  const builtDir = path.join(input.rendererDir, 'pdfjs');
  if (existsSync(path.join(builtDir, 'pdf.worker.min.mjs'))) {
    return builtDir;
  }
  const devNodeModules = path.join(input.appPath, 'node_modules', 'pdfjs-dist');
  if (existsSync(path.join(devNodeModules, 'build', 'pdf.worker.min.mjs'))) {
    return devNodeModules;
  }
  return path.join(process.cwd(), 'node_modules', 'pdfjs-dist');
}

function resolvePdfjsAssetFile(assetsRoot: string, rawPath: string): string | null {
  const rel = decodeURIComponent(rawPath).replace(/^\/+/, '');
  if (!rel) return null;

  const root = path.resolve(assetsRoot);
  // In dev mode, `pdfjsAssetsDir` may point directly to `node_modules/pdfjs-dist`
  // where `pdf.worker.min.mjs` lives under `build/`.
  const mappedRel =
    rel === 'pdf.worker.min.mjs' && !existsSync(path.join(root, rel))
      ? path.join('build', 'pdf.worker.min.mjs')
      : rel;

  const target = path.resolve(root, mappedRel);
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    return null;
  }
  return target;
}

function streamFileResponse(
  filePath: string,
  mimeType: string,
  rangeHeader: string | null,
  options: { cacheControl: string; sandboxSvg?: boolean },
): Response {
  const stat = statSync(filePath);
  const parsedRange = parseByteRange(rangeHeader, stat.size);

  if (parsedRange.kind === 'invalid') {
    return new Response(null, {
      status: 416,
      headers: {
        'Content-Range': `bytes */${stat.size}`,
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  const isPartial = parsedRange.kind === 'partial';
  const start = isPartial ? parsedRange.start : 0;
  const end = isPartial ? parsedRange.end : Math.max(0, stat.size - 1);
  const contentLength = stat.size === 0 ? 0 : end - start + 1;

  const headers = new Headers({
    'Content-Type': mimeType,
    'Content-Length': String(contentLength),
    'Accept-Ranges': 'bytes',
    'Cache-Control': options.cacheControl,
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });

  if (isPartial) {
    headers.set('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  }
  if (options.sandboxSvg && (mimeType === 'image/svg+xml' || mimeType.startsWith('text/html'))) {
    headers.set('Content-Security-Policy', "sandbox; default-src 'none'");
  }

  if (stat.size === 0) {
    return new Response(new Uint8Array(0), { status: 200, headers });
  }

  const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(stream, { status: isPartial ? 206 : 200, headers });
}

/**
 * Installs `opc-doc://` handlers for streaming authorized documents (with HTTP Range
 * support for PDF.js) and serving bundled PDF.js worker/CMap/font assets offline.
 */
export function handleDocProtocol(targetSession: Session, options: DocProtocolOptions): void {
  const assetsRoot = path.resolve(options.pdfjsAssetsDir);

  targetSession.protocol.handle(DOC_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);

      if (url.hostname === 'pdfjs') {
        const assetFile = resolvePdfjsAssetFile(assetsRoot, url.pathname);
        if (!assetFile) return new Response('not found', { status: 404 });
        const ext = path.extname(assetFile).toLowerCase();
        const mime = PDFJS_MIME[ext] ?? 'application/octet-stream';
        return streamFileResponse(assetFile, mime, request.headers.get('range'), {
          cacheControl: 'public, max-age=3600',
        });
      }

      if (url.hostname === 'asset') {
        const sessionId = decodeURIComponent(url.pathname.slice(1));
        if (!sessionId || sessionId.includes('/')) {
          return new Response('forbidden', { status: 403 });
        }
        const resolved = options.resolveSessionFile(sessionId);
        if (!resolved || !existsSync(resolved.filePath) || !statSync(resolved.filePath).isFile()) {
          return new Response('not found', { status: 404 });
        }
        return streamFileResponse(
          resolved.filePath,
          resolved.mimeType,
          request.headers.get('range'),
          { cacheControl: 'no-store', sandboxSvg: true },
        );
      }

      return new Response('not found', { status: 404 });
    } catch {
      return new Response('document unavailable', { status: 400 });
    }
  });
}
