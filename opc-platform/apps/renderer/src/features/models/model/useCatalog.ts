import { useEffect, useState } from 'react';
import type { CatalogProvider } from '@opc/shared/domain';

let cache: CatalogProvider[] | null = null;

/**
 * pi's built-in catalog (42 providers / ~1600 chat models / 63 image models).
 * Fetched once per session: the payload is large and never changes at runtime.
 */
export function useCatalog() {
  const [catalog, setCatalog] = useState<CatalogProvider[]>(cache ?? []);
  const [loading, setLoading] = useState(cache === null);

  useEffect(() => {
    if (cache) return;
    let alive = true;
    void window.opc?.models.getCatalog().then((value) => {
      if (!alive) return;
      cache = value;
      setCatalog(value);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  return { catalog, loading };
}
