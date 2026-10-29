import { describe, expect, it } from 'vitest';
import type { CatalogModel, CatalogProvider, ModelOption, ProviderConfig } from '@opc/shared/domain';
import { buildLlmProviders } from './llmProviders';

const chatModel = (over: Partial<CatalogModel> = {}): CatalogModel => ({
  id: 'gpt-5.5',
  name: 'GPT-5.5',
  type: 'chat',
  api: 'openai-completions',
  ...over,
});

const classifierModel = (over: Partial<CatalogModel> = {}): CatalogModel => ({
  id: 'jev-latest',
  name: 'Jev',
  type: 'classifier',
  api: 'typesafe-system-one',
  ...over,
});

const catalogProvider = (over: Partial<CatalogProvider> = {}): CatalogProvider => ({
  id: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apis: ['openai-completions'],
  counts: { chat: 1, image: 0, classifier: 0, asr: 0, tts: 0 },
  models: [chatModel()],
  ...over,
});

/** TypeSafe as pi ships it: classifiers only, no chat model at all. */
const typesafe = (): CatalogProvider => ({
  id: 'typesafe',
  baseUrl: 'https://api.typesafe.ai/v1',
  apis: ['typesafe-system-one'],
  counts: { chat: 0, image: 0, classifier: 1, asr: 0, tts: 0 },
  models: [classifierModel()],
});

const stored = (over: Partial<ModelOption> = {}): ModelOption => ({
  id: 'gpt-5.5',
  name: 'GPT-5.5',
  capability: 'chat',
  api: 'openai-completions',
  ...over,
});

const provider = (models: ModelOption[], over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'custom-relay',
  name: 'Custom relay',
  baseUrl: 'https://relay.test/v1',
  api: 'openai-completions',
  isCustom: true,
  hasKey: true,
  models,
  updatedAt: 0,
  ...over,
});

const noMeta = () => undefined;

describe('buildLlmProviders', () => {
  it('lists a catalog provider that ships chat models', () => {
    const [entry] = buildLlmProviders([catalogProvider()], [], noMeta);

    expect(entry).toMatchObject({ id: 'openai', counts: { chat: 1 } });
    expect(entry!.models.map((model) => model.id)).toEqual(['gpt-5.5']);
  });

  it('leaves out a catalog provider that only ships classifiers', () => {
    // TypeSafe is configured on Settings → Decision. It used to appear here with a
    // key field, promising a provider that can never answer a chat prompt.
    const entries = buildLlmProviders([catalogProvider(), typesafe()], [], noMeta);

    expect(entries.map((entry) => entry.id)).toEqual(['openai']);
  });

  it('keeps a catalog provider whose chat model was added by hand', () => {
    // The endpoint's /models list may return ids pi does not know; those rows make
    // the provider usable for chat again.
    const entries = buildLlmProviders(
      [typesafe()],
      [provider([stored({ id: 'jev-chat', capability: 'chat' })], { id: 'typesafe', isCustom: false })],
      noMeta,
    );

    expect(entries.map((entry) => entry.id)).toEqual(['typesafe']);
    expect(entries[0]!.counts.chat).toBe(1);
  });

  it('keeps a catalog provider that serves chat and decisions at once', () => {
    const openrouter = catalogProvider({
      id: 'openrouter',
      counts: { chat: 1, image: 0, classifier: 1, asr: 0, tts: 0 },
      models: [chatModel({ id: 'gpt-5.5' }), classifierModel({ id: 'typesafe/jev-1.14' })],
    });

    const [entry] = buildLlmProviders([openrouter], [], noMeta);

    expect(entry).toMatchObject({ id: 'openrouter', counts: { chat: 1, classifier: 1 } });
  });

  it('leaves out a custom relay owned by the Decision page', () => {
    const entries = buildLlmProviders(
      [catalogProvider()],
      [
        provider([stored({ capability: 'classifier', api: 'typesafe-system-one' })], {
          id: 'decision-relay',
          name: 'Jev relay',
          scope: 'decision',
        }),
      ],
      noMeta,
    );

    expect(entries.map((entry) => entry.id)).toEqual(['openai']);
  });

  it('leaves out a legacy relay that only owns classifier rows', () => {
    // Written before `scope` existed: no owner field, but the models give it away.
    const entries = buildLlmProviders(
      [catalogProvider()],
      [
        provider([stored({ capability: 'classifier', api: 'typesafe-system-one' })], {
          id: 'legacy-relay',
          name: 'Legacy Jev relay',
        }),
      ],
      noMeta,
    );

    expect(entries.map((entry) => entry.id)).toEqual(['openai']);
  });

  it('lists a custom chat relay', () => {
    const entries = buildLlmProviders([], [provider([stored()])], noMeta);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: 'custom-relay',
      counts: { chat: 1, classifier: 0 },
      apis: ['openai-completions'],
    });
  });

  it('keeps a freshly created custom relay that has no models yet', () => {
    const entries = buildLlmProviders([], [provider([])], noMeta);

    expect(entries.map((entry) => entry.id)).toEqual(['custom-relay']);
  });

  it('does not duplicate a stored provider that is also in the catalog', () => {
    const entries = buildLlmProviders(
      [catalogProvider()],
      [provider([stored()], { id: 'openai', isCustom: false })],
      noMeta,
    );

    expect(entries.map((entry) => entry.id)).toEqual(['openai']);
    expect(entries[0]!.icon).toBeUndefined();
  });

  it('appends stored ids the catalog does not know about', () => {
    const entries = buildLlmProviders(
      [catalogProvider()],
      [provider([stored(), stored({ id: 'gpt-6-preview', name: 'GPT-6 preview' })], { id: 'openai' })],
      noMeta,
    );

    expect(entries[0]!.models.map((model) => model.id)).toEqual(['gpt-5.5', 'gpt-6-preview']);
    expect(entries[0]!.counts.chat).toBe(2);
  });

  it('uses the design catalogue for name, group and description', () => {
    const [entry] = buildLlmProviders([catalogProvider()], [], (id) =>
      id === 'openai' ? { name: 'OpenAI', group: 'frontier', description: 'GPT family' } : undefined,
    );

    expect(entry).toMatchObject({ name: 'OpenAI', group: 'frontier', description: 'GPT family' });
  });
});
