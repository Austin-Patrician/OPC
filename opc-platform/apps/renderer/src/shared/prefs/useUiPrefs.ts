import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Locale } from '@/shared/i18n/types';
import { DEFAULT_FONT_SCALE } from '@/shared/theme/presets';
import type { AppearancePrefs, BackgroundPref } from '@/shared/theme/types';

export const UI_PREFS_STORAGE_KEY = 'opc.ui.v1';

const DEFAULT_BACKGROUND: BackgroundPref = { kind: 'none', url: '' };

export interface UiPrefsState extends AppearancePrefs {
  locale: Locale;
  setThemeMode: (mode: AppearancePrefs['themeMode']) => void;
  setFontFamily: (id: AppearancePrefs['fontFamilyId']) => void;
  setFontScale: (id: AppearancePrefs['fontScale']) => void;
  setBackground: (background: BackgroundPref) => void;
  setLocale: (locale: Locale) => void;
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
      fontFamilyId: 'system',
      fontScale: DEFAULT_FONT_SCALE,
      background: DEFAULT_BACKGROUND,
      locale: 'zh-CN',

      setThemeMode: (themeMode) => set({ themeMode }),
      setFontFamily: (fontFamilyId) => set({ fontFamilyId }),
      setFontScale: (fontScale) => set({ fontScale }),
      setBackground: (background) => set({ background }),
      setLocale: (locale) => set({ locale }),
      resetAppearance: () =>
        set({
          themeMode: 'system',
          fontFamilyId: 'system',
          fontScale: DEFAULT_FONT_SCALE,
          background: DEFAULT_BACKGROUND,
        }),
    }),
    {
      name: UI_PREFS_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // Functions are re-created on boot; persist data only.
      partialize: ({ themeMode, fontFamilyId, fontScale, background, locale }) => ({
        themeMode,
        fontFamilyId,
        fontScale,
        background,
        locale,
      }),
    },
  ),
);

export const selectAppearance = (state: UiPrefsState): AppearancePrefs => ({
  themeMode: state.themeMode,
  fontFamilyId: state.fontFamilyId,
  fontScale: state.fontScale,
  background: state.background,
});
