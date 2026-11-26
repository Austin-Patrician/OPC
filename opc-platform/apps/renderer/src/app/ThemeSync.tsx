import { useEffect, useState } from 'react';
import i18n from '@/shared/i18n';
import { useUiPrefs } from '@/shared/prefs/useUiPrefs';
import { applyTheme } from '@/shared/theme/applyTheme';
import { ensureFontLoaded } from '@/shared/theme/fontLoader';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Single place where appearance prefs become DOM state. Theme switches touch
 * CSS variables only — no React re-render of the message tree, no layout thrash.
 */
export function ThemeSync() {
  const themeMode = useUiPrefs((state) => state.themeMode);
  const fontFamilyId = useUiPrefs((state) => state.fontFamilyId);
  const fontScale = useUiPrefs((state) => state.fontScale);
  const background = useUiPrefs((state) => state.background);
  const setBackground = useUiPrefs((state) => state.setBackground);
  const updateBackground = useUiPrefs((state) => state.updateBackground);
  const locale = useUiPrefs((state) => state.locale);

  const [prefersDark, setPrefersDark] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(DARK_QUERY).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  // Reconcile persisted UI metadata against disk wallpaper manifest once at boot.
  useEffect(() => {
    const bridge = window.opc?.wallpaper;
    if (!bridge) return undefined;
    let canceled = false;
    void bridge.getCurrent().then((diskAsset) => {
      if (canceled) return;
      const currentBg = useUiPrefs.getState().background;
      if (!diskAsset) {
        if (currentBg.kind !== 'none' || currentBg.asset !== null) {
          setBackground({ ...currentBg, kind: 'none', asset: null });
        }
        return;
      }
      if (currentBg.kind === 'custom') {
        updateBackground({ asset: diskAsset });
      }
    }).catch(() => undefined);
    return () => {
      canceled = true;
    };
  }, [setBackground, updateBackground]);

  useEffect(() => {
    void ensureFontLoaded(fontFamilyId);
    applyTheme({ themeMode, fontFamilyId, fontScale, background }, { prefersDark });
  }, [themeMode, fontFamilyId, fontScale, background, prefersDark]);

  useEffect(() => {
    document.documentElement.lang = locale;
    if (i18n.resolvedLanguage !== locale) void i18n.changeLanguage(locale);
  }, [locale]);

  return null;
}
