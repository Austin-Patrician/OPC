import type { ProxyConfig, ProxyConfigInput, ProxyMode, ProxyProtocol } from '@opc/shared/domain';

/**
 * Pure proxy maths: what Chromium should be told, what the environment should say
 * and what a pasted server string means. Nothing here touches Electron, so the
 * rules are unit-testable without launching a window.
 *
 * The stored config is the boss's intent; the three shapes below are the three
 * places that intent has to be expressed:
 *
 * | consumer            | shape                                   |
 * | ------------------- | --------------------------------------- |
 * | Chromium / renderer | `session.setProxy({ proxyRules })`      |
 * | main-process fetch  | the same session (via `net.fetch`)      |
 * | child processes     | `HTTP_PROXY` / `NO_PROXY` env vars       |
 */

export const PROXY_MODES: readonly ProxyMode[] = ['system', 'direct', 'manual'];
export const PROXY_PROTOCOLS: readonly ProxyProtocol[] = ['http', 'https', 'socks5'];

/**
 * Loopback is never proxied. The app talks to its own mock servers and the
 * workspace preview on 127.0.0.1, and those requests must keep working even when
 * the proxy is a remote box that cannot reach this machine.
 */
export const LOOPBACK_BYPASS: readonly string[] = ['localhost', '127.0.0.1', '::1'];

export const MAX_HOST_CHARS = 255;
export const MAX_BYPASS_CHARS = 1024;
export const MAX_USERNAME_CHARS = 128;
export const MAX_PASSWORD_CHARS = 512;

/** Every key we ever write, so switching modes can put the environment back. */
export const PROXY_ENV_KEYS: readonly string[] = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
];

export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  mode: 'system',
  protocol: 'http',
  host: '',
  port: 7890,
  username: '',
  hasPassword: false,
  bypass: '',
};

/** A config with the decrypted secret attached; only the main process sees this. */
export type ResolvedProxy = ProxyConfig & { password: string };

const isMode = (value: unknown): value is ProxyMode =>
  typeof value === 'string' && (PROXY_MODES as readonly string[]).includes(value);

const isProtocol = (value: unknown): value is ProxyProtocol =>
  typeof value === 'string' && (PROXY_PROTOCOLS as readonly string[]).includes(value);

/** Trimmed, length-capped, control characters flattened to spaces. */
function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]/g, ' ').trim().slice(0, max);
}

/**
 * Accepts what people actually paste: `http://127.0.0.1:7890`, `user:pass@host`
 * or a bare host. Ports are separate fields, so a trailing `:port` is dropped with
 * them in mind — the port input is the single source of truth.
 */
export function normalizeProxyHost(value: unknown): string {
  let host = text(value, MAX_HOST_CHARS).replace(/\s+/g, '');
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const slash = host.indexOf('/');
  if (slash >= 0) host = host.slice(0, slash);
  const at = host.lastIndexOf('@');
  if (at >= 0) host = host.slice(at + 1);

  // Bracketed IPv6, optionally followed by a port: keep the literal as typed.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(host);
  if (bracketed) return `[${bracketed[1]}]`;

  // `host:port` pasted as one token: the host stays, the port field owns the rest.
  // Only a single colon can be a port separator — `::1` is an un-bracketed IPv6.
  if ((host.match(/:/g) ?? []).length === 1) host = host.replace(/:\d+$/, '');
  return host;
}

export function normalizeProxyPort(value: unknown): number {
  const port = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(port) && port >= 1 && port <= 65_535 ? Math.trunc(port) : 0;
}

/** `a.com, *.b.com` — deduped, comma-joined, without the implicit loopback. */
export function normalizeBypass(value: unknown): string {
  const raw = text(value, MAX_BYPASS_CHARS);
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const entry of raw.split(/[\s,;]+/)) {
    const cleaned = entry.trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    entries.push(cleaned);
  }
  return entries.join(',');
}

/**
 * Validates and normalises a renderer payload.
 *
 * Throws (with a message the settings page can show verbatim) only when the mode
 * needs a server and the server is unusable: a half-typed form must not be
 * persistable, because it would break every outgoing request at the next launch.
 */
export function normalizeProxyInput(raw: unknown): ProxyConfigInput {
  const input = (raw ?? {}) as Record<string, unknown>;
  const mode = isMode(input.mode) ? input.mode : 'system';
  const protocol = isProtocol(input.protocol) ? input.protocol : 'http';
  const host = normalizeProxyHost(input.host);
  const port = normalizeProxyPort(input.port);
  const username = text(input.username, MAX_USERNAME_CHARS);
  const bypass = normalizeBypass(input.bypass);

  // `undefined` = keep the stored secret; `''` = clear it. Anything else replaces it.
  const password =
    input.password === undefined ? undefined : text(input.password, MAX_PASSWORD_CHARS);

  if (mode === 'manual') {
    if (!host) throw new Error('请填写代理服务器地址');
    if (port === 0) throw new Error('代理端口需在 1–65535 之间');
  }

  return { mode, protocol, host, port: port || DEFAULT_PROXY_CONFIG.port, username, password, bypass };
}

/** Brackets IPv6 literals so `::1:7890` is not read as a port. */
export function formatAuthority(host: string, port: number): string {
  const bare = host.replace(/^\[|\]$/g, '');
  const wrapped = bare.includes(':') ? `[${bare}]` : bare;
  return `${wrapped}:${port}`;
}

/**
 * Chromium's command-line proxy rule syntax.
 *
 * A bare `host:port` means "this HTTP proxy for every scheme"; `socks5://` and
 * `https://` select a SOCKS5 or TLS-speaking proxy. Explicit `http=` / `https=`
 * prefixes are deliberately avoided: they choose the proxy *by target scheme*,
 * which would silently send HTTPS traffic direct.
 */
export function proxyRules(config: Pick<ProxyConfig, 'protocol' | 'host' | 'port'>): string {
  const authority = formatAuthority(config.host, config.port);
  if (config.protocol === 'socks5') return `socks5://${authority}`;
  if (config.protocol === 'https') return `https://${authority}`;
  return authority;
}

/**
 * Chromium's bypass list. `<local>` covers intranet hostnames; the loopback
 * entries are added explicitly because browsers exempt them inconsistently once
 * a fixed proxy is set.
 */
export function proxyBypassRules(bypass: string): string {
  const entries: string[] = [];
  for (const entry of [...LOOPBACK_BYPASS, ...normalizeBypass(bypass).split(',')]) {
    if (!entry || entries.includes(entry)) continue;
    entries.push(entry);
  }
  return entries.join(',');
}

/** The proxy URL children and curl-style tools expect, without credentials. */
export function proxyUrl(config: Pick<ProxyConfig, 'protocol' | 'host' | 'port'>): string {
  const scheme = config.protocol === 'socks5' ? 'socks5' : config.protocol;
  return `${scheme}://${formatAuthority(config.host, config.port)}`;
}

/**
 * Environment variables for spawned processes (`git`, `npm`, workspace scripts).
 *
 * `null` means "remove the key": a SOCKS5 proxy cannot be expressed as
 * `HTTP_PROXY`, and leaving an inherited HTTP proxy in place would route children
 * somewhere the boss did not choose.
 */
export function proxyEnvironment(config: ResolvedProxy): Record<string, string | null> {
  const url = proxyUrl(config);
  const withAuth = config.username
    ? url.replace('://', `://${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@`)
    : url;
  const noProxy = proxyBypassRules(config.bypass);

  if (config.protocol === 'socks5') {
    return {
      HTTP_PROXY: null,
      HTTPS_PROXY: null,
      http_proxy: null,
      https_proxy: null,
      ALL_PROXY: withAuth,
      all_proxy: withAuth,
      NO_PROXY: noProxy,
      no_proxy: noProxy,
    };
  }

  return {
    HTTP_PROXY: withAuth,
    HTTPS_PROXY: withAuth,
    ALL_PROXY: withAuth,
    NO_PROXY: noProxy,
    http_proxy: withAuth,
    https_proxy: withAuth,
    all_proxy: withAuth,
    no_proxy: noProxy,
  };
}

/** Every proxy variable removed: what "direct" means for a child process. */
export function clearProxyEnvironment(): Record<string, string | null> {
  return Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, null]));
}

/** A proxy directive as Chromium's `session.resolveProxy()` reports it. */
export interface SystemProxy {
  protocol: 'http' | 'https' | 'socks5';
  host: string;
  port: number;
}

function splitAuthority(authority: string): { host: string; port: number } | null {
  const trimmed = authority.trim();
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(trimmed);
  if (bracketed) {
    const port = normalizeProxyPort(bracketed[2] ?? '');
    return port ? { host: `[${bracketed[1]}]`, port } : null;
  }

  const colon = trimmed.lastIndexOf(':');
  if (colon <= 0) return null;
  const host = trimmed.slice(0, colon).trim();
  const port = normalizeProxyPort(trimmed.slice(colon + 1));
  return host && port ? { host, port } : null;
}

/**
 * Parses `PROXY host:port; DIRECT` (Chromium's PAC result) into the first usable
 * hop. A system PAC can return several entries; environment variables can only
 * express one, so the first proxy is the honest choice.
 */
export function parseSystemProxy(result: string | null | undefined): SystemProxy | null {
  const directive = (result ?? '')
    .split(/[;\n]/)
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!directive || /^DIRECT$/i.test(directive)) return null;

  const match = /^(PROXY|HTTPS|SOCKS5?|SOCKS4)\s+(.+)$/i.exec(directive);
  if (!match) return null;
  const authority = splitAuthority(match[2] ?? '');
  if (!authority) return null;

  const kind = (match[1] ?? '').toUpperCase();
  const protocol = kind === 'HTTPS' ? 'https' : kind.startsWith('SOCKS') ? 'socks5' : 'http';
  return { protocol, host: authority.host, port: authority.port };
}

function systemProxyOf(system: SystemProxy): ResolvedProxy {
  return {
    ...DEFAULT_PROXY_CONFIG,
    protocol: system.protocol,
    host: system.host,
    port: system.port,
    username: '',
    password: '',
    hasPassword: false,
    bypass: '',
  };
}

/**
 * The proxy variables a spawned process should see.
 *
 * `null` means "leave the inherited environment alone": used only when the
 * system proxy could not be resolved, where guessing would be worse than the
 * user's original environment. `direct` intentionally clears every variable,
 * including one the app inherited at launch.
 */
export function proxyChildEnvironment(
  config: ResolvedProxy,
  systemProxyResult?: string,
): Record<string, string | null> | null {
  if (config.mode === 'manual') return proxyEnvironment(config);
  if (config.mode === 'direct') return clearProxyEnvironment();
  if (systemProxyResult === undefined) return null;

  const system = parseSystemProxy(systemProxyResult);
  return system ? proxyEnvironment(systemProxyOf(system)) : clearProxyEnvironment();
}

/** One-line summary for logs and the settings header. Never includes the secret. */
export function describeProxy(config: Pick<ProxyConfig, 'mode' | 'protocol' | 'host' | 'port'>): string {
  if (config.mode === 'system') return '跟随系统';
  if (config.mode === 'direct') return '直连（不使用代理）';
  return `手动 · ${proxyUrl(config)}`;
}
