import type { Models } from '@earendil-works/pi-ai/models';
import type { NetworkClient } from './networkClient';

/**
 * Request methods on pi-ai's `Models` that accept a `fetch` option.
 *
 * `google-generative-ai` / `google-vertex` deliberately reject a custom fetch
 * unless it is exactly `globalThis.fetch`; those adapters keep using the global
 * bridge installed by `connectProxyRuntime`.
 */
const REQUEST_METHODS = new Set([
  'stream',
  'complete',
  'streamSimple',
  'completeSimple',
  'streamDeferred',
  'fetchDeferred',
  'generateImages',
  'classify',
]);

const GLOBAL_FETCH_APIS = new Set(['google-generative-ai', 'google-vertex']);

/**
 * Makes the model catalog use the app's network client explicitly.
 *
 * pi-ai creates its provider SDKs lazily and most accept a per-request `fetch`.
 * Injecting it here means a model call cannot silently escape through a captured
 * global or a future SDK default; callers that pass their own `fetch` win.
 *
 * Every other method is bound to the real instance: `proxy.method()` would
 * otherwise run with the Proxy as `this`, which breaks providers that keep
 * private fields. Binding is cached so method identity stays stable.
 */
export function withNetworkFetch<T extends Models>(models: T, network: NetworkClient): T {
  const bound = new Map<string, unknown>();

  return new Proxy(models, {
    // Read with `target` as the receiver: getters on a class instance must not
    // execute against the Proxy.
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function' || typeof property !== 'string') return value;

      const cached = bound.get(property);
      if (cached) return cached;

      const wrapped = REQUEST_METHODS.has(property)
        ? (...args: unknown[]) => {
            const model = args[0] as { api?: string } | undefined;
            const options = (args[2] ?? {}) as Record<string, unknown>;
            const inject = !options.fetch && (!model?.api || !GLOBAL_FETCH_APIS.has(model.api));
            if (!inject) return value.apply(target, args);
            return value.call(target, args[0], args[1], { ...options, fetch: network.fetch });
          }
        : value.bind(target);

      bound.set(property, wrapped);
      return wrapped;
    },
  }) as T;
}
