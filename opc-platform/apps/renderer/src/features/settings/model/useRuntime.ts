import { useCallback, useEffect, useState } from 'react';
import type {
  RuntimeInspection,
  RuntimeKind,
  RuntimeProfileDraft,
  RuntimeSnapshot,
} from '@opc/shared/domain';

interface RuntimeViewState {
  snapshot: RuntimeSnapshot | null;
  loading: boolean;
  /** A forced re-detect is running (`--version` spawns). */
  probing: boolean;
  error: string | null;
}

/** Strips Electron's IPC wrapper so the settings page shows the real reason. */
function reasonOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

/**
 * Settings-scoped data access for the company base environment.
 *
 * `snapshot` reuses 60s-cached versions; an explicit 重新检测 clears that cache,
 * so the only spawn-heavy path is the settings page (never a tool call). There is
 * no global subscription: only this page cares.
 */
export function useRuntime() {
  const [state, setState] = useState<RuntimeViewState>({
    snapshot: null,
    loading: true,
    probing: false,
    error: null,
  });

  const bridge = window.opc?.runtime;

  const load = useCallback(
    async (probe = false) => {
      if (!bridge) {
        setState({
          snapshot: null,
          loading: false,
          probing: false,
          error: '当前环境没有运行时桥接（请用桌面应用启动）',
        });
        return;
      }
      setState((previous) => ({
        ...previous,
        loading: !probe,
        probing: probe,
        error: null,
      }));
      try {
        const snapshot = await (probe ? bridge.probe() : bridge.snapshot());
        setState({ snapshot, loading: false, probing: false, error: null });
      } catch (error) {
        setState((previous) => ({
          ...previous,
          loading: false,
          probing: false,
          error: reasonOf(error),
        }));
      }
    },
    [bridge],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const run = useCallback(
    async <T,>(action: () => Promise<T> | undefined): Promise<T | undefined> => {
      try {
        const result = await action();
        setState((previous) => ({ ...previous, error: null }));
        return result;
      } catch (error) {
        setState((previous) => ({ ...previous, error: reasonOf(error) }));
        return undefined;
      }
    },
    [],
  );

  const actions = {
    reload: (probe = false) => load(probe),
    setActive: (kind: RuntimeKind, profileId: string | null) =>
      run(async () => {
        if (!bridge) return undefined;
        const next = await bridge.setActive(kind, profileId);
        setState((previous) =>
          previous.snapshot ? { ...previous, snapshot: { ...previous.snapshot, ...next } } : previous,
        );
        return next;
      }),
    chooseBinary: (kind: RuntimeKind): Promise<string> =>
      bridge?.chooseBinary(kind) ?? Promise.resolve(''),
    inspect: (kind: RuntimeKind, binary: string): Promise<RuntimeInspection | undefined> =>
      run(() => bridge?.inspect(kind, binary)),
    /** Saving a custom profile makes it current; refresh + probe so its version shows. */
    saveProfile: (draft: RuntimeProfileDraft) =>
      run(async () => {
        if (!bridge) return undefined;
        const next = await bridge.saveProfile(draft);
        setState((previous) =>
          previous.snapshot ? { ...previous, snapshot: { ...previous.snapshot, ...next } } : previous,
        );
        await load(true);
        return next;
      }),
    removeProfile: (profileId: string) =>
      run(async () => {
        if (!bridge) return undefined;
        const next = await bridge.removeProfile(profileId);
        setState((previous) =>
          previous.snapshot ? { ...previous, snapshot: { ...previous.snapshot, ...next } } : previous,
        );
        return next;
      }),
  };

  return { ...state, ...actions };
}
