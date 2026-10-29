import { describe, expect, it } from 'vitest';
import type { ModelDefaults, ModelOption, ProviderConfig } from '@opc/shared/domain';
import type { ModelConfigService } from './modelConfigService';
import { SpeechService } from './speechService';
import type { NetworkClient } from '../network/networkClient';

const asrModel = (over: Partial<ModelOption> = {}): ModelOption => ({
  id: 'mimo-v2.5-asr',
  name: 'MiMo-V2.5-ASR',
  capability: 'asr',
  api: 'xiaomi-audio',
  voiceEnabled: true,
  ...over,
});

const provider = (models: ModelOption[], hasKey = true): ProviderConfig => ({
  id: 'xiaomi',
  name: 'Xiaomi MiMo',
  baseUrl: 'https://api.xiaomimimo.com/v1',
  api: 'openai-completions',
  isCustom: false,
  hasKey,
  models,
  updatedAt: 0,
});

const defaults = (over: Partial<ModelDefaults> = {}): ModelDefaults => ({
  llm: null,
  image: null,
  asr: null,
  tts: null,
  decision: null,
  ...over,
});

function service(
  providers: ProviderConfig[],
  values: ModelDefaults,
  options: { key?: string; network?: NetworkClient } = {},
) {
  const models = {
    listProviders: () => providers,
    getDefaults: () => values,
    readKey: () => options.key,
  } as unknown as ModelConfigService;
  return new SpeechService(models, options.network);
}

const audio = { audio: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' };

describe('SpeechService resolution', () => {
  it('refuses a stored row that was never switched on for speech', async () => {
    const result = await service(
      [provider([asrModel({ voiceEnabled: undefined })])],
      defaults({ asr: { providerId: 'xiaomi', modelId: 'mimo-v2.5-asr' } }),
      { key: 'k' },
    ).transcribe(audio);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('未启用');
  });

  it('asks for a credential before calling the provider', async () => {
    const result = await service(
      [provider([asrModel()], false)],
      defaults({ asr: { providerId: 'xiaomi', modelId: 'mimo-v2.5-asr' } }),
      { key: undefined },
    ).transcribe(audio);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('凭证');
  });

  it('explains that no ASR model is configured at all', async () => {
    const result = await service([], defaults()).transcribe(audio);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('语音识别模型');
  });

  it('resolves an enabled model and returns the transcript', async () => {
    const network = {
      fetch: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '你好' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      childEnv: () => ({}),
    } as unknown as NetworkClient;

    const result = await service(
      [provider([asrModel()])],
      defaults({ asr: { providerId: 'xiaomi', modelId: 'mimo-v2.5-asr' } }),
      { key: 'k', network },
    ).transcribe(audio);

    expect(result).toEqual({ ok: true, text: '你好', model: 'mimo-v2.5-asr', seconds: undefined });
  });

  it('reports availability only for providers that have a key', () => {
    expect(service([provider([asrModel()], false)], defaults()).isAsrAvailable()).toBe(false);
    expect(service([provider([asrModel({ voiceEnabled: false })], true)], defaults()).isAsrAvailable()).toBe(
      false,
    );
    expect(service([provider([asrModel()])], defaults()).isAsrAvailable()).toBe(true);
  });
});
