import { useCallback, useEffect, useState } from 'react';
import type { AppInfo } from '@opc/shared/ipc';
import type { ModelDefaults, ProviderConfig } from '@opc/shared/domain';

export interface OnboardingData {
  providers: ProviderConfig[];
  defaults: ModelDefaults;
  thinking: string;
  info: AppInfo | null;
}

const EMPTY: OnboardingData = {
  providers: [],
  defaults: { llm: null, router: null, image: null, video: null, asr: null, tts: null, decision: null },
  thinking: 'medium',
  info: null,
};

/** Live model & app metadata used by the onboarding welcome stage and completion summary. */
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
      const [providers, defaults, thinking, info] = await Promise.all([
        bridge.models.list(),
        bridge.models.getDefaults(),
        bridge.models.getThinking(),
        bridge.app.getInfo(),
      ]);
      setData({ providers, defaults, thinking, info });
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { ...data, loading, error, reload };
}
