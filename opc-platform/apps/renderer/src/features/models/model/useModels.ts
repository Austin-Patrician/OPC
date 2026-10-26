import { useCallback, useEffect, useState } from 'react';
import type {
  CompactionSettings,
  ModelDefaults,
  ModelOption,
  ModelRef,
  ProviderConfig,
  ProviderDraft,
  ProviderTestResult,
} from '@opc/shared/domain';

interface ModelsState {
  providers: ProviderConfig[];
  defaults: ModelDefaults;
  compaction: CompactionSettings;
  thinking: string;
  loading: boolean;
  error: string | null;
}

/**
 * Settings-scoped data access. Unlike chat/work there is no global snapshot to
 * subscribe to: only this page cares about providers, so it fetches on mount and
 * after every mutation.
 */
export function useModels() {
  const [state, setState] = useState<ModelsState>({
    providers: [],
    defaults: { llm: null, image: null },
    compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000, backgroundTokens: 32_768 },
    thinking: 'medium',
    loading: true,
    error: null,
  });

  const bridge = window.opc?.models;

  const load = useCallback(async () => {
    if (!bridge) return;
    try {
      const [providers, defaults, compaction, thinking] = await Promise.all([
        bridge.list(),
        bridge.getDefaults(),
        bridge.getCompaction(),
        bridge.getThinking(),
      ]);
      setState({ providers, defaults, compaction, thinking, loading: false, error: null });
    } catch (error) {
      setState((previous) => ({
        ...previous,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [bridge]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (action: () => Promise<unknown> | undefined) => {
      try {
        await action();
        setState((previous) => ({ ...previous, error: null }));
      } catch (error) {
        setState((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        await load();
      }
    },
    [load],
  );

  const actions = {
    saveProvider: (draft: ProviderDraft) => run(() => bridge?.saveProvider(draft)),
    removeProvider: (providerId: string) => run(() => bridge?.removeProvider(providerId)),
    setKey: (providerId: string, apiKey: string) => run(() => bridge?.setKey(providerId, apiKey)),
    // Returns the outcome (ok/message/added) instead of void, so the page can report it.
    refreshModels: async (providerId: string) => {
      try {
        const result = await bridge?.refreshModels(providerId);
        setState((previous) => ({ ...previous, error: null }));
        return result;
      } catch (error) {
        setState((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : String(error),
        }));
        return undefined;
      }
    },
    addModel: (
      providerId: string,
      input: { id: string; name?: string; contextWindow?: number; api?: string },
    ) => run(() => bridge?.addModel(providerId, input)),
    supportsOauth: (providerId: string) => bridge?.supportsOauth(providerId) ?? Promise.resolve(false),
    setDefault: (role: 'llm' | 'image', ref: ModelRef | null) =>
      run(() => bridge?.setDefault(role, ref)),
    importFromPi: () => run(() => bridge?.importFromPi()),
    setModelContext: (providerId: string, modelId: string, contextWindow: number) =>
      run(() => bridge?.setModelContext(providerId, modelId, contextWindow)),
    setCompaction: (next: CompactionSettings) => run(() => bridge?.setCompaction(next)),
    setThinking: (level: string) => run(() => bridge?.setThinking(level)),
    setModels: (providerId: string, models: ModelOption[]) =>
      run(() => bridge?.setModels(providerId, models)),
    applyBuiltinPricing: (providerId: string) => run(() => bridge?.applyBuiltinPricing(providerId)),
    setModelPricing: (
      providerId: string,
      modelId: string,
      price: { input: number; output: number; cacheRead: number; cacheWrite: number },
    ) => run(() => bridge?.setModelPricing(providerId, modelId, price)),
  };

  const test = useCallback(
    async (providerId: string): Promise<ProviderTestResult> => {
      if (!bridge) return { ok: false, message: '未连接主进程' };
      const result = await bridge.test(providerId);
      await load();
      return result;
    },
    [bridge, load],
  );

  const modelsOf = (provider: ProviderConfig, capability: ModelOption['capability']) =>
    provider.models.filter((model) => model.capability === capability);

  return { ...state, ...actions, test, modelsOf };
}
