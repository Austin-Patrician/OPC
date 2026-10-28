import { describe, expect, it, vi } from 'vitest';
import { createNetworkClient, type NetworkFetch } from './networkClient';

/** The seam's cross-cutting behaviour: timeout, attribution and child env. */

describe('createNetworkClient', () => {
  it('delegates to the injected transport unchanged', async () => {
    const response = new Response('ok');
    const transport = vi.fn(async () => response);
    const network = createNetworkClient({ fetch: transport as NetworkFetch });

    await expect(network.fetch('https://example.com/a', { method: 'POST' })).resolves.toBe(response);
    expect(transport).toHaveBeenCalledWith('https://example.com/a', { method: 'POST' });
  });

  it('adds an abort signal only when a timeout is requested', async () => {
    let seen: RequestInit | undefined;
    const network = createNetworkClient({
      fetch: (async (_input, init) => {
        seen = init;
        return new Response('ok');
      }) as NetworkFetch,
    });

    await network.fetch('https://example.com', undefined, { purpose: 'model' });
    expect(seen?.signal).toBeUndefined();

    await network.fetch('https://example.com', undefined, { purpose: 'model', timeoutMs: 5_000 });
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps a caller-provided signal alongside the timeout', async () => {
    let seen: RequestInit | undefined;
    const network = createNetworkClient({
      fetch: (async (_input, init) => {
        seen = init;
        return new Response('ok');
      }) as NetworkFetch,
    });
    const outer = new AbortController();

    await network.fetch('https://example.com', { signal: outer.signal }, { purpose: 'tool', timeoutMs: 5_000 });
    expect(seen?.signal).not.toBe(outer.signal);
    expect(seen?.signal?.aborted).toBe(false);
  });

  it('logs once with purpose, provider and origin — never the query string', async () => {
    const warn = vi.fn();
    const network = createNetworkClient({
      fetch: (async () => {
        throw new Error('boom');
      }) as NetworkFetch,
      logger: { warn },
    });

    await expect(
      network.fetch('https://api.example.com/v1/chat?key=secret', undefined, {
        purpose: 'model',
        providerId: 'openai',
      }),
    ).rejects.toThrow('boom');

    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain('model/openai');
    expect(message).toContain('https://api.example.com');
    expect(message).not.toContain('secret');
  });

  it('returns a detached copy of the base environment by default', () => {
    const network = createNetworkClient();
    const base = { PATH: '/usr/bin', HTTP_PROXY: 'http://old' };
    const env = network.childEnv(base);

    expect(env).toEqual(base);
    expect(env).not.toBe(base);
  });

  it('lets the proxy layer overlay variables', () => {
    const network = createNetworkClient({
      childEnv: (base) => ({ ...base, HTTPS_PROXY: 'http://proxy:8080' }),
    });

    expect(network.childEnv({ PATH: '/usr/bin' })).toEqual({
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://proxy:8080',
    });
  });
});
