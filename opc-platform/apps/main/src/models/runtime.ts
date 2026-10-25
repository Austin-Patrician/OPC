import type { ModelOption, ProviderConfig, ProviderTestResult } from '@opc/shared/domain';
import type { createProvider, Models } from '@earendil-works/pi-ai/models';

/** Provider stream implementation (pi's `ProviderStreams`). */
type ProviderStreams = NonNullable<
  Parameters<typeof createProvider>[0] extends { api?: infer A } ? A : never
>;
import type { ModelConfigRepository } from '../data/modelConfigRepository';
import type { FileCredentialStore } from './credentialStore';

interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  api: 'openai-completions' | 'anthropic-messages';
}

/**
 * Presets mirror the two API families pi-ai ships (`openai-completions`,
 * `anthropic-messages`). DeepSeek / Moonshot / Groq / OpenRouter are all
 * OpenAI-compatible, so they share one code path instead of one integration each.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', api: 'openai-completions' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions' },
  { id: 'moonshotai', name: 'Moonshot（Kimi）', baseUrl: 'https://api.moonshot.cn/v1', api: 'openai-completions' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions' },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', api: 'openai-completions' },
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages' },
];

/**
 * Builds pi-ai `Models` from stored provider configs.
 *
 * `pi-ai` is the only path to a model call: the brain, the connection test and
 * (later) image generation all go through the same object.
 */
export class ModelRuntime {
  constructor(
    private readonly repository: ModelConfigRepository,
    private readonly readKey: (providerId: string) => string | undefined,
    private readonly credentials?: FileCredentialStore,
  ) {}

  /** Builds a fresh `Models` for the current config (cheap; providers are lazy). */
  async createModels(): Promise<Models> {
    const { createModels, createProvider } = await import('@earendil-works/pi-ai/models');
    const models = createModels(this.credentials ? { credentials: this.credentials } : undefined);

    for (const config of this.repository.listProviders()) {
      const provider = await this.toProvider(config, { createProvider });
      if (provider) models.setProvider(provider);
    }

    return models;
  }

  /** Resolved model object for a provider/model pair, if both are configured. */
  async resolveModel(providerId: string, modelId: string) {
    const models = await this.createModels();
    return models.getModel(providerId, modelId);
  }

  /**
   * Connection test. For OpenAI-compatible endpoints we ask `/models` (cheap,
   * read-only) and import the ids; for other APIs we only confirm the key exists.
   */
  async testProvider(config: ProviderConfig): Promise<ProviderTestResult> {
    const startedAt = performance.now();
    const apiKey = this.readKey(config.id);
    if (!apiKey) {
      return { ok: false, message: '未配置 API Key' };
    }

    if (config.api !== 'openai-completions' || !config.baseUrl) {
      return {
        ok: true,
        message: 'API Key 已保存（该接口不支持列举模型，未做网络探测）',
        durationMs: Math.round(performance.now() - startedAt),
      };
    }

    try {
      const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        return {
          ok: false,
          message: `HTTP ${response.status} ${response.statusText}`,
          durationMs: Math.round(performance.now() - startedAt),
        };
      }

      const payload = (await response.json()) as { data?: { id?: string }[] };
      const models = (payload.data ?? [])
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === 'string')
        .sort()
        .map<ModelOption>((id) => ({ id, name: id, capability: 'chat' }));

      return {
        ok: true,
        message: `连接成功，发现 ${models.length} 个模型`,
        models,
        durationMs: Math.round(performance.now() - startedAt),
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        durationMs: Math.round(performance.now() - startedAt),
      };
    }
  }

  private async readCredentialKey(providerId: string): Promise<string | undefined> {
    if (!this.credentials) return undefined;
    const credential = await this.credentials.read(providerId);
    return credential?.type === 'api_key'
      ? (credential as { key?: string }).key
      : undefined;
  }

  private async toProvider(
    config: ProviderConfig,
    helpers: { createProvider: typeof createProvider },
  ) {
    // Two sources by design: our encrypted SQLite column, and pi's credential file
    // (written by OAuth/API-key login). Either one satisfies the provider.
    const apiKey =
      this.readKey(config.id) ?? (await this.readCredentialKey(config.id));
    if (!apiKey) {
      // OAuth-only providers have no key; pi resolves their tokens through the store.
      const hasOAuth = Boolean((await findBuiltinProvider(config.id))?.auth.oauth);
      if (!hasOAuth) return undefined;
    }

    // Mix all API kinds the provider's models use; pi resolves per model.
    const kinds = Array.from(new Set(config.models.map((model) => model.api ?? config.api)));
    const api: Record<string, ProviderStreams> = {};
    for (const kind of kinds) {
      const streams = await apiFor(kind);
      if (streams) api[kind] = streams as ProviderStreams;
    }
    if (Object.keys(api).length === 0) return undefined;

    const baseUrl = config.baseUrl.replace(/\/$/, '');
    const chatModels = config.models
      .filter((model) => model.capability === 'chat')
      .map((model) => ({
        id: model.id,
        name: model.name,
        api: model.api ?? config.api,
        provider: config.id,
        baseUrl,
        input: ['text'] as ('text' | 'image')[],
        // pi's ModelCost: USD per 1M tokens, cache rates included, plus optional
        // context-bucket tiers (`inputTokensAbove`).
        cost: {
          input: model.inputUsdPerM ?? 0,
          output: model.outputUsdPerM ?? 0,
          cacheRead: model.cacheReadUsdPerM ?? model.inputUsdPerM ?? 0,
          cacheWrite: model.cacheWriteUsdPerM ?? model.inputUsdPerM ?? 0,
          ...(model.tiers && model.tiers.length > 0
            ? {
                tiers: model.tiers.map((tier) => ({
                  inputTokensAbove: tier.inputTokensAbove,
                  input: tier.inputUsdPerM,
                  output: tier.outputUsdPerM,
                  cacheRead: tier.cacheReadUsdPerM,
                  cacheWrite: tier.cacheWriteUsdPerM,
                })),
              }
            : {}),
        },
        reasoning: false,
        contextWindow: model.contextWindow ?? 128_000,
        maxTokens: Math.min(8_192, Math.round((model.contextWindow ?? 128_000) / 8)),
      }));

    if (chatModels.length === 0) return undefined;

    // Built-in providers bring their own OAuth implementation; attaching it is what
    // makes `models.login(id, 'oauth')` work for Claude/Copilot/etc.
    const builtin = await findBuiltinProvider(config.id);

    return helpers.createProvider({
      id: config.id,
      name: config.name,
      baseUrl,
      auth: {
        apiKey: {
          name: `${config.name} API key`,
          resolve: async () =>
            apiKey ? { auth: { apiKey }, source: 'app-settings' } : undefined,
        },
        ...(builtin?.auth.oauth ? { oauth: builtin.auth.oauth } : {}),
      },
      models: chatModels,
      // A per-API map: pi resolves the stream implementation per model.api.
      api: api as Parameters<typeof createProvider>[0]['api'],
    });
  }
}


/**
 * Maps a pi API kind to its lazy implementation. Every kind pi ships is covered,
 * so a provider is not limited to the two APIs we happened to import first.
 */
async function apiFor(kind: string): Promise<unknown> {
  switch (kind) {
    case 'anthropic-messages':
      return (await import('@earendil-works/pi-ai/api/anthropic-messages.lazy')).anthropicMessagesApi();
    case 'openai-completions':
      return (await import('@earendil-works/pi-ai/api/openai-completions.lazy')).openAICompletionsApi();
    case 'openai-responses':
      return (await import('@earendil-works/pi-ai/api/openai-responses.lazy')).openAIResponsesApi();
    case 'azure-openai-responses':
      return (await import('@earendil-works/pi-ai/api/azure-openai-responses.lazy')).azureOpenAIResponsesApi();
    case 'bedrock-converse-stream':
      return (await import('@earendil-works/pi-ai/api/bedrock-converse-stream.lazy')).bedrockConverseStreamApi();
    case 'google-generative-ai':
      return (await import('@earendil-works/pi-ai/api/google-generative-ai.lazy')).googleGenerativeAIApi();
    case 'google-vertex':
      return (await import('@earendil-works/pi-ai/api/google-vertex.lazy')).googleVertexApi();
    case 'mistral-conversations':
      return (await import('@earendil-works/pi-ai/api/mistral-conversations.lazy')).mistralConversationsApi();
    case 'openai-codex-responses':
      return (await import('@earendil-works/pi-ai/api/openai-codex-responses.lazy')).openAICodexResponsesApi();
    case 'pi-messages':
      return (await import('@earendil-works/pi-ai/api/pi-messages.lazy')).piMessagesApi();
    default:
      // Image/classifier-only APIs are not chat streams.
      return undefined;
  }
}


/** pi ships the OAuth flow inside its built-in provider objects. */
async function findBuiltinProvider(providerId: string) {
  const { builtinProviders } = await import('@earendil-works/pi-ai/providers/all');
  return builtinProviders().find((provider) => provider.id === providerId);
}
