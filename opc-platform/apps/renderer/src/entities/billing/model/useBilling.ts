import { useEffect } from 'react';
import { create } from 'zustand';
import {
  DEFAULT_BILLING_SETTINGS,
  type BillingSettings,
  type BillingSettingsPatch,
} from '@opc/shared/domain';
import { formatMoney, type MoneyFormatOptions } from '@/shared/lib/money';

/**
 * Company-wide billing preferences: pricing policy, display currency and the
 * manual USD→CNY rate.
 *
 * Not persisted to localStorage: `app_setting` is the source of truth, so every
 * window and every reinstall see the same numbers. This store is a cache of
 * `window.opc.billing` plus the optimistic value while a write is in flight.
 */
interface BillingState {
  settings: BillingSettings;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  load: () => Promise<void>;
  update: (patch: BillingSettingsPatch) => Promise<void>;
}

/** Module-level so StrictMode's double effect and several consumers share one fetch. */
let inflight: Promise<void> | null = null;

export const useBilling = create<BillingState>((set, get) => ({
  settings: DEFAULT_BILLING_SETTINGS,
  status: 'idle',
  error: null,

  load: () => {
    if (inflight) return inflight;
    const bridge = window.opc?.billing;
    if (!bridge) {
      set({ status: 'error', error: '未连接主进程' });
      return Promise.resolve();
    }

    set({ status: 'loading' });
    inflight = bridge
      .get()
      .then((settings) => set({ settings, status: 'ready', error: null }))
      .catch((caught: unknown) => {
        inflight = null;
        set({ status: 'error', error: caught instanceof Error ? caught.message : String(caught) });
      });
    return inflight;
  },

  update: async (patch) => {
    const bridge = window.opc?.billing;
    if (!bridge) return;
    const previous = get().settings;
    // Optimistic: a segmented control must not wait on SQLite to repaint.
    set({ settings: { ...previous, ...patch }, error: null });
    try {
      const stored = await bridge.update(patch);
      set({ settings: stored, status: 'ready', error: null });
    } catch (caught) {
      set({
        settings: previous,
        error: caught instanceof Error ? caught.message : String(caught),
      });
    }
  },
}));

export const useBillingSettings = () => useBilling((state) => state.settings);

/**
 * `const money = useMoney()` then `money(line.spentUsd)`.
 *
 * A hook, not a module-level formatter, so a rate change repaints every number
 * currently on screen without a reload.
 */
export function useMoney(): (usd: number, options?: MoneyFormatOptions) => string {
  const settings = useBillingSettings();
  return (usd, options) => formatMoney(usd, settings, options);
}

/** Mount once (AppShell): load the settings and follow writes from other windows. */
export function useBillingSync(): void {
  const load = useBilling((state) => state.load);

  useEffect(() => {
    void load();
    const off = window.opc?.billing.onChanged((settings) =>
      useBilling.setState({ settings, status: 'ready', error: null }),
    );
    return () => off?.();
  }, [load]);
}
