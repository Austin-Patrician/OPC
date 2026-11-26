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
 * Writes appearance prefs onto the document as data attributes and CSS custom
 * properties. Everything visual is CSS-driven from here, so theme/slider edits
 * never re-render the chat message tree.
 */
export function applyTheme(
  prefs: AppearancePrefs,
  { root, prefersDark = false }: ApplyThemeOptions = {},
): ResolvedTheme {
  const target = root ?? document.documentElement;
  const theme = resolveTheme(prefs.themeMode, prefersDark);
  const hasActiveBg = prefs.background.kind === 'custom' && Boolean(prefs.background.asset);
  const scrimOpacity = Math.min(0.7, Math.max(0, prefs.background.scrimOpacity));
  const blurPx = Math.min(12, Math.max(0, Math.round(prefs.background.blurPx)));
  const cardOpacity = Math.min(0.95, Math.max(0, prefs.background.cardOpacity));
  const cardPct = Math.round(cardOpacity * 100);
  const userBubblePct = cardPct <= 1 ? 38 : Math.min(92, cardPct + 6);
  const composerPct = Math.min(92, Math.max(54, cardPct + 10));
  const drawerPct = Math.min(92, Math.max(66, cardPct + 16));
  const cardBorderPct = Math.min(72, Math.max(20, Math.round(cardPct * 0.65)));

  target.dataset.theme = theme;
  target.dataset.font = prefs.fontFamilyId;
  target.dataset.bg = hasActiveBg ? 'custom' : 'none';
  target.dataset.bgSurface = cardPct <= 1 ? 'transparent' : 'card';
  target.style.fontSize = `${fontSizePercent(prefs.fontScale)}%`;
  target.style.setProperty('--wallpaper-scrim-opacity', scrimOpacity.toFixed(2));
  target.style.setProperty('--wallpaper-blur', `${blurPx}px`);
  target.style.setProperty('--wallpaper-card-pct', `${cardPct}%`);
  target.style.setProperty('--wallpaper-user-bubble-pct', `${userBubblePct}%`);
  target.style.setProperty('--wallpaper-composer-pct', `${composerPct}%`);
  target.style.setProperty('--wallpaper-drawer-pct', `${drawerPct}%`);
  target.style.setProperty('--wallpaper-card-border-pct', `${cardBorderPct}%`);

  return theme;
}
