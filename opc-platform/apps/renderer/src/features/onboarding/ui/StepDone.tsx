import type { CSSProperties, ReactNode } from 'react';
import { ArrowRight, MessagesSquare, Network, Settings2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BudgetView } from '@opc/shared/ipc';
import type { AgentCandidate, DepartmentNode, ModelDefaults, ProviderConfig } from '@opc/shared/domain';
import { Avatar } from '@/entities/agent/ui/Avatar';
import { THINKING_LEVELS, findProvider } from '@/shared/providers/catalog';
import { companyName } from '@/entities/company/model/options';
import { useCompanyProfile } from '@/entities/company/model/useCompany';
import { CompanyMark } from '@/entities/company/ui/CompanyMark';
import { ProviderMark } from '@/shared/ui/ProviderMark';
import { formatTokens } from './onboardingUi';

const CONFETTI_COLORS = ['#38B6FF', '#B49CFF', '#45E3CF', '#FFB86B', '#F0436A', '#34C759', '#FFD60A'];

const CONFETTI = Array.from({ length: 42 }, (_, index) => ({
  left: `${(index * 53 + 7) % 100}%`,
  width: 6 + (index % 3) * 1.5,
  height: index % 4 === 0 ? 6 + (index % 3) * 1.5 : 11 + (index % 4),
  round: index % 4 === 0,
  color: CONFETTI_COLORS[index % CONFETTI_COLORS.length],
  style: {
    '--onb-dx': `${((index * 37) % 120) - 60}px`,
    '--onb-rot': `${360 + ((index * 47) % 540)}deg`,
    '--onb-dur': `${2.4 + (index % 5) * 0.35}s`,
    '--onb-delay': `${(index % 12) * 0.06}s`,
  } as CSSProperties,
}));

export type DoneTarget = 'chat' | 'org' | 'settings';

const ACTIONS: { target: DoneTarget; icon: typeof MessagesSquare; titleKey: string; subKey: string }[] = [
  { target: 'chat', icon: MessagesSquare, titleKey: 'onboarding.done.actionChat', subKey: 'onboarding.done.actionChatSub' },
  { target: 'org', icon: Network, titleKey: 'onboarding.done.actionOrg', subKey: 'onboarding.done.actionOrgSub' },
  {
    target: 'settings',
    icon: Settings2,
    titleKey: 'onboarding.done.actionSettings',
    subKey: 'onboarding.done.actionSettingsSub',
  },
];

interface StepDoneProps {
  departments: DepartmentNode[];
  agentCount: number;
  providers: ProviderConfig[];
  defaults: ModelDefaults;
  thinking: string;
  budget: BudgetView | null;
  newHires: AgentCandidate[];
  onAction: (target: DoneTarget) => void;
}

/** Summary of what is now true in the database, then three real ways into the app. */
export function StepDone({
  departments,
  agentCount,
  providers,
  defaults,
  thinking,
  budget,
  newHires,
  onAction,
}: StepDoneProps) {
  const { t, i18n } = useTranslation();
  const profile = useCompanyProfile();

  const providerId = defaults.llm?.providerId;
  const provider = providerId ? providers.find((entry) => entry.id === providerId) : undefined;
  const model = provider?.models.find((entry) => entry.id === defaults.llm?.modelId);
  const design = providerId ? findProvider(providerId) : undefined;
  const thinkingLabel = THINKING_LEVELS.find((level) => level.value === thinking)?.label;
  const displayName = companyName(profile, t('company.fallbackName'));

  const roster = departments.flatMap((department) => department.members);

  return (
    <div className="relative">
      <div aria-hidden className="pointer-events-none absolute -inset-x-10 -top-9 h-[35rem] overflow-hidden">
        {CONFETTI.map((piece, index) => (
          <span
            key={index}
            className="onb-confetti absolute top-0"
            style={{
              ...piece.style,
              left: piece.left,
              width: piece.width,
              height: piece.height,
              background: piece.color,
              borderRadius: piece.round ? '50%' : 2,
            }}
          />
        ))}
      </div>

      <div className="relative pt-2 text-center">
        <div className="relative mx-auto size-[5.75rem]">
          <span
            aria-hidden
            className="onb-burst absolute inset-0 rounded-full border-2 border-success/50"
            style={{ animationDelay: '0.3s' }}
          />
          <span
            aria-hidden
            className="onb-burst absolute inset-0 rounded-full border-2 border-accent/40"
            style={{ animationDelay: '0.5s' }}
          />
          <div className="onb-pop absolute inset-0 flex items-center justify-center rounded-full bg-gradient-to-br from-[#4ADE80] to-[#0EA5E9] shadow-[0_18px_40px_-14px_rgba(14,165,233,0.8)]">
            <svg viewBox="0 0 48 48" className="size-12" aria-hidden>
              <path
                d="M14 25 L21 32 L35 17"
                fill="none"
                stroke="white"
                strokeWidth={4.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ strokeDasharray: 40, strokeDashoffset: 40, animation: 'onb-draw 0.5s ease-out 0.45s forwards' }}
              />
            </svg>
          </div>
        </div>
        <h2
          className="onb-fade-up mt-6 text-[1.75rem] leading-tight font-bold tracking-[-0.01em] text-ink"
          style={{ animationDelay: '0.2s' }}
        >
          {t('onboarding.done.title', { name: displayName })}
        </h2>
        <p className="onb-fade-up mt-2 text-base-plus text-ink-tertiary" style={{ animationDelay: '0.3s' }}>
          {t('onboarding.done.subtitle')}
        </p>
      </div>

      <div className="relative mt-8 grid grid-cols-3 gap-3">
        <SummaryCard label={t('onboarding.done.company')} delay={0.4}>
          <div className="flex min-w-0 items-center gap-2.5">
            <CompanyMark name={displayName} colorId={profile.colorId} src={profile.logo} size={36} />
            <div className="min-w-0">
              <div className="truncate text-base-plus font-semibold text-ink">{displayName}</div>
              <div className="truncate text-xs-plus text-ink-tertiary">
                {profile.vision.trim() ||
                  t('onboarding.done.budgetLine', {
                    limit: budget ? formatTokens(budget.limitTokens, i18n.language) : '—',
                  })}
              </div>
            </div>
          </div>
        </SummaryCard>

        <SummaryCard label={t('onboarding.done.model')} delay={0.48}>
          <div className="flex min-w-0 items-center gap-2.5">
            {providerId ? (
              <ProviderMark providerId={providerId} size="md" />
            ) : (
              <span className="size-9 shrink-0 rounded-lg border border-dashed border-line-strong bg-surface-muted" />
            )}
            <div className="min-w-0">
              <div className="truncate text-base-plus font-semibold text-ink">
                {model?.name ?? t('onboarding.done.autoPick')}
              </div>
              <div className="truncate text-xs-plus text-ink-tertiary">
                {providerId
                  ? t('onboarding.done.modelLine', {
                      provider: design?.name ?? providerId,
                      thinking: thinkingLabel ?? thinking,
                    })
                  : t('onboarding.done.modelFallback')}
              </div>
            </div>
          </div>
        </SummaryCard>

        <SummaryCard label={t('onboarding.done.team')} delay={0.56}>
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex shrink-0 -space-x-2">
              {newHires.slice(0, 3).map((candidate) => (
                <Avatar key={candidate.id} name={candidate.name} size="sm" className="ring-2 ring-surface" />
              ))}
              {roster
                .slice(0, Math.max(0, 3 - newHires.length))
                .map((member) => (
                  <Avatar
                    key={member.id}
                    name={member.name}
                    src={member.avatar || undefined}
                    size="sm"
                    className="ring-2 ring-surface"
                  />
                ))}
            </div>
            <div className="min-w-0">
              <div className="truncate text-base-plus font-semibold text-ink">
                {t('onboarding.done.agentsTotal', { count: agentCount })}
              </div>
              <div className="truncate text-xs-plus text-ink-tertiary">
                {newHires.length > 0
                  ? t('onboarding.done.newHires', { count: newHires.length })
                  : t('onboarding.done.noNewHires')}
              </div>
            </div>
          </div>
        </SummaryCard>
      </div>

      <div
        className="onb-fade-up relative mt-5 overflow-hidden rounded-2xl border border-line"
        style={{ animationDelay: '0.64s' }}
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

function SummaryCard({ label, delay, children }: { label: string; delay: number; children: ReactNode }) {
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
