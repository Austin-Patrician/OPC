import { describe, expect, it } from 'vitest';
import type { CatalogModel, CatalogProvider, ModelOption, ProviderConfig } from '@opc/shared/domain';
import { buildVoiceProviders, mergeVoiceModels, toVoiceModelOption } from './voiceProviders';

const voiceModel = (id: string, type: 'asr' | 'tts', name = id): CatalogModel => ({
  id,
  name,
  type,
  api: 'xiaomi-audio',
});

const catalogProvider = (models: CatalogModel[]): CatalogProvider => ({
  id: 'xiaomi',
  baseUrl: 'https://api.xiaomimimo.com/v1',
  apis: ['openai-completions', 'xiaomi-audio'],
  counts: {
    chat: 0,
    image: 0,
    classifier: 0,
    asr: models.filter((model) => model.type === 'asr').length,
    tts: models.filter((model) => model.type === 'tts').length,
  },
  models,
});

const config = (models: ModelOption[]): ProviderConfig => ({
  id: 'xiaomi',
  name: 'Xiaomi MiMo',
  baseUrl: 'https://api.xiaomimimo.com/v1',
  api: 'openai-completions',
  isCustom: false,
  hasKey: true,
  models,
  updatedAt: 0,
});

describe('buildVoiceProviders', () => {
  it('shows catalog ASR models before the provider row exists', () => {
    const providers = buildVoiceProviders(
      [catalogProvider([voiceModel('mimo-v2.5-asr', 'asr'), voiceModel('mimo-v2.5-tts', 'tts')])],
      [],
      'asr',
      () => 'Xiaomi MiMo',
    );

    expect(providers).toHaveLength(1);
    expect(providers[0]?.models.map((model) => model.id)).toEqual(['mimo-v2.5-asr']);
    expect(providers[0]?.models[0]?.enabled).toBe(false);
    expect(providers[0]?.hasKey).toBe(false);
  });

  it('marks a stored ASR row as enabled and keeps custom ids', () => {
    const providers = buildVoiceProviders(
      [catalogProvider([voiceModel('mimo-v2.5-asr', 'asr')])],
      [
        config([
          {
            id: 'mimo-v2.5-asr',
            name: 'ASR',
            capability: 'asr',
            api: 'xiaomi-audio',
            voiceEnabled: true,
          },
          {
            id: 'custom-asr',
            name: 'Custom ASR',
            capability: 'asr',
            api: 'openai-audio',
            voiceEnabled: true,
          },
        ]),
      ],
      'asr',
      () => 'Xiaomi MiMo',
    );

    expect(providers[0]?.models.map((model) => model.id)).toEqual(['mimo-v2.5-asr', 'custom-asr']);
    expect(providers[0]?.models.every((model) => model.enabled)).toBe(true);
  });

  it('keeps a materialised but not-yet-enabled row switched off', () => {
    const providers = buildVoiceProviders(
      [catalogProvider([voiceModel('mimo-v2.5-asr', 'asr')])],
      // The LLM page stores the whole catalog; capability alone must not enable.
      [config([{ id: 'mimo-v2.5-asr', name: 'ASR', capability: 'asr', api: 'xiaomi-audio' }])],
      'asr',
      () => 'Xiaomi MiMo',
    );

    expect(providers[0]?.models[0]).toMatchObject({ stored: true, enabled: false });
  });

  it('hides a custom provider that only has chat models', () => {
    // The LLM page creates custom providers for chat; they have nothing to do
    // with speech and must not appear on the Voice page.
    const providers = buildVoiceProviders(
      [],
      [
        {
          ...config([{ id: 'gpt-4o', name: 'GPT-4o', capability: 'chat' }]),
          id: 'custom-1',
          name: 'My relay',
          isCustom: true,
        },
      ],
      'asr',
      () => undefined,
    );

    expect(providers).toEqual([]);
  });

  it('hides a custom provider with no models at all', () => {
    const providers = buildVoiceProviders(
      [],
      [{ ...config([]), id: 'custom-1', name: 'My relay', isCustom: true }],
      'asr',
      () => undefined,
    );

    expect(providers).toEqual([]);
  });

  it('lists the provider just created here even before it has a model', () => {
    const providers = buildVoiceProviders(
      [],
      [{ ...config([]), id: 'custom-1', name: 'My relay', isCustom: true }],
      'asr',
      () => undefined,
      { includeProviderId: 'custom-1' },
    );

    expect(providers).toHaveLength(1);
    expect(providers[0]?.models).toEqual([]);
  });

  it('lists a custom provider once it owns a model of this role', () => {
    const providers = buildVoiceProviders(
      [],
      [
        {
          ...config([
            { id: 'whisper-1', name: 'Whisper', capability: 'asr', api: 'openai-audio', voiceEnabled: true },
          ]),
          id: 'custom-1',
          name: 'My relay',
          isCustom: true,
        },
      ],
      'asr',
      () => undefined,
    );

    expect(providers.map((entry) => entry.id)).toEqual(['custom-1']);
    expect(providers[0]?.models[0]).toMatchObject({ id: 'whisper-1', enabled: true });
  });

  it('does not show a TTS row on the ASR tab', () => {
    const providers = buildVoiceProviders(
      [catalogProvider([voiceModel('mimo-v2.5-asr', 'asr'), voiceModel('mimo-v2.5-tts', 'tts')])],
      [config([{ id: 'mimo-v2.5-tts', name: 'TTS', capability: 'tts' }])],
      'asr',
      () => 'Xiaomi MiMo',
    );

    expect(providers[0]?.models.map((model) => model.id)).toEqual(['mimo-v2.5-asr']);
  });
});

describe('voice model helpers', () => {
  it('converts a catalog entry to the stored capability', () => {
    expect(toVoiceModelOption(voiceModel('mimo-v2.5-tts', 'tts', 'TTS'), 'tts')).toMatchObject({
      id: 'mimo-v2.5-tts',
      name: 'TTS',
      capability: 'tts',
      api: 'xiaomi-audio',
      voiceEnabled: true,
    });
  });

  it('upgrades a chat row the catalog knows and appends missing ids', () => {
    const merged = mergeVoiceModels(
      [{ id: 'mimo-v2.5-asr', name: 'old', capability: 'chat' }],
      [voiceModel('mimo-v2.5-asr', 'asr', 'ASR'), voiceModel('mimo-v2.5-tts', 'tts', 'TTS')],
      'asr',
    );

    expect(merged.find((model) => model.id === 'mimo-v2.5-asr')).toMatchObject({
      name: 'ASR',
      capability: 'asr',
      voiceEnabled: true,
    });
    // merge is role-scoped: a TTS entry must not be added on the ASR tab.
    expect(merged.map((model) => model.id)).toEqual(['mimo-v2.5-asr']);
  });
});
