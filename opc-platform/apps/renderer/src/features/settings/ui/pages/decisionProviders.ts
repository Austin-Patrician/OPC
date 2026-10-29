import type { CatalogModel, CatalogProvider, ModelOption, ProviderConfig } from '@opc/shared/domain';

/** Wire protocols a decision model can speak (pi ships one adapter each). */
export const DECISION_PROTOCOLS = [
  'typesafe-system-one',
  'openai-decisions',
  'cloudflare-workers-ai-system-one',
  'llama-cpp-classify',
] as const;

/**
 * True for a row that belongs to the Decision page even if it was stored as a
 * chat row: before this page existed the LLM import materialised classifier ids
 * as chat, and the model's API kind is the durable evidence of what it is.
 */
export function isDecisionStoredModel(model: ModelOption): boolean {
  return (
    model.capability === 'classifier' ||
    (model.api !== undefined && (DECISION_PROTOCOLS as readonly string[]).includes(model.api))
  );
}

/** One row in the decision-model table: built-in, stored, or both. */
export interface DecisionModelView {
  id: string;
  name: string;
  api?: string;
  /** Already stored in SQLite with `capability: 'classifier'`. */
  stored: boolean;
  /** Explicitly switched on for decisions (`decisionEnabled`), i.e. usable. */
  enabled: boolean;
  /** The pi catalog entry, when this model ships with the app. */
  catalog?: CatalogModel;
}

/** A provider that can serve decision models, configured or not. */
export interface DecisionProviderView {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  /** Stored provider row; absent for providers that only exist in the catalog. */
  config?: ProviderConfig;
  hasKey: boolean;
  /** Built-in classifier models pi ships for this provider. */
  catalogModels: CatalogModel[];
  /** Everything the table shows. */
  models: DecisionModelView[];
}

/**
 * Merges pi's classifier catalog with the providers stored in SQLite.
 *
 * Decision models are the one capability that is *not* a chat variant: Jev takes
 * `state` + typed questions and returns probabilities, so it needs its own page
 * instead of a row on the LLM page. Catalog-only providers stay first-class —
 * TypeSafe has no chat models at all, so its provider row only materialises when
 * the user saves a key on this page.
 */
export function buildDecisionProviders(
  catalog: readonly CatalogProvider[],
  providers: readonly ProviderConfig[],
  displayName: (providerId: string) => string | undefined,
  options: { includeProviderId?: string } = {},
): DecisionProviderView[] {
  const configured = new Map(providers.map((provider) => [provider.id, provider]));
  const seen = new Set<string>();
  const entries: DecisionProviderView[] = [];

  for (const entry of catalog) {
    const config = configured.get(entry.id);
    const catalogModels = entry.models.filter((model) => model.type === 'classifier');
    const storedModels = (config?.models ?? []).filter(isDecisionStoredModel);
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
          enabled: storedById.get(model.id)?.decisionEnabled === true,
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
            enabled: model.decisionEnabled === true,
          })),
      ],
    });
    seen.add(entry.id);
  }

  // Custom providers live only in our DB and are normally created for chat.
  // List one only when it owns a decision model, or when it is the row just
  // created here and still waiting for its first model.
  for (const config of providers) {
    if (seen.has(config.id)) continue;
    const storedModels = config.models.filter(isDecisionStoredModel);
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
        enabled: model.decisionEnabled === true,
      })),
    });
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** Chat protocol first: decision rows carry their own `api` anyway. */
function pickProviderApi(entry: CatalogProvider, config?: ProviderConfig): string {
  if (config) return config.api;
  return (
    entry.apis.find((api) => api === 'openai-completions' || api === 'anthropic-messages') ??
    entry.apis[0] ??
    'openai-completions'
  );
}

/** Turns a catalog classifier model into the stored shape. */
export function toDecisionModelOption(model: CatalogModel, enabled = false): ModelOption {
  return {
    id: model.id,
    name: model.name,
    capability: 'classifier',
    api: model.api,
    contextWindow: model.contextWindow,
    vision: model.vision,
    reasoning: model.reasoning,
    inputUsdPerM: model.price?.input,
    outputUsdPerM: model.price?.output,
    cacheReadUsdPerM: model.price?.cacheRead,
    cacheWriteUsdPerM: model.price?.cacheWrite,
    decisionEnabled: enabled,
  };
}

/**
 * Import helper: keeps every stored model, upgrades ids the catalog knows to
 * `capability: 'classifier'` (the LLM page used to store them as chat rows), and
 * appends the remaining built-in ids.
 */
export function mergeDecisionModels(
  existing: readonly ModelOption[],
  catalogModels: readonly CatalogModel[],
): ModelOption[] {
  const builtins = new Map(catalogModels.map((model) => [model.id, model]));
  const merged = existing.map((model) => {
    const builtin = builtins.get(model.id);
    if (!builtin) return model;
    const converted = toDecisionModelOption(builtin, model.decisionEnabled === true);
    return {
      ...model,
      name: converted.name,
      capability: 'classifier' as const,
      api: converted.api,
      contextWindow: converted.contextWindow ?? model.contextWindow,
      vision: converted.vision ?? model.vision,
      reasoning: converted.reasoning ?? model.reasoning,
      // The old LLM import stored classifier ids without prices. Fill them from
      // the catalog; `setModels` still prefers an explicit user override.
      inputUsdPerM: model.inputUsdPerM ?? converted.inputUsdPerM,
      outputUsdPerM: model.outputUsdPerM ?? converted.outputUsdPerM,
      cacheReadUsdPerM: model.cacheReadUsdPerM ?? converted.cacheReadUsdPerM,
      cacheWriteUsdPerM: model.cacheWriteUsdPerM ?? converted.cacheWriteUsdPerM,
    };
  });

  const present = new Set(existing.map((model) => model.id));
  for (const model of catalogModels) {
    if (!present.has(model.id)) merged.push(toDecisionModelOption(model));
  }
  return merged;
}
