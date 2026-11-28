import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NetworkClient } from '../network/networkClient';
import {
  detectFaviconImageMime,
  extractHtmlIconCandidates,
  FaviconService,
  normalizeFaviconHost,
  parentDomainOf,
} from './faviconService';

const VALID_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
]);

const VALID_ICO = new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]);

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'opc-favicon-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('faviconService helpers', () => {
  it('normalizes valid public domains/URLs and blocks localhost, private suffixes, and IPs', () => {
    expect(normalizeFaviconHost('https://Docs.Python.org/3/library/')).toBe('docs.python.org');
    expect(normalizeFaviconHost('openai.com')).toBe('openai.com');

    expect(normalizeFaviconHost('http://localhost:3000/test')).toBeNull();
    expect(normalizeFaviconHost('http://myhost.local/icon.png')).toBeNull();
    expect(normalizeFaviconHost('api.internal')).toBeNull();
    expect(normalizeFaviconHost('http://127.0.0.1/favicon.ico')).toBeNull();
    expect(normalizeFaviconHost('http://192.168.1.10/')).toBeNull();
    expect(normalizeFaviconHost('http://[::1]/')).toBeNull();
    expect(normalizeFaviconHost('file:///Users/a/icon.png')).toBeNull();
    expect(normalizeFaviconHost('intranet')).toBeNull();
  });

  it('computes safe parent domains including multi-part public suffixes', () => {
    expect(parentDomainOf('docs.python.org')).toBe('python.org');
    expect(parentDomainOf('python.org')).toBeNull();
    expect(parentDomainOf('news.bbc.co.uk')).toBe('bbc.co.uk');
    expect(parentDomainOf('bbc.co.uk')).toBeNull();
  });

  it('extracts prioritized icon links from HTML and filters unsafe targets', () => {
    const html = `
      <html>
        <head>
          <link rel="stylesheet" href="/app.css">
          <link rel="apple-touch-icon" href="/apple.png">
          <link rel="icon" type="image/svg+xml" href="/logo.svg">
          <link rel="shortcut icon" href="/static/fav.png?v=2">
          <link rel="icon" href="http://127.0.0.1/bad.png">
          <link rel="icon" href="javascript:alert(1)">
        </head>
      </html>
    `;
    expect(extractHtmlIconCandidates(html, 'https://example.com/docs/intro')).toEqual([
      'https://example.com/static/fav.png?v=2',
      'https://example.com/logo.svg',
      'https://example.com/apple.png',
    ]);
  });

  it('validates binary and safe SVG signatures while rejecting HTML soft-404s and script SVGs', () => {
    expect(detectFaviconImageMime(VALID_PNG)).toBe('image/png');
    expect(detectFaviconImageMime(VALID_ICO)).toBe('image/x-icon');
    expect(detectFaviconImageMime(Buffer.from('<html><body>Not Found</body></html>'), 'image/png')).toBeNull();
    expect(
      detectFaviconImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>')),
    ).toBe('image/svg+xml');
    expect(
      detectFaviconImageMime(Buffer.from('<svg onload="alert(1)"><script>x()</script></svg>'), 'image/svg+xml'),
    ).toBeNull();
  });
});

describe('FaviconService', () => {
  it('fetches /favicon.ico, persists to disk cache, and reuses disk cache across instances', async () => {
    const cacheDir = makeTempDir();
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === 'https://openai.com/favicon.ico') {
        return new Response(VALID_PNG, {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }
      return new Response('not found', { status: 404 });
    });

    const network = {
      fetch: fetchMock,
      childEnv: () => ({}),
    } as unknown as NetworkClient;

    const service1 = new FaviconService({ cacheDir, network });
    const first = await service1.getFavicon('https://openai.com/research');
    expect(first).toMatch(/^data:image\/png;base64,/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const service2 = new FaviconService({ cacheDir, network });
    const second = await service2.getFavicon('openai.com');
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('blocks SSRF redirects to loopback/private hosts', async () => {
    const cacheDir = makeTempDir();
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === 'https://evil.example/favicon.ico') {
        return new Response(null, {
          status: 302,
          headers: { Location: 'http://127.0.0.1:8080/secret.png' },
        });
      }
      return new Response('<html></html>', {
        status: 404,
        headers: { 'Content-Type': 'text/html' },
      });
    });

    const service = new FaviconService({
      cacheDir,
      network: { fetch: fetchMock, childEnv: () => ({}) } as unknown as NetworkClient,
    });

    const result = await service.getFavicon('https://evil.example');
    expect(result).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('127.0.0.1'))).toBe(false);
  });

  it('falls back to HTML <link rel="icon"> and caches negative results', async () => {
    const cacheDir = makeTempDir();
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === 'https://docs.example.org/favicon.ico') {
        return new Response('<html>404</html>', { status: 404, headers: { 'Content-Type': 'text/html' } });
      }
      if (url === 'https://docs.example.org/') {
        return new Response(
          '<html><head><link rel="icon" href="/assets/brand.png"></head></html>',
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        );
      }
      if (url === 'https://docs.example.org/assets/brand.png') {
        return new Response(VALID_PNG, { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      return new Response('nope', { status: 404 });
    });

    const service = new FaviconService({
      cacheDir,
      network: { fetch: fetchMock, childEnv: () => ({}) } as unknown as NetworkClient,
    });

    const icon = await service.getFavicon('https://docs.example.org/guide');
    expect(icon).toMatch(/^data:image\/png;base64,/);

    const callsBeforeMiss = fetchMock.mock.calls.length;
    const miss1 = await service.getFavicon('https://missing.example.org/page');
    expect(miss1).toBeNull();
    const callsAfterFirstMiss = fetchMock.mock.calls.length;
    expect(callsAfterFirstMiss).toBeGreaterThan(callsBeforeMiss);

    const miss2 = await service.getFavicon('missing.example.org');
    expect(miss2).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirstMiss);
  });
});
