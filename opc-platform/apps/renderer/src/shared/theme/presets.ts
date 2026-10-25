import type { BackgroundKind, FontFamilyId, FontScaleId } from './types';

export const FONT_FAMILIES: readonly { id: FontFamilyId; labelKey: string; sample: string }[] = [
  { id: 'system', labelKey: 'settings.font.system', sample: 'Aa 字体' },
  { id: 'inter', labelKey: 'settings.font.inter', sample: 'Aa Inter' },
  { id: 'noto', labelKey: 'settings.font.noto', sample: 'Aa 思源' },
  { id: 'serif', labelKey: 'settings.font.serif', sample: 'Aa 宋体' },
  { id: 'mono', labelKey: 'settings.font.mono', sample: 'Aa Mono' },
];

export const FONT_SCALES: readonly { id: FontScaleId; percent: number }[] = [
  { id: 'sm', percent: 90 },
  { id: 'md', percent: 100 },
  { id: 'lg', percent: 108 },
  { id: 'xl', percent: 116 },
];

export const BACKGROUND_KINDS: readonly { id: BackgroundKind; labelKey: string }[] = [
  { id: 'none', labelKey: 'settings.background.none' },
  { id: 'mesh', labelKey: 'settings.background.mesh' },
  { id: 'grid', labelKey: 'settings.background.grid' },
  { id: 'aurora', labelKey: 'settings.background.aurora' },
  { id: 'custom', labelKey: 'settings.background.custom' },
];

export const DEFAULT_FONT_SCALE: FontScaleId = 'md';
