import type { FontFamilyId } from './types';

const loaded = new Set<string>();

function loadOnce(key: string, loader: () => Promise<unknown>): Promise<void> {
  if (loaded.has(key)) return Promise.resolve();
  loaded.add(key);
  return loader()
    .then(() => undefined)
    .catch(() => {
      loaded.delete(key);
    });
}

/** Loads the embedded variable font stylesheets required for a font preset. */
export function ensureFontLoaded(fontFamilyId: FontFamilyId): Promise<void> {
  switch (fontFamilyId) {
    case 'inter':
      return loadOnce('noto-sans-sc', () => import('@fontsource-variable/noto-sans-sc'));
    case 'jakarta':
      return Promise.all([
        loadOnce('plus-jakarta-sans', () => import('@fontsource-variable/plus-jakarta-sans')),
        loadOnce('noto-sans-sc', () => import('@fontsource-variable/noto-sans-sc')),
      ]).then(() => undefined);
    case 'noto':
      return loadOnce('noto-sans-sc', () => import('@fontsource-variable/noto-sans-sc'));
    case 'serif':
      return Promise.all([
        loadOnce('newsreader', () => import('@fontsource-variable/newsreader')),
        loadOnce('noto-serif-sc', () => import('@fontsource-variable/noto-serif-sc')),
      ]).then(() => undefined);
    case 'mono':
      return loadOnce('noto-sans-sc', () => import('@fontsource-variable/noto-sans-sc'));
    case 'system':
    default:
      return Promise.resolve();
  }
}

/** Preloads all embedded presets (used when opening Settings -> Appearance font cards). */
export function preloadAllFonts(): Promise<void> {
  return Promise.all([
    ensureFontLoaded('inter'),
    ensureFontLoaded('jakarta'),
    ensureFontLoaded('serif'),
  ]).then(() => undefined);
}
