import type { WallpaperAsset } from '@opc/shared/domain';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export type FontFamilyId = 'inter' | 'jakarta' | 'serif' | 'noto' | 'mono' | 'system';
export type FontScaleId = 'sm' | 'md' | 'lg' | 'xl';

export type BackgroundKind = 'none' | 'custom';

export interface BackgroundPref {
  kind: BackgroundKind;
  asset: WallpaperAsset | null;
  /** Pure light/dark optical scrim opacity (0 – 0.7). */
  scrimOpacity: number;
  /** Optional soft blur in pixels (0 = native crisp fidelity). */
  blurPx: number;
  /** Message bubble & card opacity (0 – 0.95; 0 = transparent text). */
  cardOpacity: number;
  /** Pause video/GIF decoding while the window is unfocused (default true). */
  pauseOnBlur: boolean;
}

export const DEFAULT_BACKGROUND_PREF: BackgroundPref = {
  kind: 'none',
  asset: null,
  scrimOpacity: 0.2,
  blurPx: 0,
  cardOpacity: 0.62,
  pauseOnBlur: true,
};

export const MAX_WALLPAPER_IMAGE_MB = 40;
export const MAX_WALLPAPER_VIDEO_MB = 150;

export type BuddySizeId = 'sm' | 'md' | 'lg';
export type BuddyDockMode = 'floating' | 'peek';

export interface BuddyPosition {
  /** Relative offset from right edge in pixels for resize-safe docking. */
  right: number;
  /** Relative offset from bottom edge in pixels for resize-safe docking. */
  bottom: number;
}

export interface BuddyCompanionPref {
  enabled: boolean;
  size: BuddySizeId;
  dock: BuddyDockMode;
  bubbles: boolean;
  /** Render as a standalone click-through desktop window draggable outside main window. */
  desktopFloat: boolean;
  /** Keep the floating companion above other desktop windows. */
  alwaysOnTop: boolean;
  /** null = automatic default corner (right: 24, bottom: 24) inside the main window. */
  position: BuddyPosition | null;
  /** Free desktop DIP top-left coordinates when dragged outside main window (`null` = anchored). */
  screenPosition: { x: number; y: number } | null;
}

export interface AppearancePrefs {
  themeMode: ThemeMode;
  fontFamilyId: FontFamilyId;
  fontScale: FontScaleId;
  background: BackgroundPref;
}
