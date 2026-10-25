import { useRef, type ReactNode } from 'react';
import { Download, Languages, Monitor, Moon, Sun, Type, Wallpaper } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LOCALES, type Locale } from '@/shared/i18n/types';
import { useUiPrefs } from '@/shared/prefs/useUiPrefs';
import { BACKGROUND_KINDS, FONT_FAMILIES, FONT_SCALES } from '@/shared/theme/presets';
import { MAX_BACKGROUND_BYTES } from '@/shared/theme/types';
import { cn } from '@/shared/lib/cn';

/**
 * All appearance controls in one place. Each control writes to the prefs store;
 * the theme sync effect translates that into data attributes, so nothing here
 * touches the DOM directly.
 */
export function AppearanceSettings() {
  const { t } = useTranslation();
  const fileInput = useRef<HTMLInputElement>(null);

  const themeMode = useUiPrefs((state) => state.themeMode);
  const fontFamilyId = useUiPrefs((state) => state.fontFamilyId);
  const fontScale = useUiPrefs((state) => state.fontScale);
  const background = useUiPrefs((state) => state.background);
  const locale = useUiPrefs((state) => state.locale);

  const setThemeMode = useUiPrefs((state) => state.setThemeMode);
  const setFontFamily = useUiPrefs((state) => state.setFontFamily);
  const setFontScale = useUiPrefs((state) => state.setFontScale);
  const setBackground = useUiPrefs((state) => state.setBackground);
  const setLocale = useUiPrefs((state) => state.setLocale);
  const resetAppearance = useUiPrefs((state) => state.resetAppearance);

  const uploadBackground = (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_BACKGROUND_BYTES) {
      window.alert(t('settings.backgroundHint'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setBackground({ kind: 'custom', url: reader.result });
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="space-y-6">
      <Section icon={<Sun className="size-4" />} title={t('settings.theme')}>
        <div className="flex flex-wrap gap-2">
          {(
            [
              { id: 'light', icon: Sun, labelKey: 'settings.theme.light' },
              { id: 'dark', icon: Moon, labelKey: 'settings.theme.dark' },
              { id: 'system', icon: Monitor, labelKey: 'settings.theme.system' },
            ] as const
          ).map(({ id, icon: Icon, labelKey }) => (
            <Choice
              key={id}
              active={themeMode === id}
              onClick={() => setThemeMode(id)}
              className="w-28"
            >
              <Icon className="size-4" />
              <span>{t(labelKey)}</span>
            </Choice>
          ))}
        </div>
      </Section>

      <Section icon={<Type className="size-4" />} title={t('settings.font')}>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {FONT_FAMILIES.map((font) => (
            <button
              key={font.id}
              type="button"
              onClick={() => setFontFamily(font.id)}
              className={cn(
                'flex items-center justify-between rounded-xl border px-3 py-2.5 text-left transition-colors',
                fontFamilyId === font.id
                  ? 'border-accent bg-accent-soft'
                  : 'border-line bg-surface hover:border-line-strong',
              )}
            >
              <span className="text-sm text-ink">{t(font.labelKey)}</span>
              <span className="text-xs text-ink-tertiary" style={{ fontFamily: 'var(--font-ui)' }}>
                {font.sample}
              </span>
            </button>
          ))}
        </div>
      </Section>

      <Section icon={<Type className="size-4" />} title={t('settings.fontSize')}>
        <div className="flex flex-wrap gap-2">
          {FONT_SCALES.map((scale) => (
            <Choice
              key={scale.id}
              active={fontScale === scale.id}
              onClick={() => setFontScale(scale.id)}
              className="w-24"
            >
              <span>{t(`settings.scale.${scale.id}`)}</span>
              <span className="text-xs text-ink-tertiary">{scale.percent}%</span>
            </Choice>
          ))}
        </div>
      </Section>

      <Section icon={<Wallpaper className="size-4" />} title={t('settings.background')}>
        <div className="flex flex-wrap gap-2">
          {BACKGROUND_KINDS.map((kind) => (
            <Choice
              key={kind.id}
              active={background.kind === kind.id}
              onClick={() => setBackground({ ...background, kind: kind.id })}
              className="w-32"
            >
              <span>{t(kind.labelKey)}</span>
            </Choice>
          ))}
        </div>

        {background.kind === 'custom' ? (
          <div className="space-y-2">
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={background.url.startsWith('data:') ? '' : background.url}
                onChange={(event) => setBackground({ kind: 'custom', url: event.target.value })}
                placeholder={t('settings.backgroundUrl')}
                aria-label={t('settings.backgroundUrl')}
                className="h-9 flex-1 rounded-lg border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className="flex h-9 items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm text-ink transition-colors hover:border-accent"
              >
                <Download className="size-3.5" />
                {t('settings.backgroundUpload')}
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                hidden
                onChange={(event) => uploadBackground(event.target.files?.[0])}
              />
            </div>
            <p className="text-xs text-ink-tertiary">{t('settings.backgroundHint')}</p>
          </div>
        ) : null}
      </Section>

      <Section icon={<Languages className="size-4" />} title={t('settings.language')}>
        <div className="flex flex-wrap gap-2">
          {LOCALES.map((item: Locale) => (
            <Choice
              key={item}
              active={locale === item}
              onClick={() => setLocale(item)}
              className="w-36"
            >
              <span>{t(`settings.language.${item}`)}</span>
            </Choice>
          ))}
        </div>
      </Section>

      <div className="flex items-center justify-between border-t border-line pt-4">
        <button
          type="button"
          onClick={resetAppearance}
          className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-secondary transition-colors hover:border-accent hover:text-accent"
        >
          {t('settings.reset')}
        </button>

        <div className="rounded-xl border border-line bg-surface px-4 py-2.5 shadow-card">
          <p className="mb-1 text-2xs text-ink-quaternary">{t('settings.preview')}</p>
          <p className="text-md text-ink">{t('settings.previewText')}</p>
        </div>
      </div>
    </div>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-2 text-base-plus font-semibold text-ink">
        <span className="text-accent">{icon}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

function Choice({
  active,
  onClick,
  children,
  className,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors',
        active
          ? 'border-accent bg-accent-soft text-accent-ink'
          : 'border-line bg-surface text-ink-secondary hover:border-line-strong',
        className,
      )}
    >
      {children}
    </button>
  );
}
