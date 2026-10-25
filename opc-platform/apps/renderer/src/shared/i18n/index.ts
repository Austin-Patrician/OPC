import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import enUS from './locales/en-US.json';
import zhCN from './locales/zh-CN.json';
import { DEFAULT_LOCALE, isLocale, LOCALES, type Locale } from './types';

export const resources = {
  'zh-CN': { translation: zhCN },
  'en-US': { translation: enUS },
} as const;

export const DEFAULT_NAMESPACE = 'translation';

/**
 * Reads the persisted locale synchronously so the first paint is already in the
 * right language (the appearance provider keeps it in sync afterwards).
 */
function readInitialLocale(): Locale {
  try {
    const raw = localStorage.getItem('opc.ui.v1');
    if (raw) {
      const state = (JSON.parse(raw) as { state?: { locale?: unknown } }).state;
      if (isLocale(state?.locale)) return state.locale;
    }
  } catch {
    /* private mode / blocked storage: fall through to detection */
  }

  const detected = typeof navigator !== 'undefined' ? navigator.language : '';
  return detected.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

void i18n.use(initReactI18next).init({
  resources,
  lng: readInitialLocale(),
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: [...LOCALES],
  defaultNS: DEFAULT_NAMESPACE,
  interpolation: { escapeValue: false },
  returnNull: false,
  react: { useSuspense: false },
});

export default i18n;
