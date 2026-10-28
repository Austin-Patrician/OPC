/**
 * The one network entry point business code should use.
 *
 * Proxy handling is a process-wide policy, but business code still needs an
 * explicit seam: timeouts, request purpose, failure logging and child-process
 * environments should not be re-invented at every `fetch` call site. The
 * implementation is injected so tests can use a fake transport, and so the
 * Electron runtime can supply the proxy-aware one from `proxyRuntime`.
 */
export type NetworkFetch = typeof globalThis.fetch;
export type NetworkRequestInput = Parameters<NetworkFetch>[0];
export type NetworkRequestInit = Parameters<NetworkFetch>[1];

export type NetworkPurpose =
  | 'model'
  | 'image'
  | 'speech'
  | 'tool'
  | 'probe'
  | 'acceptance'
  | 'other';

export interface NetworkRequestContext {
  purpose: NetworkPurpose;
  /** Provider id, when the request belongs to a model/image provider. */
  providerId?: string;
  /** Applied only when the caller did not pass its own signal. */
  timeoutMs?: number;
}

export interface NetworkClient {
  fetch(
    input: NetworkRequestInput,
    init?: NetworkRequestInit,
    context?: NetworkRequestContext,
  ): ReturnType<NetworkFetch>;
  /**
   * The environment a child process should inherit. `process.env` stays the
   * default base; the network layer overlays or removes proxy variables.
   */
  childEnv(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
}

export interface NetworkClientDeps {
  /** The transport. Defaults to the current `globalThis.fetch`. */
  fetch?: NetworkFetch;
  /** Overlays the proxy variables for a spawned process. */
  childEnv?: (base: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  /** Injected in tests; defaults to `console`. */
  logger?: Pick<Console, 'warn'>;
}

function targetOf(input: NetworkRequestInput): string {
  const raw =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url;
  try {
    const url = new URL(raw);
    // Origin only: query strings can contain credentials or one-time tokens.
    return url.origin;
  } catch {
    return 'unknown';
  }
}

function methodOf(input: NetworkRequestInput, init?: NetworkRequestInit): string {
  return (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
}

function withTimeout(
  init: NetworkRequestInit,
  timeoutMs: number | undefined,
): NetworkRequestInit {
  if (!timeoutMs) return init;
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!init?.signal) return { ...init, signal: timeout };
  return { ...init, signal: AbortSignal.any([init.signal, timeout]) };
}

/**
 * Wraps a transport with the app's cross-cutting network behaviour.
 *
 * It deliberately does not rewrite the request or apply a domain policy yet;
 * those belong in a later routing layer. What it guarantees today is that every
 * request is attributable (purpose/provider), has a timeout when asked for, and
 * failures are logged once with the target origin rather than leaking a URL.
 */
export function createNetworkClient(deps: NetworkClientDeps = {}): NetworkClient {
  const logger = deps.logger ?? console;
  const transport = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));

  return {
    fetch: async (input, init, context) => {
      const started = Date.now();
      try {
        return await transport(input, withTimeout(init, context?.timeoutMs));
      } catch (error) {
        const purpose = context?.purpose ?? 'other';
        const provider = context?.providerId ? `/${context.providerId}` : '';
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(
          `[OPC] 网络请求失败 · ${purpose}${provider} ${methodOf(input, init)} ${targetOf(input)} (${Date.now() - started}ms): ${message}`,
        );
        throw error;
      }
    },
    childEnv: (base = process.env) =>
      deps.childEnv ? deps.childEnv(base) : { ...base },
  };
}

/** Used when a service is constructed without an injected client (tests/probes). */
export const defaultNetworkClient: NetworkClient = createNetworkClient();
