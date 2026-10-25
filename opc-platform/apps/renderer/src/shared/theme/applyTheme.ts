import { FONT_SCALES } from './presets';
import type { AppearancePrefs, FontScaleId, ResolvedTheme, ThemeMode } from './types';

/** Pure: turns a preference + OS signal into the concrete theme to render. */
export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === 'system') return prefersDark ? 'dark' : 'light';
  return mode;
}

/** Pure: interface scale as a CSS percentage. Unknown ids fall back to 100%. */
export function fontSizePercent(scale: FontScaleId): number {
  return FONT_SCALES.find((item) => item.id === scale)?.percent ?? 100;
}

export interface ApplyThemeOptions {
  /** Element that owns the tokens; defaults to <html>. */
  root?: HTMLElement;
  prefersDark?: boolean;
}

/**
 * Writes appearance prefs onto the document as data attributes + one inline
 * font-size. Everything visual is CSS-driven from here, so theme switches never
 * re-render React trees.
 *
 * Returns the resolved theme so callers can show the real state of "system".
 */
export function applyTheme(
  prefs: AppearancePrefs,
  { root, prefersDark = false }: ApplyThemeOptions = {},
): ResolvedTheme {
  const target = root ?? document.documentElement;
  const theme = resolveTheme(prefs.themeMode, prefersDark);

  target.dataset.theme = theme;
  target.dataset.font = prefs.fontFamilyId;
  target.dataset.bg = prefs.background.kind;
  target.style.fontSize = `${fontSizePercent(prefs.fontScale)}%`;

  return theme;
}
