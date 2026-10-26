/**
 * Matching a provider's model ids to pi's built-in catalogue.
 *
 * Fetched ids rarely match pi's exactly: gateways prefix the vendor
 * (`openai/gpt-4o`), append a date (`gpt-4o-2024-08-06`), or drop it
 * (`claude-sonnet-4-5` vs `…-20250929`). Without normalisation "use official
 * pricing" silently fills nothing, which looks like a broken button.
 *
 * Matching is deliberately conservative: no guessing from names. When nothing
 * matches we return undefined and the caller reports the model as unmatched
 * instead of inventing a price.
 */

export interface BuiltinModelEntry {
  providerId: string;
  modelId: string;
  /** USD per 1M tokens. */
  inputUsdPerM: number;
  outputUsdPerM: number;
  cacheReadUsdPerM: number;
  cacheWriteUsdPerM: number;
  contextWindow?: number;
}

const DATE_SUFFIX = /-(?:\d{4}-\d{2}-\d{2}|\d{8}|\d{4})$/;
const VARIANT_SUFFIX = /-(?:latest|preview|beta|experimental|stable)$/;

export function normalizeModelId(id: string): string {
  let value = id.trim().toLowerCase();
  // `openai/gpt-4o` → `gpt-4o`; keep dots (gpt-4.1) and digits.
  const slash = value.lastIndexOf('/');
  if (slash >= 0) value = value.slice(slash + 1);
  // Azure-style deployment names: `gpt-4o@2024-08-06`.
  value = value.replace(/@\d{4}-\d{2}-\d{2}$/, '');
  // Provider-specific separators used by Bedrock/Vertex (`anthropic.claude-3-5-sonnet-v2:0`).
  value = value.replace(/^[a-z-]+\./, '').replace(/:\d+$/, '');
  value = value.replace(/-v\d+(?::\d+)?$/, '');
  for (let index = 0; index < 3; index += 1) value = value.replace(DATE_SUFFIX, '');
  value = value.replace(VARIANT_SUFFIX, '');
  return value;
}

export function matchBuiltinModel(
  entries: readonly BuiltinModelEntry[],
  target: { providerId: string; modelId: string },
): BuiltinModelEntry | undefined {
  const exact = entries.find(
    (entry) => entry.providerId === target.providerId && entry.modelId === target.modelId,
  );
  if (exact) return exact;

  const sameId = entries.find((entry) => entry.modelId === target.modelId);
  if (sameId) return sameId;

  const normalized = normalizeModelId(target.modelId);
  if (!normalized) return undefined;
  return entries.find((entry) => normalizeModelId(entry.modelId) === normalized);
}
