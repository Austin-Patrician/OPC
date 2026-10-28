import type { ProxyTestResult } from '@opc/shared/domain';
import { app, net, session, type Session } from 'electron';
import { connect } from 'node:net';
import {
  describeProxy,
  PROXY_ENV_KEYS,
  proxyBypassRules,
  proxyChildEnvironment,
  proxyRules,
  type ResolvedProxy,
} from './proxyConfig';
import { createNetworkClient, type NetworkClient, type NetworkFetch } from './networkClient';

/**
 * Applies the boss's proxy to every outgoing request the app can make.
 *
 * There are exactly three exits from this process, and each needs its own switch:
 *
 * 1. **Chromium** (renderer, `<img>`, `net.request`) — `session.setProxy`. This is
 *    also the path `net.fetch` uses, which is why the main process can borrow it.
 * 2. **main-process `fetch`** — pi-ai and the model/image code call `fetch`.
 *    Business code uses `networkClient` (the explicit seam); the global wrapper
 *    below remains as a compatibility net for SDKs that capture `globalThis.fetch`
 *    themselves (pi-durable's harness, OAuth flows).
 * 3. **child processes** (`git`, `npm`, workspace scripts) — `networkClient.childEnv()`
 *    gives each spawn the right variables. The process environment is also updated
 *    for callers outside `runCommand`, but `direct` now genuinely clears it.
 *
 * Proxy credentials are supplied through `app.on('login')`: Chromium asks, we
 * answer from the saved config. The password never enters a URL that could leak
 * into a log.
 */

/** The config currently in force; `null` only before the first successful apply. */
let active: ResolvedProxy | null = null;
/** Set while the settings page probes an unsaved draft, so auth uses those credentials. */
let authOverride: { username: string; password: string } | null = null;
let installed = false;
let probeSession: Session | null = null;

/** Original values of the proxy env keys, captured before the first write. */
const originalEnv = new Map<string, string | undefined>();
/** The overlays currently in force for child processes. */
let childOverrides: Record<string, string | null> | null = null;

const DIAL_TIMEOUT_MS = 6_000;
const EGRESS_TIMEOUT_MS = 10_000;
/** Two independent IP echo services: one blocked region should not fail the probe. */
const EGRESS_ENDPOINTS = ['https://api.ipify.org?format=json', 'https://ifconfig.me/ip'] as const;
/** `resolveProxy` only answers "which route", it does not make a request. */
const SYSTEM_PROXY_PROBE_URL = 'https://example.com/';

/**
 * The proxy-aware transport. `direct` stays on Node's stack: it must not even
 * consult the OS proxy. `system` goes through Chromium as well, otherwise the
 * main process would ignore the OS proxy the renderer is already following.
 */
let nodeFetch: NetworkFetch = (input, init) => globalThis.fetch(input, init);

export const networkFetch: NetworkFetch = (input, init) => {
  if (!active || active.mode === 'direct') return nodeFetch(input, init);
  return net.fetch(input as never, init as never) as unknown as Promise<Response>;
};

/** Explicit network seam for services; see `networkClient.ts`. */
export const networkClient: NetworkClient = createNetworkClient({
  fetch: networkFetch,
  childEnv: proxyChildEnv,
});

/**
 * Installs the two process-wide hooks. Called once from `bootstrap`, before the
 * first window exists so no request can slip out unproxied.
 */
export function connectProxyRuntime(): void {
  if (installed) return;
  installed = true;

  nodeFetch = globalThis.fetch;
  globalThis.fetch = networkFetch;

  app.on('login', (event, _webContents, _details, authInfo, callback) => {
    // Only proxy challenges: a site's basic auth prompt must not receive these.
    if (!authInfo.isProxy) return;
    const credentials =
      authOverride ??
      (active?.mode === 'manual' && active.username
        ? { username: active.username, password: active.password }
        : null);
    if (!credentials) return;
    event.preventDefault();
    callback(credentials.username, credentials.password);
  });
}

/**
 * Applies a config to the live process. `session.setProxy` only affects *new*
 * connections, so pooled sockets are closed right after: without that, an open
 * HTTPS connection keeps talking to the old route for minutes.
 *
 * `active` and the environment move only after Chromium accepted the config, so
 * a failed apply cannot leave fetch/env pointing at a route Chromium never took.
 */
export async function applyProxy(config: ResolvedProxy): Promise<void> {
  const ses = session.defaultSession;
  // Apply first: `resolveProxy` answers from the session's *current* settings, so
  // resolving before switching would report the previously configured proxy when
  // the user just chose "system".
  await applyToSession(ses, config);
  const systemProxyResult =
    config.mode === 'system' ? await resolveSystemProxy() : undefined;
  const overrides = proxyChildEnvironment(config, systemProxyResult);
  await ses.closeAllConnections().catch(() => undefined);

  active = config;
  childOverrides = overrides;
  // Capture before computing the fallback: if the system proxy could not be
  // resolved we restore the launch values, not "delete everything".
  captureOriginalEnv(process.env);
  applyEnvOverrides(process.env, overrides ?? originalOverrides());

  console.warn(`[OPC] 网络代理：${describeProxy(config)}`);
}

/** The environment a spawned process should inherit, proxy variables included. */
export function proxyChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  if (childOverrides) overlayEnv(env, childOverrides);
  return env;
}

/** Shared by the default session and the throwaway probe session. */
async function applyToSession(ses: Session, config: ResolvedProxy): Promise<void> {
  if (config.mode === 'manual') {
    await ses.setProxy({
      mode: 'fixed_servers',
      proxyRules: proxyRules(config),
      proxyBypassRules: proxyBypassRules(config.bypass),
    });
    return;
  }
  await ses.setProxy({ mode: config.mode });
}

/**
 * Chromium is the authority for the system proxy. Child processes cannot read the
 * OS setting, so we translate the resolved route into environment variables once
 * per apply instead of leaving them unproxied.
 */
async function resolveSystemProxy(): Promise<string | undefined> {
  try {
    return await session.defaultSession.resolveProxy(SYSTEM_PROXY_PROBE_URL);
  } catch (error) {
    console.warn('[OPC] 无法解析系统代理，子进程沿用原有环境变量', error);
    return undefined;
  }
}

function captureOriginalEnv(target: NodeJS.ProcessEnv): void {
  for (const key of PROXY_ENV_KEYS) {
    if (!originalEnv.has(key)) originalEnv.set(key, target[key]);
  }
}

function originalOverrides(): Record<string, string | null> {
  const overrides: Record<string, string | null> = {};
  for (const key of PROXY_ENV_KEYS) overrides[key] = originalEnv.get(key) ?? null;
  return overrides;
}

/** Applies `null` as "remove the key". */
function overlayEnv(target: NodeJS.ProcessEnv, overrides: Record<string, string | null>): void {
  for (const key of PROXY_ENV_KEYS) {
    if (!(key in overrides)) continue;
    const value = overrides[key];
    if (value === null) delete target[key];
    else target[key] = value;
  }
}

function applyEnvOverrides(
  target: NodeJS.ProcessEnv,
  overrides: Record<string, string | null>,
): void {
  captureOriginalEnv(target);
  overlayEnv(target, overrides);
}

/**
 * Tests a draft without saving it.
 *
 * Two stages, because they fail for different reasons: a TCP dial proves the
 * server is listening, and one request through a throwaway session proves traffic
 * actually flows. Reporting "reachable" on the dial alone would call a firewall
 * that accepts and drops "OK".
 */
export async function probeProxy(config: ResolvedProxy): Promise<ProxyTestResult> {
  const started = Date.now();
  if (!config.host || !config.port) {
    return { ok: false, latencyMs: 0, message: '请先填写代理服务器地址与端口' };
  }

  const reachable = await dialProxy(config.host, config.port);
  if (!reachable.ok) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      message: `无法连接 ${config.host}:${config.port}（${reachable.error}）`,
    };
  }

  const ses = probeSession ?? (probeSession = session.fromPartition(`opc-proxy-probe-${process.pid}`));
  authOverride = { username: config.username, password: config.password };
  let lastError = '';
  try {
    await applyToSession(ses, config);
    for (const endpoint of EGRESS_ENDPOINTS) {
      try {
        const response = await ses.fetch(endpoint, { signal: AbortSignal.timeout(EGRESS_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const ip = parseEgressIp(await response.text());
        return {
          ok: true,
          latencyMs: Date.now() - started,
          message: ip ? `代理可用，出口 IP ${ip}` : '代理可用',
          ...(ip ? { ip } : {}),
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        // Timeouts are decisive (usually a blocked CONNECT); move to the fallback.
      }
    }
  } finally {
    authOverride = null;
    await ses.closeAllConnections().catch(() => undefined);
  }

  return {
    ok: false,
    latencyMs: Date.now() - started,
    message: `代理端口可达，但外网请求失败（${lastError || '未知错误'}）`,
  };
}

function dialProxy(host: string, port: number): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(error ? { ok: false, error } : { ok: true });
    };
    socket.setTimeout(DIAL_TIMEOUT_MS, () => finish('连接超时'));
    socket.once('connect', () => finish());
    socket.once('error', (error) => finish(error.message));
  });
}

/** ipify returns `{"ip":"…"}`; ifconfig.me returns the bare address. */
function parseEgressIp(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { ip?: unknown }).ip === 'string') {
      return (parsed as { ip: string }).ip.trim();
    }
  } catch {
    // Not JSON — the plain-text endpoint.
  }
  return /^\d{1,3}(\.\d{1,3}){3}$|^[0-9a-f:]+$/i.test(trimmed) ? trimmed : '';
}
