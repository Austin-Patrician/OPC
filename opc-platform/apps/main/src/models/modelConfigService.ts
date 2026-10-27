import type {
  CompactionSettings,
  ModelDefaults,
  ModelOption,
  ModelRef,
  ProviderConfig,
  ProviderDraft,
  ProviderTestResult,
} from '@opc/shared/domain';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CompanyDatabase } from '../data/companyDatabase';
import { ModelConfigRepository } from '../data/modelConfigRepository';
import { decryptSecret, encryptSecret } from './keyCipher';
import type { FileCredentialStore } from './credentialStore';
import { matchBuiltinModel, type BuiltinModelEntry } from './pricingMatch';
import { ModelRuntime, PROVIDER_PRESETS } from './runtime';

/** What a model-list refresh actually did, in words the UI can show. */
export interface RefreshModelsResult {
  providers: ProviderConfig[];
  ok: boolean;
  message: string;
  /** Ids that were not present before this refresh. */
  added: string[];
  /** Size of the list the provider returned. */
  total: number;
}

/** What "use official pricing" actually managed to map. */
export interface ApplyPricingResult {
  providers: ProviderConfig[];
  matched: number;
  unmatched: string[];
}

const DEFAULT_LLM_KEY = 'default.llm';
const DEFAULT_IMAGE_KEY = 'default.image';
const COMPACTION_KEY = 'compaction';
const THINKING_KEY = 'default.thinking';

/** Defaults mirror pi's own policy (16k reserve / 20k keep). */
const DEFAULT_COMPACTION: CompactionSettings = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
  backgroundTokens: 32_768,
};

export class ModelConfigService {
  private readonly repository: ModelConfigRepository;
  readonly runtime: ModelRuntime;

  constructor(db: CompanyDatabase, credentials?: FileCredentialStore) {
    this.repository = new ModelConfigRepository(db);
    this.runtime = new ModelRuntime(
      this.repository,
      (providerId) => this.readKey(providerId),
      credentials,
    );

    // First run: seed the presets so the page is not an empty form.
    if (this.repository.listProviders().length === 0) {
      for (const preset of PROVIDER_PRESETS) {
        this.repository.saveProvider({ ...preset, isCustom: false });
      }
    }
  }

  listProviders = (): ProviderConfig[] => this.repository.listProviders();

  saveProvider = (draft: ProviderDraft): ProviderConfig[] => {
    this.repository.saveProvider(draft);
    // The dialog can collect the key up-front, so creating a provider is one step.
    const apiKey = draft.apiKey?.trim();
    if (apiKey) this.repository.saveCredential(draft.id, encryptSecret(apiKey));
    return this.listProviders();
  };

  /**
   * Only providers this app created can be deleted. pi's built-in providers are
   * part of the product (and carry OAuth/builtin pricing), so deleting one would
   * leave a hole the UI cannot explain — they are refused, not hidden.
   */
  removeProvider = (providerId: string): ProviderConfig[] => {
    const provider = this.repository.getProvider(providerId);
    if (!provider) throw new Error('未知 provider');
    if (!provider.isCustom) throw new Error('pi 内置提供商不可删除（只能清空 API Key）');
    this.repository.removeProvider(providerId);
    return this.listProviders();
  };

  setKey = (providerId: string, apiKey: string): ProviderConfig[] => {
    if (!this.repository.getProvider(providerId)) throw new Error('未知 provider');
    if (apiKey.trim().length === 0) {
      this.repository.clearCredential(providerId);
    } else {
      this.repository.saveCredential(providerId, encryptSecret(apiKey.trim()));
    }
    return this.listProviders();
  };

  test = async (providerId: string): Promise<ProviderTestResult> => {
    const config = this.repository.getProvider(providerId);
    if (!config) return { ok: false, message: '未知 provider' };
    return this.runtime.testProvider(config);
  };

  /**
   * Adds a model the provider's `/models` endpoint does not list (fine-tuning,
   * self-hosted gateways, brand-new ids). Prices start empty: 0 means "unknown",
   * which the UI shows as a dash instead of a fake number.
   */
  addModel = (
    providerId: string,
    input: {
      id: string;
      name?: string;
      contextWindow?: number;
      api?: string;
      inputUsdPerM?: number;
      outputUsdPerM?: number;
      cacheReadUsdPerM?: number;
      cacheWriteUsdPerM?: number;
    },
  ): ProviderConfig[] => {
    const provider = this.repository.getProvider(providerId);
    if (!provider) throw new Error('未知 provider');
    const id = input.id.trim();
    if (!id) throw new Error('模型 id 不能为空');
    if (provider.models.some((model) => model.id === id)) throw new Error(`模型已存在：${id}`);

    this.repository.saveModels(providerId, [
      ...provider.models,
      {
        id,
        name: input.name?.trim() || id,
        api: input.api?.trim() || provider.api,
        // Chat is the only capability a hand-added model has until proven otherwise.
        capability: 'chat',
        contextWindow: input.contextWindow ?? 0,
        inputUsdPerM: input.inputUsdPerM ?? 0,
        outputUsdPerM: input.outputUsdPerM ?? 0,
        cacheReadUsdPerM: input.cacheReadUsdPerM ?? 0,
        cacheWriteUsdPerM: input.cacheWriteUsdPerM ?? 0,
      },
    ]);
    return this.listProviders();
  };

  /** Whether this provider can log in through OAuth (most use an API key). */
  supportsOauth = async (providerId: string): Promise<boolean> => {
    const { builtinProviders } = await import('@earendil-works/pi-ai/providers/all');
    const builtin = builtinProviders().find((provider) => provider.id === providerId);
    return Boolean(builtin?.auth && (builtin.auth as { oauth?: unknown }).oauth);
  };

  /**
   * Fetch the provider's model list and import it, reporting what changed.
   *
   * Many OpenAI-compatible gateways have no `/models` endpoint (or answer with an
   * error page), so the caller must be able to say "this endpoint cannot list
   * models" instead of leaving the user staring at an unchanged table.
   */
  refreshModels = async (providerId: string): Promise<RefreshModelsResult> => {
    const config = this.repository.getProvider(providerId);
    if (!config) throw new Error('未知 provider');

    const before = new Set(config.models.map((model) => model.id));
    const result = await this.runtime.testProvider(config);
    const listed = result.models ?? [];

    if (!result.ok) {
      return {
        providers: this.listProviders(),
        ok: false,
        message: result.message,
        added: [],
        total: config.models.length,
      };
    }
    if (listed.length === 0) {
      return {
        providers: this.listProviders(),
        ok: false,
        message: '该服务商没有返回模型列表（接口不支持或需要额外权限）',
        added: [],
        total: config.models.length,
      };
    }

    // Merge instead of replace: the endpoint only tells us ids. Existing prices,
    // context windows, capabilities and manually added models are the user's data
    // and must survive a refresh.
    const existing = new Map(config.models.map((model) => [model.id, model]));
    const listedIds = new Set(listed.map((model) => model.id));
    const imported = listed.map((model) => {
      const previous = existing.get(model.id);
      if (!previous) return model;
      return { ...previous, id: model.id, name: previous.name || model.name };
    });
    const kept = config.models.filter((model) => !listedIds.has(model.id));
    this.repository.saveModels(providerId, [...imported, ...kept]);

    const added = listed.filter((model) => !before.has(model.id)).map((model) => model.id);
    return {
      providers: this.listProviders(),
      ok: true,
      message: `拉取到 ${listed.length} 个模型`,
      added,
      total: listed.length,
    };
  };

  /**
   * Fills prices from pi's built-in catalogue. Exact ids win; otherwise the matcher
   * normalises gateway/date/vendor decoration. Unmatched models keep price 0
   * ("unknown") and are reported back, so the UI can say what it could not map
   * instead of leaving a silently half-filled table.
   */
  applyBuiltinPricing = async (providerId: string): Promise<ApplyPricingResult> => {
    const provider = this.repository.getProvider(providerId);
    if (!provider) throw new Error('未知 provider');

    const catalogue = await this.builtinCatalogue();
    const unmatched: string[] = [];
    let matched = 0;

    const models = provider.models.map((model) => {
      const builtin = matchBuiltinModel(catalogue, { providerId, modelId: model.id });
      if (!builtin) {
        unmatched.push(model.id);
        return model;
      }
      matched += 1;
      return {
        ...model,
        contextWindow: model.contextWindow || builtin.contextWindow || 0,
        inputUsdPerM: builtin.inputUsdPerM,
        outputUsdPerM: builtin.outputUsdPerM,
        cacheReadUsdPerM: builtin.cacheReadUsdPerM,
        cacheWriteUsdPerM: builtin.cacheWriteUsdPerM,
      };
    });

    this.repository.saveModels(providerId, models);
    return { providers: this.listProviders(), matched, unmatched };
  };

  /** Built once per process: 42 providers × their models, read from pi, not typed in. */
  private catalogue: BuiltinModelEntry[] | null = null;

  private builtinCatalogue = async (): Promise<BuiltinModelEntry[]> => {
    if (this.catalogue) return this.catalogue;
    const { builtinProviders } = await import('@earendil-works/pi-ai/providers/all');
    const entries: BuiltinModelEntry[] = [];

    for (const provider of builtinProviders()) {
      const list = provider as unknown as {
        id: string;
        getAllModels?: () => Promise<unknown[]>;
      };
      if (typeof list.getAllModels !== 'function') continue;
      // Some providers expose a synchronous list, others a promise; accept both.
      const maybe = (() => {
        try {
          return list.getAllModels!();
        } catch {
          return [] as unknown[];
        }
      })();
      const models = Array.isArray(maybe) ? maybe : await (maybe as Promise<unknown[]>).catch(() => []);
      for (const raw of models) {
        const model = raw as {
          id?: string;
          cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
          contextWindow?: number;
        };
        if (!model.id || !model.cost) continue;
        entries.push({
          providerId: list.id,
          modelId: model.id,
          inputUsdPerM: model.cost.input ?? 0,
          outputUsdPerM: model.cost.output ?? 0,
          cacheReadUsdPerM: model.cost.cacheRead ?? 0,
          cacheWriteUsdPerM: model.cost.cacheWrite ?? 0,
          contextWindow: model.contextWindow,
        });
      }
    }

    this.catalogue = entries;
    return entries;
  };

  getThinking = (): string => this.repository.getSetting(THINKING_KEY) ?? 'medium';

  setThinking = (level: string): string => {
    const allowed = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const clean = allowed.includes(level) ? level : 'medium';
    this.repository.setSetting(THINKING_KEY, clean);
    return clean;
  };

  getCompaction = (): CompactionSettings => {
    const raw = this.repository.getSetting(COMPACTION_KEY);
    if (!raw) return DEFAULT_COMPACTION;
    try {
      return { ...DEFAULT_COMPACTION, ...(JSON.parse(raw) as Partial<CompactionSettings>) };
    } catch {
      return DEFAULT_COMPACTION;
    }
  };

  setCompaction = (next: CompactionSettings): CompactionSettings => {
    const clean: CompactionSettings = {
      enabled: Boolean(next.enabled),
      reserveTokens: clamp(next.reserveTokens, 1024, 1_000_000),
      keepRecentTokens: clamp(next.keepRecentTokens, 0, 1_000_000),
      backgroundTokens: clamp(next.backgroundTokens, 0, 1_000_000),
    };
    this.repository.setSetting(COMPACTION_KEY, JSON.stringify(clean));
    return clean;
  };

  setModels = (providerId: string, models: ModelOption[]): ProviderConfig[] => {
    const existing = this.repository.getProvider(providerId);
    if (!existing) throw new Error('未知 provider');

    // Merge instead of replace: the catalog supplies ids/context, but pricing and
    // any manual context override belong to the user and must survive a re-import.
    this.repository.saveModels(
      providerId,
      models.map((model) => {
        const previous = existing.models.find((entry) => entry.id === model.id);
        return {
          id: model.id,
          name: model.name,
          capability: model.capability,
          contextWindow: model.contextWindow ?? previous?.contextWindow,
          inputUsdPerM: previous?.inputUsdPerM ?? model.inputUsdPerM,
          outputUsdPerM: previous?.outputUsdPerM ?? model.outputUsdPerM,
        };
      }),
    );
    return this.listProviders();
  };

  /** Persists the context window the compaction thresholds are computed against. */
  setModelContext = (providerId: string, modelId: string, contextWindow: number): ProviderConfig[] => {
    const provider = this.repository.getProvider(providerId);
    if (!provider) throw new Error('未知 provider');
    const models = provider.models.map((model) =>
      model.id === modelId ? { ...model, contextWindow: clamp(contextWindow, 1024, 10_000_000) } : model,
    );
    this.repository.saveModels(providerId, models);
    return this.listProviders();
  };

  setModelPricing = (
    providerId: string,
    modelId: string,
    price: { input: number; output: number; cacheRead: number; cacheWrite: number },
  ): ProviderConfig[] => {
    const provider = this.repository.getProvider(providerId);
    if (!provider) throw new Error('未知 provider');
    const rate = (value: number) => clamp(Math.round(value * 10_000) / 10_000, 0, 10_000);

    this.repository.saveModels(
      providerId,
      provider.models.map((model) =>
        model.id === modelId
          ? {
              ...model,
              inputUsdPerM: rate(price.input),
              outputUsdPerM: rate(price.output),
              cacheReadUsdPerM: rate(price.cacheRead),
              cacheWriteUsdPerM: rate(price.cacheWrite),
            }
          : model,
      ),
    );
    return this.listProviders();
  };

  getDefaults = (): ModelDefaults => ({
    llm: this.readRef(DEFAULT_LLM_KEY),
    image: this.readRef(DEFAULT_IMAGE_KEY),
  });

  setDefault = (role: 'llm' | 'image', ref: ModelRef | null): ModelDefaults => {
    const key = role === 'llm' ? DEFAULT_LLM_KEY : DEFAULT_IMAGE_KEY;
    if (ref) this.repository.setSetting(key, `${ref.providerId}::${ref.modelId}`);
    else this.repository.setSetting(key, '');
    return this.getDefaults();
  };

  /** Explicit action: imports the provider block of an existing pi config. */
  importFromPi = (): { imported: number; providers: ProviderConfig[] } => {
    const file = path.join(os.homedir(), '.pi', 'agent', 'models.json');
    if (!fs.existsSync(file)) throw new Error('未找到 ~/.pi/agent/models.json');

    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      providers?: Record<
        string,
        { name?: string; baseUrl?: string; api?: string; apiKey?: string; models?: { id: string; name?: string }[] }
      >;
    };

    let imported = 0;
    for (const [id, provider] of Object.entries(raw.providers ?? {})) {
      const models: ModelOption[] = (provider.models ?? []).map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        capability: 'chat',
      }));

      const existing = this.repository.getProvider(id);
      this.repository.saveProvider({
        id,
        name: provider.name ?? id,
        baseUrl: provider.baseUrl ?? '',
        api: provider.api ?? 'openai-completions',
        isCustom: true,
      });
      if (models.length > 0) {
        this.repository.saveModels(
          id,
          models.map((model) => {
            const previous = existing?.models.find((entry) => entry.id === model.id);
            return {
              ...model,
              contextWindow: previous?.contextWindow ?? model.contextWindow,
              inputUsdPerM: previous?.inputUsdPerM ?? model.inputUsdPerM,
              outputUsdPerM: previous?.outputUsdPerM ?? model.outputUsdPerM,
            };
          }),
        );
      }
      if (provider.apiKey) {
        this.repository.saveCredential(id, encryptSecret(provider.apiKey));
      }
      if (models[0]) {
        this.repository.setSetting(DEFAULT_LLM_KEY, `${id}::${models[0].id}`);
      }
      imported += 1;
    }

    return { imported, providers: this.listProviders() };
  };

  readKey = (providerId: string): string | undefined => {
    const ciphertext = this.repository.readCredential(providerId);
    if (!ciphertext) return undefined;
    try {
      return decryptSecret(ciphertext);
    } catch {
      return undefined;
    }
  };

  private readRef(key: string): ModelRef | null {
    const raw = this.repository.getSetting(key);
    if (!raw) return null;
    const [providerId, modelId] = raw.split('::');
    return providerId && modelId ? { providerId, modelId } : null;
  }
}

/** Clamps without rounding: prices are fractional USD, not token counts. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
