import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '@opc/shared/domain';
import type { ModelConfigRepository } from '../data/modelConfigRepository';
import { createNetworkClient } from '../network/networkClient';
import { ModelRuntime } from './runtime';

/** Capability metadata: read it from `/models` when declared, else from pi. */

const baseConfig: ProviderConfig = {
  id: 'custom-relay',
  name: 'Relay',
  baseUrl: 'https://relay.test/v1',
  api: 'openai-completions',
  isCustom: true,
  hasKey: true,
  models: [],
  updatedAt: 0,
};

function runtimeWith(payload: unknown): ModelRuntime {
  const repository = { listProviders: () => [] } as unknown as ModelConfigRepository;
  const network = createNetworkClient({
    fetch: (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
  });
  return new ModelRuntime(repository, () => 'test-key', undefined, network);
}

describe('ModelRuntime.testProvider', () => {
  it('reads explicit vision declarations from a model listing', async () => {
    const result = await runtimeWith({
      data: [
        { id: 'openrouter-style', architecture: { input_modalities: ['text', 'image'] } },
        { id: 'capability-flag', capabilities: { vision: true } },
        { id: 'flat-flag', supports_vision: true },
        { id: 'text-only' },
      ],
    }).testProvider(baseConfig);

    expect(result.ok).toBe(true);
    expect(result.models?.map((model) => [model.id, model.vision])).toEqual([
      ['capability-flag', true],
      ['flat-flag', true],
      ['openrouter-style', true],
      ['text-only', undefined],
    ]);
  });
});

describe('ModelRuntime.createModels', () => {
  it('falls back to the built-in definition so existing rows gain vision', async () => {
    const config: ProviderConfig = {
      id: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      api: 'openai-completions',
      isCustom: false,
      hasKey: true,
      // Stored before `vision` existed: no flag, but the id is a known model.
      models: [{ id: 'gpt-4o', name: 'GPT-4o', capability: 'chat', api: 'openai-completions' }],
      updatedAt: 0,
    };
    const repository = {
      listProviders: () => [config],
    } as unknown as ModelConfigRepository;

    const model = await new ModelRuntime(repository, () => 'test-key').resolveModel('openai', 'gpt-4o');

    expect(model?.input).toContain('image');
  });

  it('recognises a known model id behind a custom relay', async () => {
    const config: ProviderConfig = {
      ...baseConfig,
      models: [{ id: 'openai/gpt-4o', name: 'GPT-4o', capability: 'chat', api: 'openai-completions' }],
    };
    const repository = {
      listProviders: () => [config],
    } as unknown as ModelConfigRepository;

    const model = await new ModelRuntime(repository, () => 'test-key').resolveModel(
      'custom-relay',
      'openai/gpt-4o',
    );

    expect(model?.input).toContain('image');
  });

  it('does not register a chat model that was switched off', async () => {
    const config: ProviderConfig = {
      ...baseConfig,
      models: [
        { id: 'kept', name: 'Kept', capability: 'chat', api: 'openai-completions' },
        {
          id: 'switched-off',
          name: 'Switched off',
          capability: 'chat',
          api: 'openai-completions',
          chatEnabled: false,
        },
      ],
    };
    const repository = {
      listProviders: () => [config],
    } as unknown as ModelConfigRepository;
    const runtime = new ModelRuntime(repository, () => 'test-key');

    expect(await runtime.resolveModel('custom-relay', 'kept')).toBeTruthy();
    expect(await runtime.resolveModel('custom-relay', 'switched-off')).toBeUndefined();
  });

  it('treats a row stored before the switch existed as enabled', async () => {
    const config: ProviderConfig = {
      ...baseConfig,
      // No `chatEnabled`: every provider configured before the toggle shipped.
      models: [{ id: 'legacy', name: 'Legacy', capability: 'chat', api: 'openai-completions' }],
    };
    const repository = {
      listProviders: () => [config],
    } as unknown as ModelConfigRepository;

    expect(
      await new ModelRuntime(repository, () => 'test-key').resolveModel('custom-relay', 'legacy'),
    ).toBeTruthy();
  });

  it('registers a classifier only when the Decision switch is on', async () => {
    const config: ProviderConfig = {
      id: 'typesafe',
      name: 'TypeSafe',
      baseUrl: 'https://api.typesafe.ai/v1',
      api: 'typesafe-system-one',
      isCustom: false,
      hasKey: true,
      models: [
        {
          id: 'jev-latest',
          name: 'Jev',
          capability: 'classifier',
          api: 'typesafe-system-one',
          decisionEnabled: true,
        },
        {
          id: 'not-enabled',
          name: 'Not enabled',
          capability: 'classifier',
          api: 'typesafe-system-one',
        },
      ],
      updatedAt: 0,
    };
    const repository = {
      listProviders: () => [config],
    } as unknown as ModelConfigRepository;
    const models = await new ModelRuntime(repository, () => 'test-key').createModels();

    expect(models.getModelOfType('classifier', 'typesafe', 'jev-latest')).toBeTruthy();
    expect(models.getModelOfType('classifier', 'typesafe', 'not-enabled')).toBeUndefined();
  });
});
