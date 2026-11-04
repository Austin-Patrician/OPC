import { useCallback, useEffect, useState } from 'react';
import type { AppInfo } from '@opc/shared/ipc';
import type { ModelDefaults, ProviderConfig, Worker } from '@opc/shared/domain';

/**
 * Everything the guide shows that already exists in the product: the live
 * execution bodies, configured providers and the app version.
 *
 * Read-only: every write goes through the same bridge call the settings pages
 * use, and then this hook is reloaded, so the guide never invents state.
 *
 * The organisation tree used to be read here. It is gone (docs/v2/00-audit.md
 * §4): a fresh install seeds one executor, not a demo department. The talent
 * market went with it (§5.4): a personal assistant does not interview its
 * workers, it instantiates them.
 */
export interface OnboardingData {
  workers: Worker[];
  providers: ProviderConfig[];
  defaults: ModelDefaults;
  thinking: string;
  info: AppInfo | null;
}

const EMPTY: OnboardingData = {
  workers: [],
  providers: [],
  defaults: { llm: null, router: null, image: null, asr: null, tts: null, decision: null },
  thinking: 'medium',
  info: null,
};

export function useOnboardingData() {
  const [data, setData] = useState<OnboardingData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const bridge = window.opc;
    if (!bridge) {
      setLoading(false);
      return;
    }
    try {
      const [workers, providers, defaults, thinking, info] = await Promise.all([
        bridge.workers.list(),
        bridge.models.list(),
        bridge.models.getDefaults(),
        bridge.models.getThinking(),
        bridge.app.getInfo(),
      ]);
      setData({
        workers,
        providers,
        defaults,
        thinking,
        info,
      });
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  /** Cheap refresh after a limit change or a worker edit inside the guide. */
  const refreshWorkers = useCallback(async () => {
    const bridge = window.opc;
    if (!bridge) return;
    const workers = await bridge.workers.list();
    setData((previous) => ({ ...previous, workers }));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { ...data, workerCount: data.workers.length, loading, error, reload, refreshWorkers };
}
