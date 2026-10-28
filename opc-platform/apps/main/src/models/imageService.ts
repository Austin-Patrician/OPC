import type { ProviderConfig } from '@opc/shared/domain';
import type { ModelConfigService } from './modelConfigService';
import { generateImage } from './imageGeneration';
import { defaultNetworkClient, type NetworkClient } from '../network/networkClient';

interface ResolvedTarget {
  providerId: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  /** `ModelOption.api` — selects the wire protocol in `generateImage`. */
  protocol: string;
}

/**
 * Image generation for the agent tool (`generateBytes`); the settings page only
 * configures providers/models. The tool writes the returned bytes into the task
 * workspace, so artifacts/acceptance pick them up.
 *
 * Provider resolution: explicit model → configured default image model → any
 * configured image model (preferring one that has a key).
 */
export class ImageService {
  constructor(
    private readonly models: ModelConfigService,
    private readonly network: NetworkClient = defaultNetworkClient,
  ) {}

  generateBytes = async (input: { prompt: string; modelId?: string }) => {
    const resolved = this.resolveTarget(input);
    if ('error' in resolved) return { ok: false as const, error: resolved.error };

    try {
      const image = await generateImage({
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
        model: resolved.modelId,
        prompt: input.prompt,
        providerId: resolved.providerId,
        protocol: resolved.protocol,
        network: this.network,
      });
      return {
        ok: true as const,
        bytes: new Uint8Array(image.bytes),
        mimeType: image.mimeType,
        model: resolved.modelId,
      };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  };

  /** True when at least one provider owns an image model and has credentials. */
  isAvailable = (): boolean =>
    this.models
      .listProviders()
      .some((provider) => provider.hasKey && provider.models.some((model) => model.capability === 'image'));

  private resolveTarget(input: { modelId?: string }): ResolvedTarget | { error: string } {
    const providers = this.models.listProviders();
    const defaults = this.models.getDefaults();
    const ownsImage = (provider: ProviderConfig) =>
      provider.models.some((model) => model.capability === 'image');

    const explicit = input.modelId
      ? providers.find((provider) => provider.models.some((model) => model.id === input.modelId))
      : undefined;
    // Prefer a provider that can actually authenticate: after importing several
    // built-ins (OpenRouter + OpenAI + Gemini), the first one in the list may
    // still be keyless.
    const fallbackProvider =
      providers.find((provider) => provider.hasKey && ownsImage(provider)) ??
      providers.find(ownsImage);
    const providerId =
      input.modelId && explicit ? explicit.id : (defaults.image?.providerId ?? fallbackProvider?.id);
    const modelId =
      input.modelId ??
      (providerId === defaults.image?.providerId ? defaults.image?.modelId : undefined) ??
      providers.find((provider) => provider.id === providerId)?.models.find((model) => model.capability === 'image')
        ?.id;

    if (!providerId || !modelId) {
      return { error: '请先添加并选择一个图像模型（设置 → 模型 → Image）' };
    }

    const provider = providers.find((entry) => entry.id === providerId);
    if (!provider?.hasKey) return { error: `请先在 LLM 页配置 ${providerId} 的凭证` };

    const apiKey = this.models.readKey(providerId);
    // OAuth-backed providers keep tokens in pi's credential store; the HTTP image
    // endpoint needs a plain bearer key, so say so instead of failing obscurely.
    if (!apiKey) return { error: `${providerId} 没有可用的 API Key（OAuth 凭证不支持图像接口）` };

    const protocol = provider.models.find((model) => model.id === modelId)?.api ?? 'openai-images';
    return {
      providerId,
      modelId,
      // A row saved without a base URL still has to reach the right host; it
      // follows the model's protocol rather than always defaulting to OpenRouter.
      baseUrl: provider.baseUrl || DEFAULT_BASE_URLS[protocol] || DEFAULT_BASE_URLS['openai-images']!,
      apiKey,
      protocol,
    };
  }
}

const DEFAULT_BASE_URLS: Record<string, string> = {
  'openai-images': 'https://api.openai.com/v1',
  'openrouter-images': 'https://openrouter.ai/api/v1',
  'google-images': 'https://generativelanguage.googleapis.com/v1beta',
};
