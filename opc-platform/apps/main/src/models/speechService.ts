import type {
  ModelOption,
  ProviderConfig,
  SpeechSynthesizeInput,
  SpeechSynthesizeResult,
  SpeechTranscribeInput,
  SpeechTranscribeResult,
} from '@opc/shared/domain';
import type { ModelConfigService } from './modelConfigService';
import { synthesizeSpeech, transcribeAudio } from './speech';
import { defaultNetworkClient, type NetworkClient } from '../network/networkClient';

type SpeechRole = 'asr' | 'tts';

interface ResolvedTarget {
  providerId: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  /** `ModelOption.api` — selects the wire protocol in `speech.ts`. */
  protocol: string;
}

/**
 * Speech recognition and synthesis for the renderer (microphone / read aloud).
 *
 * Provider resolution mirrors `ImageService`: explicit model → configured
 * default → any configured model of that capability, preferring one that has a
 * key. The API key never leaves the main process; the renderer only sends audio
 * bytes and receives text or audio bytes.
 */
export class SpeechService {
  constructor(
    private readonly models: ModelConfigService,
    private readonly network: NetworkClient = defaultNetworkClient,
  ) {}

  transcribe = async (input: SpeechTranscribeInput): Promise<SpeechTranscribeResult> => {
    const resolved = this.resolveTarget('asr', input.modelId);
    if ('error' in resolved) return { ok: false, error: resolved.error };

    try {
      const result = await transcribeAudio({
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
        model: resolved.modelId,
        protocol: resolved.protocol,
        providerId: resolved.providerId,
        audio: input.audio,
        mimeType: input.mimeType,
        language: input.language,
        network: this.network,
      });
      return {
        ok: true,
        text: result.text,
        model: resolved.modelId,
        seconds: result.seconds,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  synthesize = async (input: SpeechSynthesizeInput): Promise<SpeechSynthesizeResult> => {
    const resolved = this.resolveTarget('tts', input.modelId);
    if ('error' in resolved) return { ok: false, error: resolved.error };
    if (!input.text.trim()) return { ok: false, error: '要合成的文本不能为空' };

    try {
      const result = await synthesizeSpeech({
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
        model: resolved.modelId,
        protocol: resolved.protocol,
        providerId: resolved.providerId,
        text: input.text,
        voice: input.voice,
        format: input.format,
        network: this.network,
      });
      return {
        ok: true,
        bytes: new Uint8Array(result.bytes),
        mimeType: result.mimeType,
        model: resolved.modelId,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  /** True when at least one provider owns an ASR model and has credentials. */
  isAsrAvailable = (): boolean => this.isAvailable('asr');

  /** True when at least one provider owns a TTS model and has credentials. */
  isTtsAvailable = (): boolean => this.isAvailable('tts');

  private isAvailable(role: SpeechRole): boolean {
    return this.models
      .listProviders()
      .some((provider) => provider.hasKey && provider.models.some((model) => isEnabled(model, role)));
  }

  private resolveTarget(role: SpeechRole, requestedModelId?: string): ResolvedTarget | { error: string } {
    const providers = this.models.listProviders();
    const defaults = this.models.getDefaults()[role];
    const owns = (provider: ProviderConfig) => provider.models.some((model) => isEnabled(model, role));

    const explicit = requestedModelId
      ? providers.find((provider) =>
          provider.models.some((model) => model.id === requestedModelId && isEnabled(model, role)),
        )
      : undefined;
    // Prefer a provider that can actually authenticate: the catalog may list a
    // voice provider before its key has been entered.
    const fallbackProvider =
      providers.find((provider) => provider.hasKey && owns(provider)) ?? providers.find(owns);

    const providerId = explicit?.id ?? defaults?.providerId ?? fallbackProvider?.id;
    const modelId =
      requestedModelId ??
      (providerId === defaults?.providerId ? defaults?.modelId : undefined) ??
      providers.find((provider) => provider.id === providerId)?.models.find((model) => isEnabled(model, role))
        ?.id;

    if (!providerId || !modelId) {
      const label = role === 'asr' ? '语音识别' : '语音合成';
      return { error: `请先添加并选择一个${label}模型（设置 → 模型 → Voice）` };
    }

    const provider = providers.find((entry) => entry.id === providerId);
    if (!provider?.hasKey) return { error: `请先在 Voice 页配置 ${providerId} 的凭证` };

    const model = provider.models.find((entry) => entry.id === modelId);
    if (!model || !isEnabled(model, role)) {
      return { error: `所选语音模型 ${modelId} 未启用（设置 → 模型 → Voice）` };
    }

    const apiKey = this.models.readKey(providerId);
    if (!apiKey)
      return {
        error: `${providerId} 没有可用的 API Key（OAuth 凭证不支持语音接口）`,
      };

    const protocol = model.api ?? 'xiaomi-audio';

    return {
      providerId,
      modelId,
      baseUrl: provider.baseUrl || DEFAULT_BASE_URLS[protocol] || DEFAULT_BASE_URLS['xiaomi-audio']!,
      apiKey,
      protocol,
    };
  }
}

/** A stored row is not enough: the Voice page's explicit switch must be on. */
function isEnabled(model: ModelOption, role: SpeechRole): boolean {
  return model.capability === role && model.voiceEnabled === true;
}

const DEFAULT_BASE_URLS: Record<string, string> = {
  'xiaomi-audio': 'https://api.xiaomimimo.com/v1',
  'openai-audio': 'https://api.openai.com/v1',
};
