import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LOCALES, type Locale } from '@/shared/i18n/types';
import { useUiPrefs } from '@/shared/prefs/useUiPrefs';
import { BACKGROUND_KINDS, FONT_SCALES } from '@/shared/theme/presets';
import type { BackgroundKind, FontScaleId, ThemeMode } from '@/shared/theme/types';
import { ThemePreview } from '@/features/settings/ui/pages/AppearancePage';
import { cn } from '@/shared/lib/cn';
import { Block, ChoiceCard, StepHeader } from './onboardingUi';

const THEMES: { value: ThemeMode; labelKey: string; icon: typeof Sun }[] = [
  { value: 'system', labelKey: 'settings.theme.system', icon: Monitor },
  { value: 'light', labelKey: 'settings.theme.light', icon: Sun },
  { value: 'dark', labelKey: 'settings.theme.dark', icon: Moon },
];

/**
 * Real preferences only: the four blocks below write to the same store the
 * appearance settings page writes to, so changing something here is immediately
 * true everywhere — nothing is staged for later.
 */
export function StepGeneral() {
  const { t } = useTranslation();
  const prefs = useUiPrefs();

  return (
    <>
      <StepHeader
        eyebrow={t('onboarding.general.eyebrow')}
        title={t('onboarding.general.title')}
        description={t('onboarding.general.description')}
      />

      <div className="space-y-7">
        <Block title={t('onboarding.general.theme')} hint={t('onboarding.general.themeHint')}>
          <div className="grid grid-cols-3 gap-3">
            {THEMES.map(({ value, labelKey, icon: Icon }) => {
              const active = prefs.themeMode === value;
              return (
                <ChoiceCard key={value} selected={active} onClick={() => prefs.setThemeMode(value)} className="p-2.5">
                  <ThemePreview mode={value} />
                  <div className="mt-2.5 flex items-center gap-1.5 px-0.5 text-sm-plus font-medium text-ink">
                    <Icon className="size-3.5 text-ink-tertiary" />
                    {t(labelKey)}
                  </div>
                </ChoiceCard>
              );
            })}
          </div>
        </Block>

        <Block title={t('onboarding.general.scale')} hint={t('onboarding.general.scaleHint')}>
          <div className="grid grid-cols-4 gap-3">
            {FONT_SCALES.map((scale) => {
              const active = prefs.fontScale === scale.id;
              return (
                <ChoiceCard
                  key={scale.id}
                  selected={active}
                  onClick={() => prefs.setFontScale(scale.id as FontScaleId)}
                  className="px-3 py-3"
                  label={t(`settings.scale.${scale.id}`)}
                >
                  <span className="block text-xl leading-none font-bold text-ink" aria-hidden>
                    Aa
                  </span>
                  <div className="mt-2 flex items-center gap-1 text-sm-plus font-medium text-ink">
                    {t(`settings.scale.${scale.id}`)}
                  </div>
                  <div className="text-2xs tabular-nums text-ink-quaternary">{scale.percent}%</div>
                </ChoiceCard>
              );
            })}
          </div>
        </Block>

        <Block title={t('onboarding.general.background')} hint={t('onboarding.general.backgroundHint')}>
          <div className="flex flex-wrap gap-2">
            {BACKGROUND_KINDS.filter((kind) => kind.id !== 'custom').map((kind) => {
              const active = prefs.background.kind === kind.id;
              return (
                <button
                  key={kind.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => prefs.setBackground({ kind: kind.id as BackgroundKind, url: prefs.background.url })}
                  className={cn(
                    'flex h-9 cursor-pointer items-center gap-1.5 rounded-full border px-3.5 text-sm-plus transition-all',
                    active
                      ? 'border-accent bg-accent-soft font-medium text-accent-ink shadow-[0_0_0_3px_var(--accent-soft)]'
                      : 'border-line bg-surface text-ink-secondary hover:border-line-strong',
                  )}
                >
                  {active ? <Check className="size-3.5" strokeWidth={3} /> : null}
                  {t(kind.labelKey)}
                </button>
              );
            })}
          </div>
        </Block>

        <Block title={t('onboarding.general.language')} hint={t('onboarding.general.languageHint')}>
          <div className="grid grid-cols-2 gap-3">
            {LOCALES.map((locale) => (
              <ChoiceCard
                key={locale}
                selected={prefs.locale === locale}
                onClick={() => prefs.setLocale(locale as Locale)}
                className="px-3.5 py-3"
              >
                <div className="text-base-plus font-semibold text-ink">{t(`settings.language.${locale}`)}</div>
                <div className="mt-0.5 font-mono text-xs-plus text-ink-quaternary">{locale}</div>
              </ChoiceCard>
            ))}
          </div>
        </Block>
      </div>
    </>
  );
}
