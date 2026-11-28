import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Locale } from '@/shared/i18n/types';
import { DEFAULT_FONT_SCALE } from '@/shared/theme/presets';
import {
  DEFAULT_BACKGROUND_PREF,
  type AppearancePrefs,
  type BackgroundPref,
  type BuddyCompanionPref,
} from '@/shared/theme/types';

export const UI_PREFS_STORAGE_KEY = 'opc.ui.v1';

const DEFAULT_BUDDY_COMPANION: BuddyCompanionPref = {
  enabled: true,
  size: 'md',
  dock: 'floating',
  bubbles: true,
  desktopFloat: true,
  alwaysOnTop: true,
  position: null,
  screenPosition: null,
};

function sanitizeBackgroundPref(raw: unknown): BackgroundPref {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_BACKGROUND_PREF;
  const candidate = raw as Partial<BackgroundPref> & { surfaceStyle?: unknown };
  const hasAsset =
    candidate.kind === 'custom' &&
    typeof candidate.asset === 'object' &&
    candidate.asset !== null &&
    typeof candidate.asset.filename === 'string' &&
    candidate.asset.filename.length > 0;
  const cardOpacity =
    typeof candidate.cardOpacity === 'number' && Number.isFinite(candidate.cardOpacity)
      ? Math.min(0.95, Math.max(0, candidate.cardOpacity))
      : candidate.surfaceStyle === 'transparent'
        ? 0
        : DEFAULT_BACKGROUND_PREF.cardOpacity;
  return {
    kind: hasAsset ? 'custom' : 'none',
    asset: hasAsset ? candidate.asset! : null,
    scrimOpacity:
      typeof candidate.scrimOpacity === 'number' && Number.isFinite(candidate.scrimOpacity)
        ? Math.min(0.7, Math.max(0, candidate.scrimOpacity))
        : DEFAULT_BACKGROUND_PREF.scrimOpacity,
    blurPx:
      typeof candidate.blurPx === 'number' && Number.isFinite(candidate.blurPx)
        ? Math.min(12, Math.max(0, Math.round(candidate.blurPx)))
        : DEFAULT_BACKGROUND_PREF.blurPx,
    cardOpacity,
    pauseOnBlur:
      typeof candidate.pauseOnBlur === 'boolean'
        ? candidate.pauseOnBlur
        : DEFAULT_BACKGROUND_PREF.pauseOnBlur,
  };
}

export interface UiPrefsState extends AppearancePrefs {
  locale: Locale;
  buddyCompanion: BuddyCompanionPref;
  setThemeMode: (mode: AppearancePrefs['themeMode']) => void;
  setFontFamily: (id: AppearancePrefs['fontFamilyId']) => void;
  setFontScale: (id: AppearancePrefs['fontScale']) => void;
  setBackground: (background: BackgroundPref) => void;
  updateBackground: (patch: Partial<BackgroundPref>) => void;
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
      background: DEFAULT_BACKGROUND_PREF,
      locale: 'zh-CN',
      buddyCompanion: DEFAULT_BUDDY_COMPANION,

      setThemeMode: (themeMode) => set({ themeMode }),
      setFontFamily: (fontFamilyId) => set({ fontFamilyId }),
      setFontScale: (fontScale) => set({ fontScale }),
      setBackground: (background) => set({ background: sanitizeBackgroundPref(background) }),
      updateBackground: (patch) =>
        set((state) => ({
          background: sanitizeBackgroundPref({ ...state.background, ...patch }),
        })),
      setLocale: (locale) => set({ locale }),
      updateBuddyCompanion: (patch) =>
        set((state) => ({
          buddyCompanion: { ...state.buddyCompanion, ...patch },
        })),
      resetBuddyPosition: () =>
        set((state) => ({
          buddyCompanion: {
            ...state.buddyCompanion,
            dock: 'floating',
            position: null,
            screenPosition: null,
          },
        })),
      resetAppearance: () =>
        set({
          themeMode: 'system',
          fontFamilyId: 'inter',
          fontScale: DEFAULT_FONT_SCALE,
          background: DEFAULT_BACKGROUND_PREF,
          buddyCompanion: DEFAULT_BUDDY_COMPANION,
        }),
    }),
    {
      name: UI_PREFS_STORAGE_KEY,
      version: 3,
      storage: createJSONStorage(() => localStorage),
      // Functions are re-created on boot; persist data only (zero Base64 blobs).
      partialize: ({ themeMode, fontFamilyId, fontScale, background, locale, buddyCompanion }) => ({
        themeMode,
        fontFamilyId,
        fontScale,
        background: sanitizeBackgroundPref(background),
        locale,
        buddyCompanion,
      }),
      migrate: (persisted, version) => {
        const state = (persisted as Partial<UiPrefsState> | undefined) ?? {};
        const nextFont =
          version < 2 && (!state.fontFamilyId || state.fontFamilyId === 'system')
            ? 'inter'
            : state.fontFamilyId;
        const nextBg =
          version < 3 ? DEFAULT_BACKGROUND_PREF : sanitizeBackgroundPref(state.background);
        return {
          ...state,
          ...(nextFont ? { fontFamilyId: nextFont } : {}),
          background: nextBg,
        };
      },
      merge: (persisted, current) => {
        const stored = (persisted as Partial<UiPrefsState> | undefined) ?? {};
        return {
          ...current,
          ...stored,
          background: sanitizeBackgroundPref(stored.background),
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
