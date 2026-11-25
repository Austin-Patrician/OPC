import { Monitor, Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SelectField, Toggle } from '@/features/settings/ui/kit';
import { ThemePreview } from '@/features/settings/ui/pages/AppearancePage';
import { useUiPrefs } from '@/shared/prefs/useUiPrefs';
import { FONT_FAMILIES, FONT_SCALES } from '@/shared/theme/presets';
import type { FontFamilyId, FontScaleId, ThemeMode } from '@/shared/theme/types';
import { BuddyMark } from '@/shared/ui/BuddyMark';
import { Block, ChoiceCard, StepHeader } from './onboardingUi';

const THEMES: { value: ThemeMode; labelKey: string; icon: typeof Sun }[] = [
  { value: 'system', labelKey: 'settings.theme.system', icon: Monitor },
  { value: 'light', labelKey: 'settings.theme.light', icon: Sun },
  { value: 'dark', labelKey: 'settings.theme.dark', icon: Moon },
];

/**
 * Step 3: Theme, embedded typography, interface scale, and Buddy desktop companion switches.
 * Writes directly to `useUiPrefs`, matching Settings → 外观与语言.
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

      <div className="space-y-6">
        <Block title={t('onboarding.general.theme')} hint={t('onboarding.general.themeHint')}>
          <div className="grid grid-cols-3 gap-3">
            {THEMES.map(({ value, labelKey, icon: Icon }) => {
              const active = prefs.themeMode === value;
              return (
                <ChoiceCard
                  key={value}
                  selected={active}
                  onClick={() => prefs.setThemeMode(value)}
                  className="p-2.5"
                >
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

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Block title={t('onboarding.general.font')} hint={t('onboarding.general.fontHint')}>
            <div className="space-y-2.5 rounded-xl border border-line bg-surface p-3.5">
              <SelectField
                ariaLabel={t('onboarding.general.font')}
                value={prefs.fontFamilyId}
                onChange={(value) => prefs.setFontFamily(value as FontFamilyId)}
                className="w-full"
              >
                {FONT_FAMILIES.map((family) => (
                  <option key={family.id} value={family.id}>
                    {t(family.labelKey)}
                  </option>
                ))}
              </SelectField>
              <p className="rounded-lg bg-surface-muted/55 px-3 py-2 text-xs leading-relaxed text-ink-secondary">
                {t('onboarding.general.fontPreviewSample')}
              </p>
            </div>
          </Block>

          <Block title={t('onboarding.general.scale')} hint={t('onboarding.general.scaleHint')}>
            <div className="grid grid-cols-4 gap-2">
              {FONT_SCALES.map((scale) => {
                const active = prefs.fontScale === scale.id;
                return (
                  <ChoiceCard
                    key={scale.id}
                    selected={active}
                    onClick={() => prefs.setFontScale(scale.id as FontScaleId)}
                    className="px-2.5 py-3"
                    label={t(`settings.scale.${scale.id}`)}
                  >
                    <span className="block text-lg leading-none font-bold text-ink" aria-hidden>
                      Aa
                    </span>
                    <div className="mt-1.5 text-xs-plus font-medium text-ink">
                      {t(`settings.scale.${scale.id}`)}
                    </div>
                    <div className="text-2xs tabular-nums text-ink-quaternary">{scale.percent}%</div>
                  </ChoiceCard>
                );
              })}
            </div>
          </Block>
        </div>

        <Block title={t('onboarding.general.buddyTitle')} hint={t('onboarding.general.buddyHint')}>
          <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <BuddyMark size="sm" phase="idle" interactive showAura={false} showShadow={false} />
                <div className="min-w-0">
                  <div className="text-sm-plus font-medium text-ink">
                    {t('onboarding.general.buddyEnable')}
                  </div>
                  <div className="text-xs text-ink-tertiary">
                    {t('onboarding.general.buddyEnableHint')}
                  </div>
                </div>
              </div>
              <Toggle
                label={t('onboarding.general.buddyEnable')}
                checked={prefs.buddyCompanion.enabled}
                onChange={(checked) => prefs.updateBuddyCompanion({ enabled: checked })}
              />
            </div>

            {prefs.buddyCompanion.enabled ? (
              <div className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-ink">
                    {t('onboarding.general.buddyBubbles')}
                  </div>
                  <div className="text-xs text-ink-tertiary">
                    {t('onboarding.general.buddyBubblesHint')}
                  </div>
                </div>
                <Toggle
                  label={t('onboarding.general.buddyBubbles')}
                  checked={prefs.buddyCompanion.bubbles}
                  onChange={(checked) => prefs.updateBuddyCompanion({ bubbles: checked })}
                />
              </div>
            ) : null}
          </div>
        </Block>
      </div>
    </>
  );
}
