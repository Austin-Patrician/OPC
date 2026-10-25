export interface CatalogPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: {
    inputTokensAbove: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  }[];
}

export interface CatalogModel {
  id: string;
  name: string;
  type: 'chat' | 'image' | 'classifier';
  api: string;
  contextWindow?: number;
  reasoning?: boolean;
  vision?: boolean;
  price?: CatalogPrice;
}

export interface CatalogProvider {
  id: string;
  baseUrl: string;
  /** Every API kind this provider's models use. */
  apis: string[];
  counts: { chat: number; image: number; classifier: number };
  models: CatalogModel[];
}

interface BuiltinModelLike {
  id: string;
  name?: string;
  api: string;
  baseUrl?: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: string[];
  cost?: CatalogPrice;
}

let cache: CatalogProvider[] | null = null;

/**
 * pi's entire built-in catalog, flattened for the settings UI.
 *
 * 42 providers, ~1600 chat models, 63 image models, 51 classifiers, 14 API kinds.
 * Everything the UI shows (names, context windows, prices incl. tiers) comes from
 * here, so "pi 内置的 provider" are all reachable instead of a curated subset.
 */
export async function getCatalog(): Promise<CatalogProvider[]> {
  if (cache) return cache;

  const { getBuiltinProviders, getBuiltinModels, getBuiltinImageModels, getBuiltinClassifierModels } =
    await import('@earendil-works/pi-ai/providers/all');

  const providers: CatalogProvider[] = [];

  for (const providerId of getBuiltinProviders()) {
    const safe = <T>(load: () => readonly T[]): readonly T[] => {
      try {
        return load();
      } catch {
        return [];
      }
    };

    const toModel = (model: BuiltinModelLike, type: CatalogModel['type']): CatalogModel => ({
      id: model.id,
      name: model.name ?? model.id,
      type,
      api: model.api,
      contextWindow: model.contextWindow,
      reasoning: model.reasoning,
      vision: model.input?.includes('image') ?? false,
      price: model.cost,
    });

    const chat = safe(() => getBuiltinModels(providerId)) as unknown as BuiltinModelLike[];
    const image = safe(() => getBuiltinImageModels(providerId)) as unknown as BuiltinModelLike[];
    const classifier = safe(() => getBuiltinClassifierModels(providerId)) as unknown as BuiltinModelLike[];

    if (chat.length === 0 && image.length === 0 && classifier.length === 0) continue;

    const models = [
      ...chat.map((model) => toModel(model, 'chat')),
      ...image.map((model) => toModel(model, 'image')),
      ...classifier.map((model) => toModel(model, 'classifier')),
    ];

    providers.push({
      id: providerId,
      baseUrl: chat[0]?.baseUrl ?? image[0]?.baseUrl ?? '',
      apis: Array.from(new Set(models.map((model) => model.api))).sort(),
      counts: { chat: chat.length, image: image.length, classifier: classifier.length },
      models,
    });
  }

  cache = providers.sort((a, b) => a.id.localeCompare(b.id));
  return cache;
}
