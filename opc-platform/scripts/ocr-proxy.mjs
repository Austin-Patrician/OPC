/**
 * Which route an *offline-ish build script* should take to the network.
 *
 * Why this file exists at all: the app's proxy settings live in the app
 * (`network/proxyRuntime.ts`), and they reach exactly three places — Chromium's
 * session, the main-process `fetch` wrapper, and the environment of children the
 * app spawns. `scripts/fetch-ocr-assets.mjs` is none of those: pnpm starts it as
 * a plain Node process during `postinstall` / `prebuild`, long before a window
 * exists. So on a machine that reaches the internet only through a proxy, the
 * model download fails while the app itself works fine — which looks like "the
 * proxy is broken" but is really "this process was never told about it".
 *
 * Two independent gaps have to be closed, and they are closed in two places:
 *
 * 1. **No route.** A bare `pnpm install` has no `HTTPS_PROXY`; the proxy is a
 *    Windows/macOS system setting. `resolveProxyRoute()` reads that setting.
 * 2. **No listener.** Node's built-in `fetch` ignores proxy variables unless
 *    started with `--use-env-proxy`. That flag cannot be applied to a running
 *    process, so `fetch-ocr-assets.mjs` re-execs itself once with it.
 *
 * Everything here is pure string work so it can be tested without a network,
 * a proxy, or either operating system.
 */

/** Same vocabulary as `apps/main/src/network/proxyConfig.ts` writes for children. */
export const PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
];

/** `OPC_OCR_PROXY=direct` — "I know there is a proxy; do not use it." */
export const PROXY_OVERRIDE = 'OPC_OCR_PROXY';

/** Set on the re-exec'd child so it does not re-exec again. */
export const REEXEC_MARKER = 'OPC_OCR_PROXY_REEXEC';

/**
 * A route, plus where it came from.
 *
 * @typedef {{ url: string, source: 'env' | 'system', noProxy?: string }} ProxyRoute
 */

/** The first proxy variable that is actually set, or `null`. */
export function envProxy(env = process.env) {
  for (const key of PROXY_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return null;
}

/**
 * `host:port` → `scheme://host:port`. A bare host gets the scheme's default port,
 * because a proxy string without a port is legal in the Windows dialog.
 */
export function proxyUrl(authority, scheme = 'http') {
  const trimmed = (authority ?? '').trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `${scheme}://${trimmed}`;
  // An authority without a port: fill in the scheme default instead of leaving
  // `http://host` — undici accepts it, some proxies reject the implicit :80.
  const match = /^([a-z][a-z0-9+.-]*:\/\/)(\[[^\]]+\]|[^:/]+)$/i.exec(withScheme);
  if (!match) return withScheme;
  const port = scheme === 'https' ? 443 : scheme === 'socks5' ? 1080 : 80;
  return `${match[1]}${match[2]}:${port}`;
}

/**
 * Windows stores one string for all protocols. Two shapes exist:
 *
 *   `127.0.0.1:7897`
 *   `http=127.0.0.1:7897;https=127.0.0.1:7897;socks=127.0.0.1:7897`
 *
 * A plain `host:port` means "use it for everything", which is the common case
 * (Clash, Charles, Fiddler). The per-protocol form is what the IE dialog writes.
 */
export function parseWindowsProxyServer(raw) {
  const text = (raw ?? '').trim();
  if (!text) return null;

  const perScheme = new Map();
  const bare = !text.includes('=');
  if (!bare) {
    for (const part of text.split(';')) {
      const at = part.indexOf('=');
      if (at <= 0) continue;
      const scheme = part.slice(0, at).trim().toLowerCase();
      const authority = part.slice(at + 1).trim();
      if (scheme && authority) perScheme.set(scheme, authority);
    }
  }

  const socks = perScheme.get('socks') ?? perScheme.get('socks5');
  // A SOCKS proxy is *not* an HTTP proxy: keeping the scheme honest means the
  // caller can say "I cannot use this one" instead of tunnelling wrong.
  const socksUrl = socks ? proxyUrl(socks, 'socks5') : null;

  // `host:port` alone: the proxy is one plain-HTTP hop for every target scheme.
  // Reading it as an HTTPS proxy (i.e. TLS *to the proxy*) is the mistake that
  // makes every request fail with "socket disconnected before secure TLS
  // connection was established" — the scheme of the target has nothing to do
  // with how the proxy is spoken to.
  if (bare) {
    const url = proxyUrl(text, 'http');
    return url ? { http: url, https: url } : null;
  }

  const http = proxyUrl(perScheme.get('http'), 'http') ?? socksUrl;
  const https = proxyUrl(perScheme.get('https'), 'https') ?? socksUrl ?? http;
  if (!http && !https) return null;
  return { http, https };
}

/**
 * `ProxyOverride` → `NO_PROXY`.
 *
 * `<local>` has no `NO_PROXY` equivalent (it means "single-label hostnames"),
 * so it is dropped rather than mistranslated into something that matches more
 * than intended. `127.*` style wildcards are kept as-is: undici understands them.
 */
export function parseWindowsOverride(raw) {
  const entries = (raw ?? '')
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry && entry !== '<local>' && entry !== '<-loopback>');
  return entries.length > 0 ? entries.join(',') : undefined;
}

/**
 * `scutil --proxy` output → route.
 *
 *   HTTPEnable : 1
 *   HTTPProxy : 127.0.0.1
 *   HTTPPort : 7890
 *   HTTPSEnable : 1 …
 *
 * HTTPS wins when both are enabled (that is the one a model download needs).
 */
export function parseScutilProxy(text) {
  const values = new Map();
  for (const line of (text ?? '').split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    values.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }

  // `HTTPSProxy` is the proxy used *for* https URLs — an HTTP proxy, not a TLS
  // one. Only `SOCKSProxy` changes what the socket is.
  const pick = (scheme, kind = 'http') => {
    if (values.get(`${scheme}Enable`) !== '1') return null;
    const host = values.get(`${scheme}Proxy`);
    if (!host) return null;
    const port = values.get(`${scheme}Port`);
    return proxyUrl(port ? `${host}:${port}` : host, kind);
  };

  const https = pick('HTTPS');
  const http = pick('HTTP');
  const socks = pick('SOCKS', 'socks5');
  if (!https && !http && !socks) return null;
  return { http: http ?? https ?? socks, https: https ?? http ?? socks };
}

/** `http://user:pass@host:7897` → `host:7897`. Credentials never reach a log. */
export function describeRoute(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || '默认端口'}`;
  } catch {
    return '（无法解析的代理地址）';
  }
}

/**
 * What the download process should do, decided without touching the network.
 *
 * Order matters: an explicit environment variable beats the OS setting, because
 * that is how someone overrides a proxy for one command.
 */
export function decideRoute(input) {
  const { env = process.env, system } = input;

  const override = (env[PROXY_OVERRIDE] ?? '').trim().toLowerCase();
  if (override === 'direct' || override === 'off' || override === '0') {
    return { route: null, reason: 'OPC_OCR_PROXY=direct' };
  }

  const fromEnv = envProxy(env);
  if (fromEnv) {
    const noProxy = (env.NO_PROXY ?? env.no_proxy ?? '').trim();
    return {
      route: { url: fromEnv, source: 'env', ...(noProxy ? { noProxy } : {}) },
      reason: '环境变量',
    };
  }

  if (system) {
    return {
      route: {
        url: system.https ?? system.http,
        source: 'system',
        ...(system.noProxy ? { noProxy: system.noProxy } : {}),
      },
      reason: '跟随系统代理',
    };
  }

  return { route: null, reason: '没找到代理，直接连接' };
}

/** The environment to hand the re-exec'd child. */
export function proxyEnvironment(route) {
  const env = {
    HTTPS_PROXY: route.url,
    https_proxy: route.url,
  };
  // `HTTP_PROXY` is left alone when only HTTPS is configured: an HTTP proxy that
  // speaks TLS is not the same thing, and guessing would tunnel plain HTTP wrong.
  if (route.url.startsWith('http://')) {
    env.HTTP_PROXY = route.url;
    env.http_proxy = route.url;
  }
  if (route.noProxy) {
    env.NO_PROXY = route.noProxy;
    env.no_proxy = route.noProxy;
  }
  return env;
}
