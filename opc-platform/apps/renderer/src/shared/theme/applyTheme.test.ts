import { describe, expect, it } from 'vitest';
import { applyTheme, fontSizePercent, resolveTheme } from './applyTheme';
import type { AppearancePrefs } from './types';

const base: AppearancePrefs = {
  themeMode: 'system',
  fontFamilyId: 'system',
  fontScale: 'md',
  background: { kind: 'none', url: '' },
};

describe('resolveTheme', () => {
  it('follows the OS while mode is "system"', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('lets an explicit choice win over the OS', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});

describe('fontSizePercent', () => {
  it('maps every scale id to its CSS percentage', () => {
    expect(fontSizePercent('sm')).toBe(90);
    expect(fontSizePercent('md')).toBe(100);
    expect(fontSizePercent('lg')).toBe(108);
    expect(fontSizePercent('xl')).toBe(116);
  });
});

describe('applyTheme', () => {
  it('writes attributes and returns the resolved theme', () => {
    // Minimal element stub: the function only touches dataset/style.
    const root = { dataset: {}, style: {} } as unknown as HTMLElement;

    const resolved = applyTheme(
      { ...base, themeMode: 'dark', fontFamilyId: 'mono', fontScale: 'lg' },
      { root, prefersDark: false },
    );

    expect(resolved).toBe('dark');
    expect(root.dataset.theme).toBe('dark');
    expect(root.dataset.font).toBe('mono');
    expect(root.dataset.bg).toBe('none');
    expect(root.style.fontSize).toBe('108%');
  });
});
