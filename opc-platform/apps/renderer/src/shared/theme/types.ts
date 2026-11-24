export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export type FontFamilyId = 'inter' | 'jakarta' | 'serif' | 'noto' | 'mono' | 'system';
export type FontScaleId = 'sm' | 'md' | 'lg' | 'xl';

export type BackgroundKind = 'none' | 'mesh' | 'grid' | 'aurora' | 'custom';

export interface BackgroundPref {
  kind: BackgroundKind;
  /** Image or GIF URL (remote, `data:` or `blob:`); only used when kind === 'custom'. */
  url: string;
}

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
  /** null = automatic default corner (right: 24, bottom: 24). */
  position: BuddyPosition | null;
}

export interface AppearancePrefs {
  themeMode: ThemeMode;
  fontFamilyId: FontFamilyId;
  fontScale: FontScaleId;
  background: BackgroundPref;
}

/** Hard cap for user wallpapers stored in localStorage (2 MB ≈ 2.7 MB base64). */
export const MAX_BACKGROUND_BYTES = 2 * 1024 * 1024;
