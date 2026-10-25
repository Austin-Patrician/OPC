import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LOCALES, type Locale } from '@/shared/i18n/types';
import { useUiPrefs } from '@/shared/prefs/useUiPrefs';
import { BACKGROUND_KINDS, FONT_FAMILIES, FONT_SCALES } from '@/shared/theme/presets';
import type { FontScaleId, ThemeMode } from '@/shared/theme/types';
import { cn } from '@/shared/lib/cn';
import { useRef } from 'react';
import { PageHeader, Row, Section, Segmented, SelectField } from '../kit';
import { MAX_BACKGROUND_BYTES } from '@/shared/theme/types';

const THEMES: { value: ThemeMode; labelKey: string }[] = [
  { value: 'system', labelKey: 'settings.theme.system' },
  { value: 'light', labelKey: 'settings.theme.light' },
  { value: 'dark', labelKey: 'settings.theme.dark' },
];

/** Miniature window used by the theme cards, matching the design's preview. */
function ThemePreview({ mode }: { mode: ThemeMode }) {
  const pane = (dark: boolean) => (
    <div className={cn('flex flex-1', dark ? 'bg-[#2C2C2E]' : 'bg-white')}>
      <div className={cn('w-[22%] border-r', dark ? 'border-[#3A3A3C] bg-[#1C1C1E]' : 'border-[#E5E5E7] bg-[#F2F2F3]')} />
      <div className="flex-1 space-y-1 p-1.5">
        <div className={cn('h-1.5 w-3/4 rounded-full', dark ? 'bg-[#48484A]' : 'bg-[#E5E5EA]')} />
        <div className={cn('h-1.5 w-1/2 rounded-full', dark ? 'bg-[#3A3A3C]' : 'bg-[#EFEFF1]')} />
        <div className="ml-auto h-1.5 w-2/5 rounded-full bg-accent/70" />
      </div>
    </div>
  );

  return (
    <div className="flex h-[58px] overflow-hidden rounded-lg border border-black/[0.08]">
      {mode === 'system' ? (
        <>
          {pane(false)}
          {pane(true)}
        </>
      ) : (
        pane(mode === 'dark')
      )}
    </div>
  );
}

/** Settings → 通用 → 外观与语言, 1:1 with the design's appearance section. */
export function AppearancePage() {
  const { t } = useTranslation();
  const prefs = useUiPrefs();
  const fileInput = useRef<HTMLInputElement>(null);

  const upload = (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_BACKGROUND_BYTES) {
      window.alert(t('settings.backgroundHint'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') prefs.setBackground({ kind: 'custom', url: reader.result });
    };
    reader.readAsDataURL(file);
  };

  return (
    <>
      <PageHeader
        crumbs={[t('settings.group.general'), t('settings.page.appearance')]}
        title={t('settings.page.appearance')}
        description={t('settings.subtitle')}
      />

      <div className="space-y-4">
        <Section title={t('settings.appearance')} description={t('settings.appearanceDesc')}>
          <div className="flex gap-3 px-4 py-4">
            {THEMES.map((theme) => {
              const active = prefs.themeMode === theme.value;
              return (
                <button
                  key={theme.value}
                  type="button"
                  onClick={() => prefs.setThemeMode(theme.value)}
                  aria-pressed={active}
                  className="group w-[8.25rem] cursor-pointer text-left"
                >
                  <div
                    className={cn(
                      'rounded-[10px] p-1 transition-shadow',
                      active ? 'ring-2 ring-accent' : 'ring-1 ring-transparent group-hover:ring-line-strong',
                    )}
                  >
                    <ThemePreview mode={theme.value} />
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5 text-sm">
                    <span
                      className={cn(
                        'flex size-3.5 items-center justify-center rounded-full',
                        active ? 'bg-accent text-white' : 'border border-line-strong',
                      )}
                    >
                      {active ? <Check className="size-2.5" strokeWidth={3} /> : null}
                    </span>
                    <span className={active ? 'font-medium text-ink' : 'text-ink-secondary'}>{t(theme.labelKey)}</span>
                  </div>
                </button>
              );
            })}
          </div>

          <Row label={t('settings.fontSize')} hint={t('settings.fontSizeHint')}>
            <Segmented<FontScaleId>
              label={t('settings.fontSize')}
              value={prefs.fontScale}
              onChange={prefs.setFontScale}
              options={FONT_SCALES.map((scale) => ({ value: scale.id, label: t(`settings.scale.${scale.id}`) }))}
            />
          </Row>

          <Row label={t('settings.font')} hint={t('settings.fontHint')}>
            <SelectField
              ariaLabel={t('settings.font')}
              value={prefs.fontFamilyId}
              onChange={(next) => prefs.setFontFamily(next as (typeof FONT_FAMILIES)[number]['id'])}
              className="w-[11rem]"
            >
              {FONT_FAMILIES.map((font) => (
                <option key={font.id} value={font.id}>
                  {t(font.labelKey)}
                </option>
              ))}
            </SelectField>
          </Row>
        </Section>

        <Section title={t('settings.background')} description={t('settings.backgroundHint')}>
          <Row label={t('settings.background')}>
            <SelectField
              ariaLabel={t('settings.background')}
              value={prefs.background.kind}
              onChange={(next) =>
                prefs.setBackground({ kind: next as (typeof BACKGROUND_KINDS)[number]['id'], url: prefs.background.url })
              }
              className="w-[11rem]"
            >
              {BACKGROUND_KINDS.map((kind) => (
                <option key={kind.id} value={kind.id}>
                  {t(kind.labelKey)}
                </option>
              ))}
            </SelectField>
          </Row>

          {prefs.background.kind === 'custom' ? (
            <Row label={t('settings.backgroundUrl')} hint={t('settings.backgroundHint')}>
              <div className="flex items-center gap-2">
                <input
                  value={prefs.background.url.startsWith('data:') ? '' : prefs.background.url}
                  onChange={(event) => prefs.setBackground({ kind: 'custom', url: event.target.value })}
                  placeholder="https://…"
                  aria-label={t('settings.backgroundUrl')}
                  className="h-[30px] w-[14rem] rounded-md border border-line bg-surface px-2.5 font-mono text-sm text-ink outline-none focus:border-accent"
                />
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  className="h-[30px] rounded-md border border-line px-2.5 text-sm text-ink-secondary hover:border-accent hover:text-accent"
                >
                  {t('settings.backgroundUpload')}
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(event) => upload(event.target.files?.[0])}
                />
              </div>
            </Row>
          ) : null}
        </Section>

        <Section title={t('settings.language')}>
          <Row label={t('settings.language')}>
            <SelectField
              ariaLabel={t('settings.language')}
              value={prefs.locale}
              onChange={(next) => prefs.setLocale(next as Locale)}
              className="w-[11rem]"
            >
              {LOCALES.map((locale) => (
                <option key={locale} value={locale}>
                  {t(`settings.language.${locale}`)}
                </option>
              ))}
            </SelectField>
          </Row>
        </Section>

        <div className="flex items-center justify-between border-t border-line pt-4">
          <button
            type="button"
            onClick={prefs.resetAppearance}
            className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-secondary transition-colors hover:border-accent hover:text-accent"
          >
            {t('settings.reset')}
          </button>
          <span className="text-2xs text-ink-quaternary">{t('settings.autoSave')}</span>
        </div>
      </div>
    </>
  );
}
