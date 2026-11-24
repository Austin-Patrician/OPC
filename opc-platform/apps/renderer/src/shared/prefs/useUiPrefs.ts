import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Locale } from '@/shared/i18n/types';
import { DEFAULT_FONT_SCALE } from '@/shared/theme/presets';
import type { AppearancePrefs, BackgroundPref, BuddyCompanionPref } from '@/shared/theme/types';

export const UI_PREFS_STORAGE_KEY = 'opc.ui.v1';

const DEFAULT_BACKGROUND: BackgroundPref = { kind: 'none', url: '' };

const DEFAULT_BUDDY_COMPANION: BuddyCompanionPref = {
  enabled: true,
  size: 'md',
  dock: 'floating',
  bubbles: true,
  position: null,
};

export interface UiPrefsState extends AppearancePrefs {
  locale: Locale;
  buddyCompanion: BuddyCompanionPref;
  setThemeMode: (mode: AppearancePrefs['themeMode']) => void;
  setFontFamily: (id: AppearancePrefs['fontFamilyId']) => void;
  setFontScale: (id: AppearancePrefs['fontScale']) => void;
  setBackground: (background: BackgroundPref) => void;
  setLocale: (locale: Locale) => void;
  updateBuddyCompanion: (patch: Partial<BuddyCompanionPref>) => void;
  resetBuddyPosition: () => void;
  resetAppearance: () => void;
}

/**
 * UI-only preferences. Domain data never lives here: it belongs to the
 * transport/daemon so the web shell stays a thin view (see README §architecture).
 */
export const useUiPrefs = create<UiPrefsState>()(
  persist(
    (set) => ({
      themeMode: 'system',
      fontFamilyId: 'inter',
      fontScale: DEFAULT_FONT_SCALE,
      background: DEFAULT_BACKGROUND,
      locale: 'zh-CN',
      buddyCompanion: DEFAULT_BUDDY_COMPANION,

      setThemeMode: (themeMode) => set({ themeMode }),
      setFontFamily: (fontFamilyId) => set({ fontFamilyId }),
      setFontScale: (fontScale) => set({ fontScale }),
      setBackground: (background) => set({ background }),
      setLocale: (locale) => set({ locale }),
      updateBuddyCompanion: (patch) =>
        set((state) => ({
          buddyCompanion: { ...state.buddyCompanion, ...patch },
        })),
      resetBuddyPosition: () =>
        set((state) => ({
          buddyCompanion: { ...state.buddyCompanion, dock: 'floating', position: null },
        })),
      resetAppearance: () =>
        set({
          themeMode: 'system',
          fontFamilyId: 'inter',
          fontScale: DEFAULT_FONT_SCALE,
          background: DEFAULT_BACKGROUND,
          buddyCompanion: DEFAULT_BUDDY_COMPANION,
        }),
    }),
    {
      name: UI_PREFS_STORAGE_KEY,
      version: 2,
      storage: createJSONStorage(() => localStorage),
      // Functions are re-created on boot; persist data only.
      partialize: ({ themeMode, fontFamilyId, fontScale, background, locale, buddyCompanion }) => ({
        themeMode,
        fontFamilyId,
        fontScale,
        background,
        locale,
        buddyCompanion,
      }),
      migrate: (persisted, version) => {
        const state = (persisted as Partial<UiPrefsState> | undefined) ?? {};
        if (version < 2 && (!state.fontFamilyId || state.fontFamilyId === 'system')) {
          return { ...state, fontFamilyId: 'inter' };
        }
        return state;
      },
      merge: (persisted, current) => {
        const stored = (persisted as Partial<UiPrefsState> | undefined) ?? {};
        return {
          ...current,
          ...stored,
          buddyCompanion: {
            ...DEFAULT_BUDDY_COMPANION,
            ...(stored.buddyCompanion ?? {}),
          },
        };
      },
    },
  ),
);

export const selectAppearance = (state: UiPrefsState): AppearancePrefs => ({
  themeMode: state.themeMode,
  fontFamilyId: state.fontFamilyId,
  fontScale: state.fontScale,
  background: state.background,
});
