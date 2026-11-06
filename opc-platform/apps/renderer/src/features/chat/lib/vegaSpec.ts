/** Reject remote data sources wherever Vega-Lite nests them in a spec. */
export function containsExternalVegaDataUrl(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsExternalVegaDataUrl);
  if (!value || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value)) {
    // Vega-Lite accepts remote URLs in ordinary and nested named datasets.
    // Reject any absolute URL field in a spec; local relative data remains usable.
    if (key === 'url' && typeof child === 'string' && /^(?:https?:)?\/\//i.test(child)) return true;
    if (containsExternalVegaDataUrl(child)) return true;
  }
  return false;
}
