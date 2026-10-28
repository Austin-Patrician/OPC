import type { CatalogModel, CatalogProvider, ModelOption, ProviderConfig } from '@opc/shared/domain';

export type VoiceRole = 'asr' | 'tts';

/** One row in the voice-model table: built-in, stored, or both. */
export interface VoiceModelView {
  id: string;
  name: string;
  api?: string;
  /** Already stored in SQLite with this voice capability. */
  stored: boolean;
  /** Explicitly switched on for speech (`voiceEnabled`), i.e. usable at runtime. */
  enabled: boolean;
  /** The pi/catalog entry, when this model ships with the app. */
  catalog?: CatalogModel;
}

/** A provider that can serve ASR or TTS models, configured or not. */
export interface VoiceProviderView {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  /** Stored provider row; absent for providers that only exist in the catalog. */
  config?: ProviderConfig;
  hasKey: boolean;
  /** Built-in models of this role. */
  catalogModels: CatalogModel[];
  /** Everything the table shows. */
  models: VoiceModelView[];
}

/**
 * Merges the catalog's speech entries with the providers stored in SQLite.
 *
 * Catalog-only providers are first-class so Xiaomi's ASR/TTS models show up
 * before the provider row exists; the row is created on first save. A stored
 * model counts as enabled only when its `capability` matches the role, which is
 * what the runtime resolves against.
 *
 * A provider is listed only when it actually owns a model of this role. Custom
 * providers are created for chat on the LLM page and have nothing to do with
 * speech, so they must not leak in here. The one exception is `includeProviderId`:
 * the row the user just created on this page, which has no models yet and would
 * otherwise disappear before a model could be added to it.
 */
export function buildVoiceProviders(
  catalog: readonly CatalogProvider[],
  providers: readonly ProviderConfig[],
  role: VoiceRole,
  displayName: (providerId: string) => string | undefined,
  options: { includeProviderId?: string } = {},
): VoiceProviderView[] {
  const configured = new Map(providers.map((provider) => [provider.id, provider]));
  const seen = new Set<string>();
  const entries: VoiceProviderView[] = [];

  for (const entry of catalog) {
    const config = configured.get(entry.id);
    const catalogModels = entry.models.filter((model) => model.type === role);
    const storedModels = (config?.models ?? []).filter((model) => model.capability === role);
    if (catalogModels.length === 0 && storedModels.length === 0) continue;

    const storedById = new Map(storedModels.map((model) => [model.id, model]));
    const catalogIds = new Set(catalogModels.map((model) => model.id));

    entries.push({
      id: entry.id,
      name: config?.name ?? displayName(entry.id) ?? entry.id,
      baseUrl: config?.baseUrl || entry.baseUrl,
      api: pickProviderApi(entry, config),
      config,
      hasKey: config?.hasKey ?? false,
      catalogModels,
      models: [
        ...catalogModels.map((model) => ({
          id: model.id,
          name: model.name,
          api: model.api,
          stored: storedById.has(model.id),
          enabled: storedById.get(model.id)?.voiceEnabled === true,
          catalog: model,
        })),
        // Hand-added ids (or ids returned by `/models`) the catalog does not know.
        ...storedModels
          .filter((model) => !catalogIds.has(model.id))
          .map((model) => ({
            id: model.id,
            name: model.name,
            api: model.api,
            stored: true,
            enabled: model.voiceEnabled === true,
          })),
      ],
    });
    seen.add(entry.id);
  }

  // Custom providers live only in our DB, and the LLM page creates them for
  // chat. List one only when it owns a model of this role, or when it is the
  // row just created here and still waiting for its first model.
  for (const config of providers) {
    if (seen.has(config.id)) continue;
    const storedModels = config.models.filter((model) => model.capability === role);
    if (storedModels.length === 0 && config.id !== options.includeProviderId) continue;
    entries.push({
      id: config.id,
      name: config.name,
      baseUrl: config.baseUrl,
      api: config.api,
      config,
      hasKey: config.hasKey,
      catalogModels: [],
      models: storedModels.map((model) => ({
        id: model.id,
        name: model.name,
        api: model.api,
        stored: true,
        enabled: model.voiceEnabled === true,
      })),
    });
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** Chat protocol first: voice rows carry their own `api` anyway. */
function pickProviderApi(entry: CatalogProvider, config?: ProviderConfig): string {
  if (config) return config.api;
  return (
    entry.apis.find((api) => api === 'openai-completions' || api === 'anthropic-messages') ??
    entry.apis[0] ??
    'openai-completions'
  );
}

/** Turns a catalog voice model into the stored shape. */
export function toVoiceModelOption(model: CatalogModel, role: VoiceRole): ModelOption {
  return {
    id: model.id,
    name: model.name,
    capability: role,
    api: model.api,
    contextWindow: model.contextWindow,
    voiceEnabled: true,
  };
}

/**
 * Import helper: keeps every stored model, upgrades ids the catalog knows to
 * this voice capability (a `/models` refresh may have stored them as chat), and
 * appends the remaining built-in ids.
 */
export function mergeVoiceModels(
  existing: readonly ModelOption[],
  catalogModels: readonly CatalogModel[],
  role: VoiceRole,
): ModelOption[] {
  // The page passes a role-scoped list already; filtering here keeps the helper
  // safe for callers that hand over the whole catalog.
  const scoped = catalogModels.filter((model) => model.type === role);
  const builtins = new Map(scoped.map((model) => [model.id, model]));
  const merged = existing.map((model) => {
    const builtin = builtins.get(model.id);
    if (!builtin) return model;
    const converted = toVoiceModelOption(builtin, role);
    return {
      ...model,
      name: converted.name,
      capability: role,
      api: converted.api,
      voiceEnabled: true,
    };
  });

  const present = new Set(existing.map((model) => model.id));
  for (const model of scoped) {
    if (!present.has(model.id)) merged.push(toVoiceModelOption(model, role));
  }
  return merged;
}
