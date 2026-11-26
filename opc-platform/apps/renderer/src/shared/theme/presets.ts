import type { FontFamilyId, FontScaleId } from './types';

export const FONT_FAMILIES: readonly { id: FontFamilyId; labelKey: string; sample: string }[] = [
  { id: 'inter', labelKey: 'settings.font.inter', sample: 'Aa Inter' },
  { id: 'jakarta', labelKey: 'settings.font.jakarta', sample: 'Aa Jakarta' },
  { id: 'serif', labelKey: 'settings.font.serif', sample: 'Aa 宋体' },
  { id: 'noto', labelKey: 'settings.font.noto', sample: 'Aa 思源' },
  { id: 'mono', labelKey: 'settings.font.mono', sample: 'Aa Mono' },
  { id: 'system', labelKey: 'settings.font.system', sample: 'Aa 系统' },
];

export const FONT_SCALES: readonly { id: FontScaleId; percent: number }[] = [
  { id: 'sm', percent: 90 },
  { id: 'md', percent: 100 },
  { id: 'lg', percent: 108 },
  { id: 'xl', percent: 116 },
];

export const DEFAULT_FONT_SCALE: FontScaleId = 'md';
