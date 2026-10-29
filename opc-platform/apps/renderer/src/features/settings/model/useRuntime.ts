import { useCallback, useEffect, useState } from 'react';
import type {
  BundledRuntime,
  RuntimeInspection,
  RuntimeKind,
  RuntimeProfileDraft,
  RuntimeSnapshot,
} from '@opc/shared/domain';
import type { OcrSettings } from '@opc/shared/ocr';

interface RuntimeViewState {
  snapshot: RuntimeSnapshot | null;
  loading: boolean;
  /** A forced re-detect is running (`--version` spawns). */
  probing: boolean;
  /** Engines that ship with the app; `null` until the first read. */
  bundled: BundledRuntime[] | null;
  /** On/off and output shape of `ocr_image`; `null` until the first read. */
  ocr: OcrSettings | null;
  /** A switch or segmented control is being written back. */
  savingOcr: boolean;
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
    bundled: null,
    ocr: null,
    savingOcr: false,
    error: null,
  });

  const bridge = window.opc?.runtime;

  const load = useCallback(
    async (probe = false) => {
      if (!bridge) {
        setState((previous) => ({
          ...previous,
          snapshot: null,
          loading: false,
          probing: false,
          error: '当前环境没有运行时桥接（请用桌面应用启动）',
        }));
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
        setState((previous) => ({
          ...previous,
          snapshot,
          loading: false,
          probing: false,
          error: null,
        }));
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

  /**
   * One read is enough: the main process sizes the files and hashes them against
   * the manifest in the same pass, so the badge never says "fine" too early.
   */
  const readOcr = useCallback(async () => {
    if (!bridge?.bundled) return;
    try {
      const [bundled, ocr] = await Promise.all([bridge.bundled(), bridge.ocr()]);
      setState((previous) => ({ ...previous, bundled, ocr }));
    } catch (error) {
      setState((previous) => ({ ...previous, error: reasonOf(error) }));
    }
  }, [bridge]);

  useEffect(() => {
    void load(false);
    void readOcr();
  }, [load, readOcr]);

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
    /**
     * Apply immediately and keep the server's answer: the tool reads the same row
     * on its next call, so optimistic state would only hide a failed write.
     */
    setOcr: (next: OcrSettings) =>
      run(async () => {
        if (!bridge) return undefined;
        setState((previous) => ({ ...previous, savingOcr: true }));
        try {
          const saved = await bridge.setOcr(next);
          setState((previous) => ({ ...previous, ocr: saved }));
          return saved;
        } finally {
          setState((previous) => ({ ...previous, savingOcr: false }));
        }
      }),
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
