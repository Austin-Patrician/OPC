import { useEffect, useState } from 'react';
import i18n from '@/shared/i18n';
import { useUiPrefs } from '@/shared/prefs/useUiPrefs';
import { applyTheme } from '@/shared/theme/applyTheme';

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

  useEffect(() => {
    applyTheme({ themeMode, fontFamilyId, fontScale, background }, { prefersDark });
  }, [themeMode, fontFamilyId, fontScale, background, prefersDark]);

  useEffect(() => {
    document.documentElement.lang = locale;
    if (i18n.resolvedLanguage !== locale) void i18n.changeLanguage(locale);
  }, [locale]);

  return null;
}
