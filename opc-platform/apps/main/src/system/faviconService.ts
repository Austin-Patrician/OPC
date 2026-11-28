import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { defaultNetworkClient, type NetworkClient } from '../network/networkClient';
import { loadElectronNativeImage } from '../work/imageProcessor';

const DEFAULT_POSITIVE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_NEGATIVE_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_MAX_MEMORY_ENTRIES = 500;
const DEFAULT_MAX_CONCURRENT = 4;
const MAX_REDIRECT_HOPS = 3;
const MAX_ICON_BYTES = 256 * 1024;
const MAX_SVG_BYTES = 32 * 1024;
const MAX_HTML_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 4_500;

const RESERVED_SUFFIXES = [
  '.local',
  '.localhost',
  '.internal',
  '.lan',
  '.home',
  '.arpa',
] as const;

const MULTI_PART_PUBLIC_SUFFIXES = new Set([
  'com.cn',
  'org.cn',
  'net.cn',
  'gov.cn',
  'edu.cn',
  'co.uk',
  'org.uk',
  'co.jp',
  'ne.jp',
  'or.jp',
  'com.au',
  'net.au',
  'com.hk',
  'com.tw',
  'edu.tw',
  'co.kr',
]);

/**
 * Extracts and validates a safe public hostname for external favicon requests,
 * rejecting localhost, reserved local suffixes, IPv4/IPv6 literals, and non-HTTP URLs.
 */
export function normalizeFaviconHost(rawInput: string): string | null {
  const trimmed = rawInput.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  if (hasScheme && !/^https?:\/\//i.test(trimmed)) return null;

  let parsed: URL;
  try {
    parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  const host = parsed.hostname.replace(/\.+$/, '').toLowerCase();
  if (!host || host.length > 253) return null;
  if (host.includes(':') || !/^[a-z0-9.-]+$/.test(host)) return null;
  if (!host.includes('.') || host.startsWith('.') || host.includes('..')) return null;
  if (host === 'localhost' || RESERVED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return null;
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null;

  const labels = host.split('.');
  const tld = labels[labels.length - 1] ?? '';
  if (!/[a-z]/.test(tld)) return null;

  return host;
}

/** Returns the parent registrable domain when safe, or `null` if already at apex level. */
export function parentDomainOf(host: string): string | null {
  const labels = host.toLowerCase().split('.').filter(Boolean);
  if (labels.length < 3) return null;
  const tailTwo = `${labels[labels.length - 2]}.${labels[labels.length - 1]}`;
  const minApexLabels = MULTI_PART_PUBLIC_SUFFIXES.has(tailTwo) ? 3 : 2;
  if (labels.length <= minApexLabels) return null;
  return labels.slice(1).join('.');
}

function parseLinkAttributes(rawAttrs: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(rawAttrs)) !== null) {
    const key = match[1]?.toLowerCase();
    const val = match[2] ?? match[3] ?? match[4] ?? '';
    if (key) attrs[key] = val.trim();
  }
  return attrs;
}

function decodeHtmlEntitiesMinimal(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&#x26;/gi, '&');
}

function candidatePriority(relTokens: readonly string[], href: string): number {
  const isSvg = /\.svg(?:[?#]|$)/i.test(href);
  if (relTokens.includes('icon')) {
    return isSvg ? 1 : 0;
  }
  if (relTokens.includes('apple-touch-icon') || relTokens.includes('apple-touch-icon-precomposed')) {
    return 2;
  }
  return 3;
}

/**
 * Extracts and orders icon URLs from HTML `<link>` tags, filtering out non-HTTP and unsafe hosts.
 */
export function extractHtmlIconCandidates(html: string, pageUrl: string): string[] {
  const found: Array<{ url: string; priority: number; index: number }> = [];
  const seen = new Set<string>();
  const linkRe = /<link\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = linkRe.exec(html)) !== null) {
    const attrs = parseLinkAttributes(match[1] ?? '');
    const relRaw = attrs.rel?.toLowerCase();
    const hrefRaw = attrs.href ? decodeHtmlEntitiesMinimal(attrs.href) : '';
    if (!relRaw || !hrefRaw) continue;

    const relTokens = relRaw.split(/\s+/).filter(Boolean);
    const hasIconRel = relTokens.some(
      (token) =>
        token === 'icon' ||
        token === 'apple-touch-icon' ||
        token === 'apple-touch-icon-precomposed' ||
        token === 'mask-icon',
    );
    if (!hasIconRel) continue;

    let resolved: URL;
    try {
      resolved = new URL(hrefRaw, pageUrl);
    } catch {
      continue;
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
    if (!normalizeFaviconHost(resolved.href)) continue;

    const normalizedHref = resolved.href;
    if (seen.has(normalizedHref)) continue;
    seen.add(normalizedHref);

    found.push({
      url: normalizedHref,
      priority: candidatePriority(relTokens, normalizedHref),
      index: idx++,
    });
  }

  found.sort((a, b) => a.priority - b.priority || a.index - b.index);
  return found.map((entry) => entry.url);
}

/**
 * Validates downloaded bytes against real image signatures (PNG/JPEG/GIF/WebP/ICO/safe SVG)
 * to avoid mistaking HTML error pages or malicious SVGs for valid favicons.
 */
export function detectFaviconImageMime(
  bytes: Uint8Array,
  contentType?: string,
): string | null {
  if (bytes.length === 0) return null;

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif';
  }

  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  if (
    bytes.length >= 4 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x00 &&
    (bytes[2] === 0x01 || bytes[2] === 0x02) &&
    bytes[3] === 0x00
  ) {
    return 'image/x-icon';
  }

  if (bytes.length <= MAX_SVG_BYTES) {
    const text = Buffer.from(bytes).toString('utf8').trim();
    if (!text || /^<!doctype\s+html|^<html\b/i.test(text)) {
      return null;
    }
    const mimeHint = contentType?.toLowerCase().includes('svg') ?? false;
    const looksSvg = mimeHint || /^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg\b/i.test(text);
    if (looksSvg && /<svg[\s>]/i.test(text)) {
      if (/<script\b|<foreignObject\b|javascript:|on[a-z]+\s*=/i.test(text)) {
        return null;
      }
      return 'image/svg+xml';
    }
  }

  return null;
}

export type FaviconImageNormalizer = (
  bytes: Uint8Array,
  mime: string,
) => string | null | Promise<string | null>;

export interface FaviconServiceOptions {
  cacheDir: string;
  network?: NetworkClient;
  imageNormalizer?: FaviconImageNormalizer;
  now?: () => number;
  positiveTtlMs?: number;
  negativeTtlMs?: number;
  maxConcurrent?: number;
}

interface DiskCacheEntry {
  host: string;
  dataUrl: string | null;
  cachedAt: number;
}

async function defaultNormalizeImage(bytes: Uint8Array, mime: string): Promise<string | null> {
  if (mime !== 'image/svg+xml') {
    const nativeImage = await loadElectronNativeImage();
    if (nativeImage) {
      try {
        const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const handle = nativeImage.createFromBuffer(buf);
        if (!handle.isEmpty()) {
          const { width, height } = handle.getSize();
          if (width > 64 || height > 64) {
            const resized = handle.resize({ width: 32, height: 32, quality: 'good' });
            const png = resized.toPNG();
            if (png.length > 0) {
              return `data:image/png;base64,${png.toString('base64')}`;
            }
          }
          const png = handle.toPNG();
          if (png.length > 0) {
            return `data:image/png;base64,${png.toString('base64')}`;
          }
        }
      } catch {
        // Fall through to raw data URL when Electron fails to decode (e.g. multi-frame ICO).
      }
    }
  }
  const base64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  return `data:${mime};base64,${base64}`;
}

async function readLimitedResponseBytes(
  response: Response,
  maxBytes: number,
  truncateOnLimit: boolean,
): Promise<Uint8Array | null> {
  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      return truncateOnLimit ? buf.slice(0, maxBytes) : null;
    }
    return buf;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      if (total + value.byteLength > maxBytes) {
        if (truncateOnLimit) {
          const remaining = maxBytes - total;
          if (remaining > 0) {
            chunks.push(value.slice(0, remaining));
            total += remaining;
          }
          await reader.cancel().catch(() => undefined);
          break;
        }
        await reader.cancel().catch(() => undefined);
        return null;
      }

      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    return null;
  }

  return Buffer.concat(chunks, total);
}

/**
 * Proxy-aware main-process website favicon fetcher with disk/memory TTL cache,
 * single-flight deduplication, bounded concurrency, and SSRF protections.
 */
export class FaviconService {
  private readonly cacheDir: string;
  private readonly network: NetworkClient;
  private readonly imageNormalizer: FaviconImageNormalizer;
  private readonly now: () => number;
  private readonly positiveTtlMs: number;
  private readonly negativeTtlMs: number;
  private readonly maxConcurrent: number;

  private readonly memory = new Map<string, { dataUrl: string | null; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private activeCount = 0;
  private readonly waitQueue: Array<() => void> = [];

  constructor(options: FaviconServiceOptions) {
    this.cacheDir = options.cacheDir;
    this.network = options.network ?? defaultNetworkClient;
    this.imageNormalizer = options.imageNormalizer ?? defaultNormalizeImage;
    this.now = options.now ?? Date.now;
    this.positiveTtlMs = options.positiveTtlMs ?? DEFAULT_POSITIVE_TTL_MS;
    this.negativeTtlMs = options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
  }

  async getFavicon(rawUrlOrDomain: string): Promise<string | null> {
    const host = normalizeFaviconHost(rawUrlOrDomain);
    if (!host) return null;

    const nowMs = this.now();
    const mem = this.readMemory(host, nowMs);
    if (mem !== undefined) return mem;

    const disk = this.readDisk(host, nowMs);
    if (disk !== undefined) {
      this.writeMemory(host, disk.dataUrl, disk.expiresAt);
      return disk.dataUrl;
    }

    const pending = this.inFlight.get(host);
    if (pending) return pending;

    const job = this.withConcurrency(() => this.resolveAndPersist(host))
      .finally(() => {
        this.inFlight.delete(host);
      });

    this.inFlight.set(host, job);
    return job;
  }

  private async resolveAndPersist(host: string): Promise<string | null> {
    const dataUrl = await this.resolveFromNetwork(host).catch(() => null);
    const cachedAt = this.now();
    const ttl = dataUrl !== null ? this.positiveTtlMs : this.negativeTtlMs;
    this.writeMemory(host, dataUrl, cachedAt + ttl);
    this.writeDisk({ host, dataUrl, cachedAt });
    return dataUrl;
  }

  private async resolveFromNetwork(host: string): Promise<string | null> {
    const directHit = await this.tryFetchIcon(`https://${host}/favicon.ico`);
    if (directHit) return directHit;

    const htmlFetch = await this.fetchWithSafeRedirects(
      `https://${host}/`,
      'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
      MAX_HTML_BYTES,
      true,
    );
    if (htmlFetch) {
      const contentType = htmlFetch.response.headers.get('content-type') ?? '';
      if (!contentType || /html|xhtml|xml/i.test(contentType)) {
        const html = Buffer.from(htmlFetch.bytes).toString('utf8');
        const candidates = extractHtmlIconCandidates(html, htmlFetch.finalUrl).slice(0, 3);
        for (const candidateUrl of candidates) {
          const hit = await this.tryFetchIcon(candidateUrl);
          if (hit) return hit;
        }
      }
    }

    const labels = host.split('.');
    if (labels.length === 2 && !host.startsWith('www.')) {
      const wwwHit = await this.tryFetchIcon(`https://www.${host}/favicon.ico`);
      if (wwwHit) return wwwHit;
    }

    const parent = parentDomainOf(host);
    if (parent) {
      const parentHit = await this.tryFetchIcon(`https://${parent}/favicon.ico`);
      if (parentHit) return parentHit;
    }

    return null;
  }

  private async tryFetchIcon(iconUrl: string): Promise<string | null> {
    const fetched = await this.fetchWithSafeRedirects(
      iconUrl,
      'image/png,image/x-icon,image/svg+xml,image/webp,image/*;q=0.8,*/*;q=0.5',
      MAX_ICON_BYTES,
      false,
    );
    if (!fetched) return null;

    const mime = detectFaviconImageMime(
      fetched.bytes,
      fetched.response.headers.get('content-type') ?? undefined,
    );
    if (!mime) return null;

    return this.imageNormalizer(fetched.bytes, mime);
  }

  private async fetchWithSafeRedirects(
    initialUrl: string,
    accept: string,
    maxBytes: number,
    truncateOnLimit: boolean,
  ): Promise<{ response: Response; finalUrl: string; bytes: Uint8Array } | null> {
    let currentUrl = initialUrl;

    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
      if (!normalizeFaviconHost(currentUrl)) return null;

      let response: Response;
      try {
        response = await this.network.fetch(
          currentUrl,
          {
            method: 'GET',
            headers: { Accept: accept },
            redirect: 'manual',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
          },
          { purpose: 'other', timeoutMs: REQUEST_TIMEOUT_MS },
        );
      } catch {
        return null;
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) return null;
        let next: URL;
        try {
          next = new URL(location, currentUrl);
        } catch {
          return null;
        }
        if ((next.protocol !== 'http:' && next.protocol !== 'https:') || !normalizeFaviconHost(next.href)) {
          return null;
        }
        currentUrl = next.href;
        continue;
      }

      if (!response.ok) return null;
      const bytes = await readLimitedResponseBytes(response, maxBytes, truncateOnLimit);
      if (!bytes) return null;
      return { response, finalUrl: currentUrl, bytes };
    }

    return null;
  }

  private async withConcurrency<T>(work: () => Promise<T>): Promise<T> {
    if (this.activeCount >= this.maxConcurrent) {
      await new Promise<void>((resolve) => {
        this.waitQueue.push(resolve);
      });
    }
    this.activeCount += 1;
    try {
      return await work();
    } finally {
      this.activeCount -= 1;
      const next = this.waitQueue.shift();
      if (next) next();
    }
  }

  private readMemory(host: string, nowMs: number): string | null | undefined {
    const entry = this.memory.get(host);
    if (!entry) return undefined;
    if (entry.expiresAt <= nowMs) {
      this.memory.delete(host);
      return undefined;
    }
    // Refresh insertion order for basic LRU behavior.
    this.memory.delete(host);
    this.memory.set(host, entry);
    return entry.dataUrl;
  }

  private writeMemory(host: string, dataUrl: string | null, expiresAt: number): void {
    if (this.memory.has(host)) {
      this.memory.delete(host);
    } else if (this.memory.size >= DEFAULT_MAX_MEMORY_ENTRIES) {
      const oldest = this.memory.keys().next().value;
      if (oldest) this.memory.delete(oldest);
    }
    this.memory.set(host, { dataUrl, expiresAt });
  }

  private diskFilePath(host: string): string {
    const digest = crypto.createHash('sha256').update(host).digest('hex').slice(0, 24);
    return path.join(this.cacheDir, `${digest}.json`);
  }

  private readDisk(
    host: string,
    nowMs: number,
  ): { dataUrl: string | null; expiresAt: number } | undefined {
    const file = this.diskFilePath(host);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<DiskCacheEntry>;
      if (parsed.host !== host || typeof parsed.cachedAt !== 'number') return undefined;
      if (parsed.dataUrl !== null && (typeof parsed.dataUrl !== 'string' || !parsed.dataUrl.startsWith('data:image/'))) {
        return undefined;
      }
      const ttl = parsed.dataUrl !== null ? this.positiveTtlMs : this.negativeTtlMs;
      const expiresAt = parsed.cachedAt + ttl;
      if (expiresAt <= nowMs) return undefined;
      return { dataUrl: parsed.dataUrl, expiresAt };
    } catch {
      return undefined;
    }
  }

  private writeDisk(entry: DiskCacheEntry): void {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      fs.writeFileSync(this.diskFilePath(entry.host), JSON.stringify(entry), 'utf8');
    } catch {
      // Non-fatal if cache directory is read-only or unavailable.
    }
  }
}
