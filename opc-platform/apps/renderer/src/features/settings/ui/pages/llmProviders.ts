import type { CatalogModel, CatalogProvider, ProviderConfig } from '@opc/shared/domain';
import { isLlmProvider } from '@opc/shared/domain';

/** Fallback group for providers pi ships but the design catalogue has no entry for. */
export const OTHER_GROUP = { id: 'other', label: '其他' };

/** One row in the LLM page's provider list. */
export interface DisplayProvider {
  id: string;
  name: string;
  group: string;
  baseUrl: string;
  apis: string[];
  /** Reused icon from the provider catalogue (custom providers only). */
  icon?: string;
  counts: { chat: number; image: number; classifier: number };
  models: CatalogModel[];
  description?: string;
}

/** Design-catalogue metadata the page already knows how to render. */
export interface ProviderMetaLookup {
  (providerId: string):
    | { name?: string; group?: string; description?: string }
    | undefined;
}

/**
 * Builds the provider list for Settings → Models → LLM.
 *
 * The LLM page is the **chat** page, so it lists a provider only when that
 * provider can actually serve a chat request:
 *
 * - catalog providers must ship at least one chat model. TypeSafe, for example,
 *   ships classifiers only — it belongs to Settings → Decision, and offering a
 *   key field for it here promised a model that can never answer a prompt.
 * - custom providers must not be owned by the Decision page (`scope`), and must
 *   not consist solely of classifier rows (rows written before `scope` existed).
 *
 * Everything the user typed — prices, context windows, hand-added ids — survives,
 * because stored rows the catalogue does not know are appended, not replaced.
 */
export function buildLlmProviders(
  catalog: readonly CatalogProvider[],
  providers: readonly ProviderConfig[],
  meta: ProviderMetaLookup,
): DisplayProvider[] {
  const configured = new Map(providers.map((provider) => [provider.id, provider]));

  const fromCatalog = catalog.flatMap<DisplayProvider>((entry) => {
    const design = meta(entry.id);
    // Stored models the pi catalogue does not know about (typically ids returned by
    // "拉取模型") still belong in the table, otherwise a refresh looks like a no-op.
    const stored = configured.get(entry.id);
    const catalogIds = new Set(entry.models.map((model) => model.id));
    const extra = (stored?.models ?? [])
      .filter((model) => !catalogIds.has(model.id))
      .map<CatalogModel>((model) => ({
        id: model.id,
        name: model.name || model.id,
        type: model.capability,
        api: model.api ?? entry.apis[0] ?? 'openai-completions',
        contextWindow: model.contextWindow,
        vision: model.vision,
        reasoning: model.reasoning,
        price: {
          input: model.inputUsdPerM ?? 0,
          output: model.outputUsdPerM ?? 0,
          cacheRead: model.cacheReadUsdPerM ?? 0,
          cacheWrite: model.cacheWriteUsdPerM ?? 0,
          tiers: model.tiers?.map((tier) => ({
            inputTokensAbove: tier.inputTokensAbove,
            input: tier.inputUsdPerM,
            output: tier.outputUsdPerM,
            cacheRead: tier.cacheReadUsdPerM,
            cacheWrite: tier.cacheWriteUsdPerM,
          })),
        },
      }));
    const chatCount = entry.counts.chat + extra.filter((model) => model.type === 'chat').length;
    if (chatCount === 0) return [];

    return [
      {
        id: entry.id,
        name: design?.name ?? entry.id,
        group: design?.group ?? OTHER_GROUP.id,
        baseUrl: entry.baseUrl,
        apis: entry.apis,
        icon: stored?.icon,
        counts: {
          chat: chatCount,
          image: entry.counts.image + extra.filter((model) => model.type === 'image').length,
          classifier:
            entry.counts.classifier + extra.filter((model) => model.type === 'classifier').length,
        },
        models: [...entry.models, ...extra],
        description: design?.description,
      },
    ];
  });

  // Custom providers exist only in our DB.
  const custom = providers
    .filter(
      (provider) =>
        provider.isCustom && isLlmProvider(provider) && !catalog.some((entry) => entry.id === provider.id),
    )
    .map<DisplayProvider>((provider) => ({
      id: provider.id,
      name: provider.name,
      group: OTHER_GROUP.id,
      baseUrl: provider.baseUrl,
      apis: [provider.api],
      icon: provider.icon,
      counts: {
        chat: provider.models.filter((model) => model.capability === 'chat').length,
        image: provider.models.filter((model) => model.capability === 'image').length,
        classifier: 0,
      },
      models: provider.models.map((model) => ({
        id: model.id,
        name: model.name,
        type: model.capability,
        api: model.api ?? provider.api,
        contextWindow: model.contextWindow,
        vision: model.vision,
        reasoning: model.reasoning,
        price: {
          input: model.inputUsdPerM ?? 0,
          output: model.outputUsdPerM ?? 0,
          cacheRead: model.cacheReadUsdPerM ?? 0,
          cacheWrite: model.cacheWriteUsdPerM ?? 0,
          tiers: model.tiers?.map((tier) => ({
            inputTokensAbove: tier.inputTokensAbove,
            input: tier.inputUsdPerM,
            output: tier.outputUsdPerM,
            cacheRead: tier.cacheReadUsdPerM,
            cacheWrite: tier.cacheWriteUsdPerM,
          })),
        },
      })),
    }));

  return [...fromCatalog, ...custom];
}
