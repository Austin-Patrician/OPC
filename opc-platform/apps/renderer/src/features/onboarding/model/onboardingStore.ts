import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * First-run guide state.
 *
 * `status` is the only persisted field: it answers "does this install still owe
 * the boss an onboarding". `reopened` is deliberately ephemeral — the settings
 * entry flips it for the current session and nothing about it survives a restart.
 */
export const ONBOARDING_STORAGE_KEY = 'opc.onboarding.v1';

export type OnboardingStatus = 'pending' | 'completed' | 'skipped';

interface OnboardingState {
  status: OnboardingStatus;
  reopened: boolean;
  /** Records the outcome of a run and closes the overlay. */
  finish: (status: Exclude<OnboardingStatus, 'pending'>) => void;
  /** Settings → 关于 → 重新查看新手引导. */
  reopen: () => void;
  /** Close the overlay without touching the recorded status. */
  dismiss: () => void;
}

export const useOnboarding = create<OnboardingState>()(
  persist(
    (set) => ({
      status: 'pending',
      reopened: false,

      finish: (status) =>
        // Closing a reopened guide must not downgrade an earlier completion.
        set((state) => ({ status: state.status === 'completed' ? 'completed' : status, reopened: false })),
      reopen: () => set({ reopened: true }),
      dismiss: () => set({ reopened: false }),
    }),
    {
      name: ONBOARDING_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ status }) => ({ status }),
    },
  ),
);

/** Visible while the install has never finished a run, or a session reopened it. */
export const useOnboardingOpen = () => useOnboarding((state) => state.reopened || state.status === 'pending');
