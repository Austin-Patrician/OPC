import { useEffect } from 'react';
import { create } from 'zustand';
import type { CompanyProfile, CompanyProfilePatch } from '@opc/shared/domain';
import { DEFAULT_BRAND_COLOR } from './options';

/**
 * The company profile, read from and written to the main process.
 *
 * Deliberately **not** persisted to localStorage: the `company` row is the source
 * of truth, so a second window, a database copy or a reinstall all see the same
 * identity. This store is a cache of `window.opc.company` plus the in-flight
 * optimistic value, nothing more.
 */
const PLACEHOLDER: CompanyProfile = {
  id: 'company-local',
  name: '',
  industry: '',
  vision: '',
  colorId: DEFAULT_BRAND_COLOR,
  bossName: '',
};

interface CompanyState {
  profile: CompanyProfile;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  load: () => Promise<void>;
  /** Optimistic: the UI shows the new value immediately, then the stored one. */
  update: (patch: CompanyProfilePatch) => Promise<void>;
}

/** Module-level so StrictMode's double effect and several consumers share one fetch. */
let inflight: Promise<void> | null = null;

export const useCompany = create<CompanyState>((set, get) => ({
  profile: PLACEHOLDER,
  status: 'idle',
  error: null,

  load: () => {
    if (inflight) return inflight;
    const bridge = window.opc?.company;
    if (!bridge) {
      set({ status: 'error', error: '未连接主进程' });
      return Promise.resolve();
    }

    set({ status: 'loading' });
    inflight = bridge
      .get()
      .then((profile) => set({ profile, status: 'ready', error: null }))
      .catch((caught: unknown) => {
        inflight = null;
        set({ status: 'error', error: caught instanceof Error ? caught.message : String(caught) });
      });
    return inflight;
  },

  update: async (patch) => {
    const bridge = window.opc?.company;
    if (!bridge) return;
    const previous = get().profile;
    set({ profile: { ...previous, ...patch }, error: null });
    try {
      const stored = await bridge.update(patch);
      set({ profile: stored, status: 'ready' });
    } catch (caught) {
      set({ profile: previous, error: caught instanceof Error ? caught.message : String(caught) });
    }
  },
}));

export const useCompanyProfile = () => useCompany((state) => state.profile);

/** Mount once (App): loads the profile and follows writes from other windows. */
export function useCompanySync(): void {
  const load = useCompany((state) => state.load);

  useEffect(() => {
    void load();
    const off = window.opc?.company.onChanged((profile) => useCompany.setState({ profile, status: 'ready' }));
    return () => off?.();
  }, [load]);
}
