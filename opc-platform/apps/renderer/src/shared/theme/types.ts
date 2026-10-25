export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export type FontFamilyId = 'system' | 'inter' | 'noto' | 'serif' | 'mono';
export type FontScaleId = 'sm' | 'md' | 'lg' | 'xl';

export type BackgroundKind = 'none' | 'mesh' | 'grid' | 'aurora' | 'custom';

export interface BackgroundPref {
  kind: BackgroundKind;
  /** Image or GIF URL (remote, `data:` or `blob:`); only used when kind === 'custom'. */
  url: string;
}

export interface AppearancePrefs {
  themeMode: ThemeMode;
  fontFamilyId: FontFamilyId;
  fontScale: FontScaleId;
  background: BackgroundPref;
}

/** Hard cap for user wallpapers stored in localStorage (2 MB ≈ 2.7 MB base64). */
export const MAX_BACKGROUND_BYTES = 2 * 1024 * 1024;
