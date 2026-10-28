import { describe, expect, it, vi } from 'vitest';
import type { Models } from '@earendil-works/pi-ai/models';
import { createNetworkClient, type NetworkFetch } from './networkClient';
import { withNetworkFetch } from './modelNetwork';

/** Model requests must go through the injected client, not a captured global. */

type FakeModels = Models & {
  complete: (...args: unknown[]) => Promise<string>;
  read: () => string;
};

function fakeModels(): FakeModels {
  const complete = vi.fn(async () => 'done');
  return {
    value: 'plain',
    complete,
    read(this: { value: string }) {
      return this.value;
    },
  } as unknown as FakeModels;
}

const network = createNetworkClient({ fetch: vi.fn() as unknown as NetworkFetch });

describe('withNetworkFetch', () => {
  it('injects the client fetch into request methods', async () => {
    const models = fakeModels();
    const wrapped = withNetworkFetch(models, network);
    const model = { api: 'openai-completions' };

    await wrapped.complete(model as never, {} as never, {});

    expect(models.complete).toHaveBeenCalledWith(model, {}, { fetch: network.fetch });
  });

  it('keeps a caller-provided fetch', async () => {
    const models = fakeModels();
    const wrapped = withNetworkFetch(models, network);
    const own = vi.fn();

    await wrapped.complete({ api: 'openai-completions' } as never, {} as never, { fetch: own });

    expect(models.complete).toHaveBeenCalledWith({ api: 'openai-completions' }, {}, { fetch: own });
  });

  it('leaves the Google adapters on the global bridge', async () => {
    const models = fakeModels();
    const wrapped = withNetworkFetch(models, network);
    const model = { api: 'google-generative-ai' };

    await wrapped.complete(model as never, {} as never, {});

    expect(models.complete).toHaveBeenCalledWith(model, {}, {});
  });

  it('binds other methods to the real instance and caches them', () => {
    const models = fakeModels();
    const wrapped = withNetworkFetch(models, network);

    expect(wrapped.read()).toBe('plain');
    expect(wrapped.read).toBe(wrapped.read);
    expect((wrapped as unknown as { value: string }).value).toBe('plain');
  });
});
