import type { ModelOption, ProviderConfig, ProviderTestResult } from '@opc/shared/domain';
import { isChatModelEnabled } from '@opc/shared/domain';
import type { createProvider, Models } from '@earendil-works/pi-ai/models';

/** Provider stream implementation (pi's `ProviderStreams`). */
type ProviderStreams = NonNullable<
  Parameters<typeof createProvider>[0] extends { api?: infer A } ? A : never
>;
import type { ModelConfigRepository } from '../data/modelConfigRepository';
import type { FileCredentialStore } from './credentialStore';
import { defaultNetworkClient, type NetworkClient } from '../network/networkClient';
import { withNetworkFetch } from '../network/modelNetwork';
import { normalizeModelId } from './pricingMatch';

interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  api: 'openai-completions' | 'anthropic-messages';
}

/** One entry of a provider's `/models` payload; only `id` is guaranteed. */
interface ListedModel {
  id?: string;
  /** OpenRouter-style modality metadata. */
  architecture?: { input_modalities?: string[]; modality?: string };
  /** Some gateways report a capability flag instead. */
  capabilities?: { vision?: boolean };
  supports_vision?: boolean;
}

/** The subset of pi's built-in model definition we fall back to. */
interface BuiltinChatLike {
  id: string;
  input?: readonly string[];
  reasoning?: boolean;
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
    private readonly network: NetworkClient = defaultNetworkClient,
  ) {}

  /** Builds a fresh `Models` for the current config (cheap; providers are lazy). */
  async createModels(): Promise<Models> {
    const { createModels, createProvider } = await import('@earendil-works/pi-ai/models');
    const models = createModels(this.credentials ? { credentials: this.credentials } : undefined);

    for (const config of this.repository.listProviders()) {
      const provider = await this.toProvider(config, { createProvider });
      if (provider) models.setProvider(provider);
    }

    // Explicitly route provider SDK requests through the app's network client.
    // Google adapters are the documented exception (they require globalThis.fetch).
    return withNetworkFetch(models, this.network);
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
      const response = await this.network.fetch(
        `${config.baseUrl.replace(/\/$/, '')}/models`,
        { headers: { authorization: `Bearer ${apiKey}` } },
        { purpose: 'model', providerId: config.id, timeoutMs: 15_000 },
      );

      if (!response.ok) {
        return {
          ok: false,
          message: `HTTP ${response.status} ${response.statusText}`,
          durationMs: Math.round(performance.now() - startedAt),
        };
      }

      const payload = (await response.json()) as { data?: ListedModel[] };
      const models = (payload.data ?? [])
        .filter((entry): entry is ListedModel & { id: string } => typeof entry.id === 'string')
        .map<ModelOption>((entry) => ({
          id: entry.id,
          name: entry.id,
          capability: 'chat',
          // Capability hints are optional and provider-specific; only trust an
          // explicit declaration, otherwise leave it unknown (undefined).
          ...(declaresVision(entry) ? { vision: true } : {}),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));

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
    // Built-in definitions carry `input`/`reasoning` even for models the user
    // configured before those flags existed. Use them as a read-time fallback so
    // vision works without forcing a re-import.
    const builtinModels = await builtinModelsFor(config.id);
    // Custom relays (OpenRouter, a company gateway) are not built-in providers,
    // but their model ids often are; a global index keeps those rows correct.
    const globalCapabilities = builtinModels.length === 0 ? await globalBuiltinCapabilities() : null;
    const chatModels = config.models
      // A model switched off on the LLM page is not registered at all, so the
      // runtime cannot resolve it and the provider's list stays curated.
      .filter((model) => model.capability === 'chat' && isChatModelEnabled(model))
      .map((model) => {
        const builtin = findBuiltinLike(builtinModels, model.id);
        const known = globalCapabilities?.get(normalizeModelId(model.id));
        const vision = model.vision ?? builtin?.input?.includes('image') ?? known?.vision ?? false;
        const reasoning = model.reasoning ?? builtin?.reasoning ?? known?.reasoning ?? false;
        return {
          id: model.id,
          name: model.name,
          api: model.api ?? config.api,
          provider: config.id,
          baseUrl,
          input: (vision ? ['text', 'image'] : ['text']) as ('text' | 'image')[],
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
          reasoning,
          contextWindow: model.contextWindow ?? 128_000,
          maxTokens: Math.min(8_192, Math.round((model.contextWindow ?? 128_000) / 8)),
        };
      });

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

/**
 * Only trust an explicit capability declaration from a listing endpoint:
 * OpenAI-compatible gateways are wildly inconsistent here, and guessing from a
 * model name is exactly how a text-only model gets advertised as vision-capable.
 */
function declaresVision(entry: ListedModel): boolean {
  const modalities = entry.architecture?.input_modalities;
  return (
    entry.supports_vision === true ||
    entry.capabilities?.vision === true ||
    modalities?.includes('image') === true ||
    entry.architecture?.modality?.includes('image') === true
  );
}

/** Built-in definitions for a provider, or `[]` for custom/unknown providers. */
async function builtinModelsFor(providerId: string): Promise<BuiltinChatLike[]> {
  try {
    const { getBuiltinModels } = await import('@earendil-works/pi-ai/providers/all');
    // The runtime indexes by provider id; the generated types ask for the object.
    return getBuiltinModels(providerId as never) as unknown as BuiltinChatLike[];
  } catch {
    return [];
  }
}

function findBuiltinLike(models: readonly BuiltinChatLike[], modelId: string) {
  const exact = models.find((model) => model.id === modelId);
  if (exact) return exact;
  const normalized = normalizeModelId(modelId);
  return normalized ? models.find((model) => normalizeModelId(model.id) === normalized) : undefined;
}

/** id → capability, across every built-in provider, built once per process. */
let globalCapabilities: Map<string, { vision: boolean; reasoning: boolean }> | null = null;

async function globalBuiltinCapabilities(): Promise<Map<string, { vision: boolean; reasoning: boolean }>> {
  if (globalCapabilities) return globalCapabilities;
  const map = new Map<string, { vision: boolean; reasoning: boolean }>();
  try {
    const { builtinProviders, getBuiltinModels } = await import('@earendil-works/pi-ai/providers/all');
    for (const provider of builtinProviders()) {
      const models = getBuiltinModels(provider.id as never) as unknown as BuiltinChatLike[];
      for (const model of models) {
        const key = normalizeModelId(model.id);
        if (!key || map.has(key)) continue;
        map.set(key, {
          vision: model.input?.includes('image') === true,
          reasoning: model.reasoning === true,
        });
      }
    }
  } catch {
    // A catalog failure must not stop model creation; capabilities stay unknown.
  }
  globalCapabilities = map;
  return map;
}
