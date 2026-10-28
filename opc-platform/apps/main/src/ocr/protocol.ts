import { protocol } from 'electron';
import type { Session } from 'electron';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

/**
 * `opc-ocr://app/...` serves the OCR window, its bundle, the ONNX models and the
 * ONNX Runtime WASM binary. A file:// page cannot `fetch()` either of the last
 * two (Chromium blocks it), and a local HTTP server would mean a listening port.
 *
 * Everything lives under one origin so the WASM loader's dynamic `import()` of
 * `ort-wasm-simd-threaded.jsep.mjs` stays same-origin in production.
 */
export const OCR_SCHEME = 'opc-ocr';
export const OCR_ORIGIN = `${OCR_SCHEME}://app`;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

/** Must run before `app.whenReady()`; a standard scheme gets URLs, not opaque paths. */
export function registerOcrScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: OCR_SCHEME,
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

export interface OcrProtocolOptions {
  /** `out/renderer`: the OCR page and its hashed assets. */
  rendererDir: string;
  /** `resources/ocr` (dev) or `<resources>/ocr` (packaged): models + ort. */
  assetsDir: string;
}

/** Serve the OCR window's static files. Only these three roots are reachable. */
export function handleOcrProtocol(session: Session, options: OcrProtocolOptions): void {
  const rendererDir = path.resolve(options.rendererDir);
  const assetsDir = path.resolve(options.assetsDir);

  session.protocol.handle(OCR_SCHEME, async (request) => {
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname);

    let root: string;
    let relative: string;
    if (pathname.startsWith('/ort/')) {
      root = path.join(assetsDir, 'ort');
      relative = pathname.slice('/ort/'.length);
    } else if (pathname.startsWith('/models/')) {
      root = path.join(assetsDir, 'models');
      relative = pathname.slice('/models/'.length);
    } else {
      root = rendererDir;
      relative = pathname === '/' ? 'ocr.html' : pathname.slice(1);
    }

    const file = path.resolve(root, relative);
    if (file !== root && !file.startsWith(root + path.sep)) {
      return new Response('forbidden', { status: 403 });
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      return new Response('not found', { status: 404 });
    }

    const headers = new Headers();
    headers.set('Content-Type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    headers.set('Content-Length', String(statSync(file).size));
    // The dev page is on http://localhost, production on opc-ocr://app; both must
    // be able to read the models and the WASM binary.
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    headers.set('Cache-Control', 'no-store');
    // Production-only: in dev the page comes from Vite, whose React refresh
    // preamble is an inline script. Everything this page needs is same-origin.
    if (file.endsWith('.html')) {
      headers.set(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self';",
      );
    }
    const stream = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream<Uint8Array>;
    return new Response(stream, { status: 200, headers });
  });
}
