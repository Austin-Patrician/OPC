import { describe, expect, it } from 'vitest';
import type { CatalogModel, CatalogProvider, ModelOption, ProviderConfig } from '@opc/shared/domain';
import { buildImageProviders, mergeImageModels, toImageModelOption } from './imageProviders';

const imageModel = (id: string, name = id): CatalogModel => ({
  id,
  name,
  type: 'image',
  api: 'openrouter-images',
});

const chatModel = (id: string): CatalogModel => ({
  id,
  name: id,
  type: 'chat',
  api: 'openai-completions',
});

const catalogProvider = (over: Partial<CatalogProvider> & { id: string }): CatalogProvider => {
  const models = over.models ?? [];
  const count = (type: CatalogModel['type']) => models.filter((model) => model.type === type).length;
  return {
    id: over.id,
    baseUrl: over.baseUrl ?? `https://${over.id}.example/v1`,
    apis: over.apis ?? ['openai-completions'],
    counts: over.counts ?? {
      chat: count('chat'),
      image: count('image'),
      classifier: count('classifier'),
      asr: count('asr'),
      tts: count('tts'),
    },
    models,
  };
};

const config = (over: Partial<ProviderConfig> & { id: string }): ProviderConfig => ({
  id: over.id,
  name: over.name ?? over.id,
  baseUrl: over.baseUrl ?? `https://${over.id}.example/v1`,
  api: over.api ?? 'openai-completions',
  isCustom: over.isCustom ?? false,
  hasKey: over.hasKey ?? false,
  models: over.models ?? [],
  updatedAt: 0,
});

const option = (over: Partial<ModelOption> & { id: string }): ModelOption => ({
  name: over.name ?? over.id,
  capability: over.capability ?? 'chat',
  ...over,
});

describe('buildImageProviders', () => {
  it('surfaces catalog-only providers and their built-in image models', () => {
    const catalog = [
      catalogProvider({
        id: 'openrouter',
        apis: ['openai-completions', 'openrouter-images'],
        models: [
          chatModel('openai/gpt-5'),
          imageModel('openai/gpt-image-1'),
          imageModel('google/nano-banana'),
        ],
      }),
      catalogProvider({ id: 'openai', models: [chatModel('gpt-5')] }),
    ];

    const entries = buildImageProviders(catalog, [], (id) =>
      id === 'openrouter' ? 'OpenRouter' : undefined,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: 'openrouter',
      name: 'OpenRouter',
      api: 'openai-completions',
      hasKey: false,
      config: undefined,
    });
    expect(entries[0]?.catalogImages.map((model) => model.id)).toEqual([
      'openai/gpt-image-1',
      'google/nano-banana',
    ]);
    expect(entries[0]?.images.every((model) => !model.stored)).toBe(true);
  });

  it('keeps a configured chat-only provider visible through the catalog', () => {
    const catalog = [
      catalogProvider({
        id: 'openrouter',
        apis: ['openai-completions', 'openrouter-images'],
        models: [imageModel('a/1')],
      }),
    ];
    const providers = [config({ id: 'openrouter', hasKey: true, models: [option({ id: 'openai/gpt-5' })] })];

    const [entry] = buildImageProviders(catalog, providers, () => 'OpenRouter');

    expect(entry?.config?.hasKey).toBe(true);
    expect(entry?.images.map((model) => model.id)).toEqual(['a/1']);
  });

  it('marks stored image models and hides stored-only chat rows', () => {
    const catalog = [
      catalogProvider({ id: 'openrouter', models: [imageModel('a/1', 'Model A'), imageModel('a/2')] }),
    ];
    const providers = [
      config({
        id: 'openrouter',
        models: [option({ id: 'a/1', name: 'Old name', capability: 'image' }), option({ id: 'chat/1' })],
      }),
    ];

    const [entry] = buildImageProviders(catalog, providers, () => 'OpenRouter');

    expect(entry?.images).toEqual([
      {
        id: 'a/1',
        name: 'Model A',
        api: 'openrouter-images',
        stored: true,
        enabled: false,
        catalog: catalog[0]?.models[0],
      },
      {
        id: 'a/2',
        name: 'a/2',
        api: 'openrouter-images',
        stored: false,
        enabled: false,
        catalog: catalog[0]?.models[1],
      },
    ]);
  });

  it('keeps hand-added image models the catalog does not know', () => {
    const providers = [
      config({
        id: 'local',
        name: 'Local gateway',
        isCustom: true,
        models: [option({ id: 'custom/1', name: 'Custom 1', capability: 'image', api: 'openai-images' })],
      }),
    ];

    const entries = buildImageProviders([], providers, () => undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.images).toEqual([
      { id: 'custom/1', name: 'Custom 1', stored: true, enabled: false, api: 'openai-images' },
    ]);
  });

  it('hides a custom chat provider and only pins the one just created', () => {
    const chatOnly = config({
      id: 'custom-chat',
      name: 'Chat relay',
      isCustom: true,
      models: [option({ id: 'gpt-4o' })],
    });

    expect(buildImageProviders([], [chatOnly], () => undefined)).toEqual([]);
    // The dialog's `onCreate` pins the new row so it does not vanish before a
    // model has been added to it.
    expect(
      buildImageProviders([], [chatOnly], () => undefined, { includeProviderId: 'custom-chat' }),
    ).toHaveLength(1);
  });

  it('does not read "the row exists" as "enabled for images"', () => {
    // The LLM page materialises a provider's whole catalog, image models
    // included. Those rows have no `imageEnabled` flag, and must stay off.
    const catalog = [catalogProvider({ id: 'google', models: [imageModel('imagen-4')] })];
    const providers = [
      config({ id: 'google', hasKey: true, models: [option({ id: 'imagen-4', capability: 'image' })] }),
    ];

    const [entry] = buildImageProviders(catalog, providers, () => 'Google');
    expect(entry?.images[0]).toMatchObject({ id: 'imagen-4', stored: true, enabled: false });

    const [switchedOn] = buildImageProviders(
      catalog,
      [
        config({
          id: 'google',
          hasKey: true,
          models: [option({ id: 'imagen-4', capability: 'image', imageEnabled: true })],
        }),
      ],
      () => 'Google',
    );
    expect(switchedOn?.images[0]).toMatchObject({ stored: true, enabled: true });
  });

  it('skips providers without any image model', () => {
    const catalog = [catalogProvider({ id: 'openai', models: [chatModel('gpt-5')] })];
    const providers = [config({ id: 'deepseek', models: [option({ id: 'deepseek-chat' })] })];

    expect(buildImageProviders(catalog, providers, () => undefined)).toEqual([]);
  });
});

describe('mergeImageModels', () => {
  it('upgrades catalog ids stored as chat and appends the rest', () => {
    const catalog = [imageModel('a/1', 'Model A'), imageModel('a/2', 'Model B')];
    const existing = [
      option({
        id: 'a/1',
        name: 'a/1',
        capability: 'chat',
        api: 'openai-completions',
        contextWindow: 128_000,
      }),
      option({ id: 'chat/1', capability: 'chat' }),
    ];

    const merged = mergeImageModels(existing, catalog);

    expect(merged.map((model) => [model.id, model.capability])).toEqual([
      ['a/1', 'image'],
      ['chat/1', 'chat'],
      ['a/2', 'image'],
    ]);
    expect(merged[0]).toMatchObject({ name: 'Model A', api: 'openrouter-images', contextWindow: 128_000 });
  });
});

describe('toImageModelOption', () => {
  it('maps catalog prices and tiers into the stored shape', () => {
    const converted = toImageModelOption({
      id: 'a/1',
      name: 'Model A',
      type: 'image',
      api: 'openrouter-images',
      contextWindow: 32_000,
      price: {
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        tiers: [{ inputTokensAbove: 1000, input: 5, output: 6, cacheRead: 7, cacheWrite: 8 }],
      },
    });

    expect(converted).toMatchObject({
      id: 'a/1',
      capability: 'image',
      contextWindow: 32_000,
      inputUsdPerM: 1,
      outputUsdPerM: 2,
      cacheReadUsdPerM: 3,
      cacheWriteUsdPerM: 4,
      tiers: [
        {
          inputTokensAbove: 1000,
          inputUsdPerM: 5,
          outputUsdPerM: 6,
          cacheReadUsdPerM: 7,
          cacheWriteUsdPerM: 8,
        },
      ],
    });
  });
});
