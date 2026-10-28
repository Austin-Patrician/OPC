import type { CatalogModel, CatalogProvider, ModelOption, ProviderConfig } from '@opc/shared/domain';

/** One row in the image-model table: built-in, stored, or both. */
export interface ImageModelView {
  id: string;
  name: string;
  api?: string;
  /** Already stored in SQLite with `capability: 'image'`. */
  stored: boolean;
  /**
   * Switched on for image generation. A stored row is not enough: the LLM page
   * stores a provider's whole catalog (image models included), so only the
   * explicit `imageEnabled` flag means "usable for images".
   */
  enabled: boolean;
  /** The pi catalog entry, when this model ships with the app. */
  catalog?: CatalogModel;
}

/** A provider that can serve image models, whether or not it is configured yet. */
export interface ImageProviderView {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  /** Stored provider row; absent for providers that only exist in the catalog. */
  config?: ProviderConfig;
  hasKey: boolean;
  /** Built-in image models pi ships for this provider. */
  catalogImages: CatalogModel[];
  /** Everything the table shows: built-ins, stored overrides and hand-added ids. */
  images: ImageModelView[];
}

/**
 * Merges pi's built-in image catalog with the providers stored in SQLite.
 *
 * The Image page used to list only stored providers that already owned an
 * `image` model, which hid OpenRouter entirely: pi serves all 63 built-in image
 * models under `openrouter`, but the provider row only materialises once the
 * user edits it on the LLM page — and that import marks the models as `chat`.
 * Catalog-only providers (and their pending models) are therefore first-class
 * here, so they can be configured and picked without a separate import step.
 */
export function buildImageProviders(
  catalog: readonly CatalogProvider[],
  providers: readonly ProviderConfig[],
  displayName: (providerId: string) => string | undefined,
  options: { includeProviderId?: string } = {},
): ImageProviderView[] {
  const configured = new Map(providers.map((provider) => [provider.id, provider]));
  const seen = new Set<string>();
  const entries: ImageProviderView[] = [];

  for (const entry of catalog) {
    const config = configured.get(entry.id);
    const catalogImages = entry.models.filter((model) => model.type === 'image');
    const storedImages = (config?.models ?? []).filter((model) => model.capability === 'image');
    if (catalogImages.length === 0 && storedImages.length === 0) continue;

    const storedIds = new Set(storedImages.map((model) => model.id));
    const catalogIds = new Set(catalogImages.map((model) => model.id));

    entries.push({
      id: entry.id,
      name: config?.name ?? displayName(entry.id) ?? entry.id,
      baseUrl: config?.baseUrl || entry.baseUrl,
      api: pickProviderApi(entry, config),
      config,
      hasKey: config?.hasKey ?? false,
      catalogImages,
      images: [
        ...catalogImages.map((model) => ({
          id: model.id,
          name: model.name,
          api: model.api,
          stored: storedIds.has(model.id),
          enabled: storedImages.find((stored) => stored.id === model.id)?.imageEnabled === true,
          catalog: model,
        })),
        // Models added by hand (or returned by `/models`) that the catalog does
        // not know about still belong in the table.
        ...storedImages
          .filter((model) => !catalogIds.has(model.id))
          .map((model) => ({
            id: model.id,
            name: model.name,
            api: model.api,
            stored: true,
            enabled: model.imageEnabled === true,
          })),
      ],
    });
    seen.add(entry.id);
  }

  // Custom providers live only in our DB. List one only when it owns an image
  // model, or when it is the row just created on this page and still waiting for
  // its first model; otherwise a chat-only provider would show up here.
  for (const config of providers) {
    if (seen.has(config.id)) continue;
    const storedImages = config.models.filter((model) => model.capability === 'image');
    if (storedImages.length === 0 && config.id !== options.includeProviderId) continue;
    entries.push({
      id: config.id,
      name: config.name,
      baseUrl: config.baseUrl,
      api: config.api,
      config,
      hasKey: config.hasKey,
      catalogImages: [],
      images: storedImages.map((model) => ({
        id: model.id,
        name: model.name,
        api: model.api,
        stored: true,
        enabled: model.imageEnabled === true,
      })),
    });
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** Chat protocol first: image rows carry their own `api` anyway. */
function pickProviderApi(entry: CatalogProvider, config?: ProviderConfig): string {
  if (config) return config.api;
  return (
    entry.apis.find((api) => api === 'openai-completions' || api === 'anthropic-messages') ??
    entry.apis[0] ??
    'openai-completions'
  );
}

/** Turns a catalog image model into the stored shape. */
export function toImageModelOption(model: CatalogModel, imageEnabled = false): ModelOption {
  return {
    id: model.id,
    name: model.name,
    capability: 'image',
    api: model.api,
    contextWindow: model.contextWindow,
    vision: model.vision,
    reasoning: model.reasoning,
    inputUsdPerM: model.price?.input,
    outputUsdPerM: model.price?.output,
    cacheReadUsdPerM: model.price?.cacheRead,
    cacheWriteUsdPerM: model.price?.cacheWrite,
    imageEnabled,
    tiers: model.price?.tiers?.map((tier) => ({
      inputTokensAbove: tier.inputTokensAbove,
      inputUsdPerM: tier.input,
      outputUsdPerM: tier.output,
      cacheReadUsdPerM: tier.cacheRead,
      cacheWriteUsdPerM: tier.cacheWrite,
    })),
  };
}

/**
 * Import helper: keeps every stored model, upgrades ids the catalog knows to
 * `capability: 'image'` (a `/models` refresh may have stored them as chat), and
 * appends the remaining built-in ids.
 */
export function mergeImageModels(
  existing: readonly ModelOption[],
  catalogModels: readonly CatalogModel[],
): ModelOption[] {
  const builtins = new Map(catalogModels.map((model) => [model.id, model]));
  const merged = existing.map((model) => {
    const builtin = builtins.get(model.id);
    if (!builtin) return model;
    const converted = toImageModelOption(builtin, model.imageEnabled === true);
    return {
      ...model,
      name: converted.name,
      capability: 'image' as const,
      api: converted.api,
      contextWindow: converted.contextWindow ?? model.contextWindow,
      vision: converted.vision ?? model.vision,
      reasoning: converted.reasoning ?? model.reasoning,
    };
  });

  const present = new Set(existing.map((model) => model.id));
  for (const model of catalogModels) {
    if (!present.has(model.id)) merged.push(toImageModelOption(model));
  }
  return merged;
}
