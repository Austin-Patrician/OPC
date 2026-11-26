import { describe, expect, it } from 'vitest';
import { applyTheme, fontSizePercent, resolveTheme } from './applyTheme';
import { DEFAULT_BACKGROUND_PREF, type AppearancePrefs } from './types';

const base: AppearancePrefs = {
  themeMode: 'system',
  fontFamilyId: 'system',
  fontScale: 'md',
  background: DEFAULT_BACKGROUND_PREF,
};

function makeRootStub() {
  const vars = new Map<string, string>();
  const root = {
    dataset: {} as Record<string, string>,
    style: {
      fontSize: '',
      setProperty: (key: string, value: string) => {
        vars.set(key, value);
      },
    },
  };
  return { root: root as unknown as HTMLElement, vars };
}

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
  it('writes attributes and CSS variables cleanly for inactive and active wallpapers', () => {
    const { root, vars } = makeRootStub();

    const resolved = applyTheme(
      { ...base, themeMode: 'dark', fontFamilyId: 'mono', fontScale: 'lg' },
      { root, prefersDark: false },
    );

    expect(resolved).toBe('dark');
    expect(root.dataset.theme).toBe('dark');
    expect(root.dataset.font).toBe('mono');
    expect(root.dataset.bg).toBe('none');
    expect(root.dataset.bgSurface).toBe('card');
    expect(root.style.fontSize).toBe('108%');
    expect(vars.get('--wallpaper-scrim-opacity')).toBe('0.20');
    expect(vars.get('--wallpaper-blur')).toBe('0px');
    expect(vars.get('--wallpaper-card-pct')).toBe('62%');
    expect(vars.get('--wallpaper-drawer-pct')).toBe('78%');

    applyTheme(
      {
        ...base,
        background: {
          kind: 'custom',
          asset: {
            filename: 'wp-123.mp4',
            originalName: 'demo.mp4',
            mediaKind: 'video',
            mimeType: 'video/mp4',
            bytes: 1024,
            importedAt: 1,
          },
          scrimOpacity: 0.36,
          blurPx: 6,
          cardOpacity: 0,
          pauseOnBlur: true,
        },
      },
      { root, prefersDark: true },
    );

    expect(root.dataset.bg).toBe('custom');
    expect(root.dataset.bgSurface).toBe('transparent');
    expect(vars.get('--wallpaper-scrim-opacity')).toBe('0.36');
    expect(vars.get('--wallpaper-blur')).toBe('6px');
    expect(vars.get('--wallpaper-card-pct')).toBe('0%');
    expect(vars.get('--wallpaper-user-bubble-pct')).toBe('38%');
    expect(vars.get('--wallpaper-drawer-pct')).toBe('66%');
  });
});
