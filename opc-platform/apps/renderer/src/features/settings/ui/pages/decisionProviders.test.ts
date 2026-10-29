import { describe, expect, it } from 'vitest';
import type { CatalogModel, CatalogProvider, ModelOption, ProviderConfig } from '@opc/shared/domain';
import {
  buildDecisionProviders,
  mergeDecisionModels,
  toDecisionModelOption,
} from './decisionProviders';

const classifier = (over: Partial<CatalogModel> = {}): CatalogModel => ({
  id: 'jev-latest',
  name: 'Jev',
  type: 'classifier',
  api: 'typesafe-system-one',
  contextWindow: 64_000,
  price: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
  ...over,
});

const catalogProvider = (over: Partial<CatalogProvider> = {}): CatalogProvider => ({
  id: 'typesafe',
  baseUrl: 'https://api.typesafe.ai/v1',
  apis: ['typesafe-system-one'],
  counts: { chat: 0, image: 0, classifier: 1, asr: 0, tts: 0 },
  models: [classifier()],
  ...over,
});

const stored = (over: Partial<ModelOption> = {}): ModelOption => ({
  id: 'jev-latest',
  name: 'Jev',
  capability: 'classifier',
  api: 'typesafe-system-one',
  decisionEnabled: true,
  ...over,
});

const provider = (models: ModelOption[], over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'typesafe',
  name: 'TypeSafe',
  baseUrl: 'https://api.typesafe.ai/v1',
  api: 'typesafe-system-one',
  isCustom: false,
  hasKey: true,
  models,
  updatedAt: 0,
  ...over,
});

const name = (providerId: string) => (providerId === 'typesafe' ? 'TypeSafe' : undefined);

describe('buildDecisionProviders', () => {
  it('keeps a configured provider and its switch state', () => {
    const [entry] = buildDecisionProviders([catalogProvider()], [provider([stored()])], name);

    expect(entry).toMatchObject({
      id: 'typesafe',
      name: 'TypeSafe',
      baseUrl: 'https://api.typesafe.ai/v1',
      api: 'typesafe-system-one',
      hasKey: true,
    });
    expect(entry!.models).toEqual([
      {
        id: 'jev-latest',
        name: 'Jev',
        api: 'typesafe-system-one',
        stored: true,
        enabled: true,
        catalog: classifier(),
      },
    ]);
  });

  it('lists a catalog-only provider as unconfigured so its key can be added here', () => {
    const [entry] = buildDecisionProviders([catalogProvider()], [], name);

    expect(entry!.config).toBeUndefined();
    expect(entry!.hasKey).toBe(false);
    expect(entry!.models[0]).toMatchObject({ stored: false, enabled: false });
  });

  it('recognises a classifier id left behind as a chat row', () => {
    const [entry] = buildDecisionProviders(
      [catalogProvider()],
      [provider([stored({ capability: 'chat', decisionEnabled: undefined })])],
      name,
    );

    expect(entry!.models[0]).toMatchObject({ stored: true, enabled: false });
  });

  it('does not list a chat-only custom provider at all', () => {
    const entries = buildDecisionProviders(
      [catalogProvider()],
      [
        provider(
          [stored({ id: 'gpt-5.5', capability: 'chat', api: 'openai-completions', decisionEnabled: undefined })],
          { id: 'gateway', isCustom: true },
        ),
      ],
      name,
    );

    expect(entries.map((entry) => entry.id)).toEqual(['typesafe']);
  });

  it('lists a custom provider that owns a decision model, including hand-added ids', () => {
    const entries = buildDecisionProviders(
      [catalogProvider()],
      [
        provider([stored({ id: 'local-classifier', capability: 'classifier', api: 'llama-cpp-classify' })], {
          id: 'gateway',
          name: 'Gateway',
          isCustom: true,
          api: 'openai-completions',
        }),
        provider([stored({ id: 'still-setting-up', capability: 'chat', api: 'openai-completions' })], {
          id: 'brand-new',
          name: 'Brand New',
          isCustom: true,
        }),
      ],
      name,
      { includeProviderId: 'brand-new' },
    );

    expect(entries.map((entry) => entry.id)).toEqual(['brand-new', 'gateway', 'typesafe']);
    expect(entries.find((entry) => entry.id === 'gateway')?.models).toEqual([
      {
        id: 'local-classifier',
        name: 'Jev',
        api: 'llama-cpp-classify',
        stored: true,
        enabled: true,
      },
    ]);
    expect(entries.find((entry) => entry.id === 'brand-new')?.models).toEqual([]);
  });

  it('surfaces an old classifier row on a custom provider by its api kind', () => {
    const entries = buildDecisionProviders(
      [],
      [
        provider(
          [
            stored({
              id: 'jev-1.14',
              capability: 'chat',
              api: 'typesafe-system-one',
              decisionEnabled: undefined,
            }),
          ],
          {
            id: 'gateway',
            name: 'Gateway',
            isCustom: true,
            api: 'openai-completions',
          },
        ),
      ],
      name,
    );

    expect(entries[0]!.models).toEqual([
      { id: 'jev-1.14', name: 'Jev', api: 'typesafe-system-one', stored: true, enabled: false },
    ]);
  });

  it('sorts by display name', () => {
    const entries = buildDecisionProviders(
      [catalogProvider()],
      [],
      (id) => (id === 'typesafe' ? 'Aardvark' : undefined),
    );

    expect(entries[0]!.name).toBe('Aardvark');
  });
});

describe('toDecisionModelOption', () => {
  it('carries the classifier api and pricing into the stored row', () => {
    expect(toDecisionModelOption(classifier(), true)).toEqual({
      id: 'jev-latest',
      name: 'Jev',
      capability: 'classifier',
      api: 'typesafe-system-one',
      contextWindow: 64_000,
      vision: undefined,
      reasoning: undefined,
      inputUsdPerM: 0.042,
      outputUsdPerM: 0,
      cacheReadUsdPerM: 0,
      cacheWriteUsdPerM: 0,
      decisionEnabled: true,
    });
  });
});

describe('mergeDecisionModels', () => {
  it('upgrades a catalog id stored as chat and keeps unrelated rows', () => {
    const chat = stored({ id: 'gpt-5.5', capability: 'chat', api: 'openai-completions', decisionEnabled: undefined });
    const oldClassifier = stored({ id: 'jev-latest', capability: 'chat', decisionEnabled: undefined });

    const merged = mergeDecisionModels([chat, oldClassifier], [classifier()]);

    expect(merged.map((model) => model.id)).toEqual(['gpt-5.5', 'jev-latest']);
    expect(merged[0]).toBe(chat);
    expect(merged[1]!).toMatchObject({
      id: 'jev-latest',
      capability: 'classifier',
      api: 'typesafe-system-one',
    });
    expect(merged[1]!.decisionEnabled).not.toBe(true);
    // The old chat import had no prices; the catalog price fills the gap.
    expect(merged[1]!.inputUsdPerM).toBe(0.042);
  });

  it('appends built-ins that are not stored yet', () => {
    const merged = mergeDecisionModels([], [classifier()]);

    expect(merged).toEqual([toDecisionModelOption(classifier())]);
  });
});
