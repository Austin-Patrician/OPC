import type { ReactNode } from 'react';
import { ArrowRight, MessagesSquare, Palette, Settings2, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ModelDefaults, ProviderConfig } from '@opc/shared/domain';
import { useCompanyProfile } from '@/entities/company/model/useCompany';
import { useUiPrefs } from '@/shared/prefs/useUiPrefs';
import { THINKING_LEVELS, findProvider } from '@/shared/providers/catalog';
import { FONT_FAMILIES } from '@/shared/theme/presets';
import { BuddyMark } from '@/shared/ui/BuddyMark';
import { ProviderMark } from '@/shared/ui/ProviderMark';

export type DoneTarget = 'chat' | 'settings';

const ACTIONS: { target: DoneTarget; icon: typeof MessagesSquare; titleKey: string; subKey: string }[] = [
  {
    target: 'chat',
    icon: MessagesSquare,
    titleKey: 'onboarding.done.actionChat',
    subKey: 'onboarding.done.actionChatSub',
  },
  {
    target: 'settings',
    icon: Settings2,
    titleKey: 'onboarding.done.actionSettings',
    subKey: 'onboarding.done.actionSettingsSub',
  },
];

interface StepDoneProps {
  providers: ProviderConfig[];
  defaults: ModelDefaults;
  thinking: string;
  onAction: (target: DoneTarget) => void;
}

/** Live summary of profile, model engine, appearance, and desktop companion. */
export function StepDone({ providers, defaults, thinking, onAction }: StepDoneProps) {
  const { t } = useTranslation();
  const profile = useCompanyProfile();
  const prefs = useUiPrefs();

  const providerId = defaults.llm?.providerId;
  const provider = providerId ? providers.find((entry) => entry.id === providerId) : undefined;
  const model = provider?.models.find((entry) => entry.id === defaults.llm?.modelId);
  const design = providerId ? findProvider(providerId) : undefined;
  const thinkingLabel = THINKING_LEVELS.find((level) => level.value === thinking)?.label;
  const displayUser = profile.userName.trim() || t('company.userFallback');
  const fontEntry = FONT_FAMILIES.find((f) => f.id === prefs.fontFamilyId);

  return (
    <div className="relative">
      <div className="relative pt-1 text-center">
        <div className="onb-pop mx-auto flex justify-center">
          <BuddyMark size="xl" phase="completed" interactive />
        </div>

        <h2
          className="onb-fade-up mt-3 text-[1.625rem] leading-tight font-bold tracking-[-0.015em] text-ink"
          style={{ animationDelay: '0.15s' }}
        >
          {t('onboarding.done.title', { name: displayUser })}
        </h2>
        <p
          className="onb-fade-up mt-1.5 text-base text-ink-tertiary"
          style={{ animationDelay: '0.22s' }}
        >
          {t('onboarding.done.subtitle')}
        </p>
      </div>

      <div className="relative mt-7 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryCard label={t('onboarding.done.profileCard')} delay={0.28}>
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-muted text-accent-ink">
              <UserRound className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm-plus font-semibold text-ink">{displayUser}</div>
              <div className="truncate text-xs text-ink-tertiary">
                {t(`settings.company.tone.${profile.replyTone}`)} ·{' '}
                {t(`settings.company.detail.${profile.replyDetail}`)}
              </div>
            </div>
          </div>
        </SummaryCard>

        <SummaryCard label={t('onboarding.done.modelCard')} delay={0.34}>
          <div className="flex min-w-0 items-center gap-2.5">
            {providerId ? (
              <ProviderMark providerId={providerId} size="md" />
            ) : (
              <span className="size-9 shrink-0 rounded-lg border border-dashed border-line-strong bg-surface-muted" />
            )}
            <div className="min-w-0">
              <div className="truncate text-sm-plus font-semibold text-ink">
                {model?.name ?? t('onboarding.done.noModel')}
              </div>
              <div className="truncate text-xs text-ink-tertiary">
                {providerId
                  ? t('onboarding.done.modelLine', {
                      provider: provider?.name ?? design?.name ?? providerId,
                      thinking: thinkingLabel ?? thinking,
                    })
                  : t('onboarding.done.modelFallback')}
              </div>
            </div>
          </div>
        </SummaryCard>

        <SummaryCard label={t('onboarding.done.appearanceCard')} delay={0.4}>
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-muted text-accent-ink">
              <Palette className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm-plus font-semibold text-ink">
                {t(`settings.theme.${prefs.themeMode}`)} ·{' '}
                {fontEntry ? t(fontEntry.labelKey) : prefs.fontFamilyId}
              </div>
              <div className="truncate text-xs text-ink-tertiary">
                {prefs.buddyCompanion.enabled
                  ? t('onboarding.done.buddyOn')
                  : t('onboarding.done.buddyOff')}
              </div>
            </div>
          </div>
        </SummaryCard>
      </div>

      <div
        className="onb-fade-up relative mt-5 overflow-hidden rounded-2xl border border-line"
        style={{ animationDelay: '0.46s' }}
      >
        {ACTIONS.map(({ target, icon: Icon, titleKey, subKey }, index) => (
          <button
            key={target}
            type="button"
            onClick={() => onAction(target)}
            className={cnRow(index)}
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-ink">
              <Icon className="size-[1.125rem]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-base font-medium text-ink">{t(titleKey)}</span>
              <span className="block text-xs-plus text-ink-tertiary">{t(subKey)}</span>
            </span>
            <ArrowRight className="size-4 text-ink-quaternary transition-all group-hover:translate-x-0.5 group-hover:text-accent" />
          </button>
        ))}
      </div>
    </div>
  );
}

const cnRow = (index: number) =>
  `group flex w-full cursor-pointer items-center gap-3 bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-hover ${
    index ? 'border-t border-line' : ''
  }`;

function SummaryCard({
  label,
  delay,
  children,
}: {
  label: string;
  delay: number;
  children: ReactNode;
}) {
  return (
    <div
      className="onb-fade-up rounded-2xl border border-line bg-surface px-4 py-3.5"
      style={{ animationDelay: `${delay}s` }}
    >
      <div className="mb-2 text-xs font-medium text-ink-tertiary">{label}</div>
      {children}
    </div>
  );
}
