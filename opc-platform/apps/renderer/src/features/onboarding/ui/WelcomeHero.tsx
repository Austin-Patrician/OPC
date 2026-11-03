import { useEffect, useRef, type PointerEvent } from 'react';
import {
  ArrowRight,
  BookOpen,
  CircleCheck,
  CornerDownLeft,
  Cpu,
  MessagesSquare,
  Sparkles,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ProviderConfig, Worker, WorkerTemplate } from '@opc/shared/domain';
import { Avatar } from '@/entities/agent/ui/Avatar';
import { LLM_PROVIDERS, PI_CHAT_PROVIDER_TOTAL } from '@/shared/providers/catalog';
import { userName, companyName } from '@/entities/company/model/options';
import { useCompanyProfile } from '@/entities/company/model/useCompany';
import { CompanyMark } from '@/entities/company/ui/CompanyMark';
import { ProviderMark } from '@/shared/ui/ProviderMark';
import { Kbd } from './onboardingUi';

interface WelcomeHeroProps {
  workers: Worker[];
  providers: ProviderConfig[];
  leaving: boolean;
  onStart: () => void;
  onSkip: () => void;
}

const FEATURED = ['anthropic', 'openai', 'google', 'deepseek'] as const;

/** Translated names for the three execution templates. */
const templateKey = (template: WorkerTemplate) => `onboarding.welcome.template.${template}`;

/**
 * The editorial welcome stage: hero copy, then a miniature of the real product.
 *
 * Everything in the miniature is read from live data — the executors that
 * actually exist and the providers you has configured — so the preview
 * cannot drift from the app behind it.
 */
export function WelcomeHero({
  workers,
  providers,
  leaving,
  onStart,
  onSkip,
}: WelcomeHeroProps) {
  const { t } = useTranslation();
  const profile = useCompanyProfile();
  const rootRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    startRef.current?.focus({ preventScroll: true });
  }, []);

  // Pointer position drives the parallax through CSS variables: no re-render.
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const element = rootRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    element.style.setProperty('--px', ((event.clientX - rect.left) / rect.width - 0.5).toFixed(3));
    element.style.setProperty('--py', ((event.clientY - rect.top) / rect.height - 0.5).toFixed(3));
  };

  const lead = workers[0];
  const second = workers[1];
  const skillCount = new Set(workers.flatMap((worker) => worker.skills)).size;
  const displayName = companyName(profile, t('company.fallbackName'));
  const user = userName(profile, t('company.userFallback'));
  const featured = LLM_PROVIDERS.filter((provider) => FEATURED.includes(provider.id as (typeof FEATURED)[number]));

  return (
    <div
      ref={rootRef}
      onPointerMove={onPointerMove}
      className={`absolute inset-0 flex flex-col text-ink ${leaving ? 'onb-exit' : ''}`}
    >
      <header className="onb-fade relative flex h-16 shrink-0 items-center justify-between px-8 lg:px-12">
        <div className="flex items-center gap-2.5">
          <CompanyMark name={displayName} colorId={profile.colorId} src={profile.logo} size={28} />
          <span className="text-md font-semibold tracking-tight text-ink">{displayName}</span>
          <span className="hidden text-sm text-ink-tertiary sm:inline">· {t('onboarding.welcome.brandTagline')}</span>
        </div>
        <button
          type="button"
          onClick={onSkip}
          className="flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface/70 pr-3 pl-3.5 text-sm-plus text-ink-secondary transition-all hover:bg-surface hover:text-ink"
        >
          {t('onboarding.skip')}
          <X className="size-3.5" />
        </button>
      </header>

      <main className="relative mx-auto flex min-h-0 w-full max-w-[75rem] flex-1 flex-col items-center justify-center px-6 pb-4 lg:px-12">
        <div className="mx-auto max-w-[42.5rem] text-center">
          <div className="onb-fade-up inline-flex h-7 items-center gap-2 rounded-full border border-line bg-surface/85 pr-3.5 pl-2.5 text-sm text-ink-secondary">
            <span className="onb-live-dot size-2 rounded-full bg-success" />
            <span className="font-medium text-ink">{t('onboarding.welcome.badgeTitle')}</span>
            <span className="h-3 w-px bg-line-strong" />
            <span className="text-ink-tertiary">{t('onboarding.welcome.badgeSub')}</span>
          </div>

          <h1
            className="onb-fade-up mt-5 text-[clamp(2.25rem,4.4vw,3.5rem)] leading-[1.08] font-bold tracking-[-0.03em] text-ink"
            style={{ animationDelay: '0.16s' }}
          >
            {t('onboarding.welcome.titleLead')}
            <span className="onb-gradient-text">{t('onboarding.welcome.titleAccent')}</span>
          </h1>

          <p
            className="onb-fade-up mx-auto mt-3.5 max-w-[33.75rem] text-lg leading-[1.7] text-ink-tertiary"
            style={{ animationDelay: '0.24s' }}
          >
            {t('onboarding.welcome.subtitleLead')}{' '}
            <code className="rounded bg-ink/5 px-1.5 py-0.5 font-mono text-base-plus text-ink">brief.md</code>
            {t('onboarding.welcome.subtitleTail')}
          </p>

          <div className="onb-fade-up mt-6 flex items-center justify-center gap-3" style={{ animationDelay: '0.32s' }}>
            <button
              ref={startRef}
              type="button"
              onClick={onStart}
              className="group relative flex h-11 cursor-pointer items-center gap-2 overflow-hidden rounded-full bg-accent pr-5 pl-6 text-md font-semibold text-white shadow-[0_14px_32px_-10px_color-mix(in_srgb,var(--accent)_55%,transparent)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-accent-hover focus-visible:ring-4 focus-visible:ring-accent/30 focus-visible:outline-none"
            >
              <span
                aria-hidden
                className="onb-shimmer absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/25 to-transparent"
              />
              <span className="relative">{t('onboarding.welcome.start')}</span>
              <ArrowRight className="relative size-4 transition-transform duration-200 group-hover:translate-x-0.5" />
            </button>
            <button
              type="button"
              onClick={onSkip}
              className="h-11 cursor-pointer rounded-full border border-line bg-surface/85 px-5 text-base-plus font-medium text-ink-secondary transition-all hover:bg-surface hover:text-ink"
            >
              {t('onboarding.welcome.skipToWorkspace')}
            </button>
          </div>

          <div
            className="onb-fade-up mt-3 flex items-center justify-center gap-1.5 text-xs-plus text-ink-tertiary"
            style={{ animationDelay: '0.38s' }}
          >
            <span>{t('onboarding.welcome.pressPrefix')}</span>
            <Kbd>
              <CornerDownLeft className="size-3" />
            </Kbd>
            <span>{t('onboarding.welcome.pressSuffix')}</span>
          </div>
        </div>

        {/* Miniature of the real workspace */}
        <div
          className="onb-fade-up relative mt-7 w-full max-w-[61.25rem] origin-top [@media(max-height:760px)]:mt-4 [@media(max-height:760px)]:scale-[0.92]"
          style={{ animationDelay: '0.44s', perspective: '1400px' }}
        >
          <div
            className="relative grid grid-cols-1 items-center gap-4 transition-transform duration-500 ease-out lg:grid-cols-[1fr_15rem]"
            style={{
              transformStyle: 'preserve-3d',
              transform: 'rotateX(calc(var(--py, 0) * -4deg)) rotateY(calc(var(--px, 0) * 5deg))',
            }}
          >
            {/* Centre: the IM workspace itself */}
            <div className="overflow-hidden rounded-[1.375rem] border border-line bg-surface/95 shadow-[0_28px_70px_-20px_rgba(15,23,42,0.16)] backdrop-blur-2xl">
              <div className="flex h-9 items-center justify-between border-b border-line bg-panel px-3.5">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="size-2.5 shrink-0 rounded-full border border-[#e0443e] bg-[#ff5f56]" />
                  <span className="size-2.5 shrink-0 rounded-full border border-[#dea123] bg-[#ffbd2e]" />
                  <span className="size-2.5 shrink-0 rounded-full border border-[#1aab29] bg-[#27c93f]" />
                  <span className="ml-2 truncate text-xs-plus font-semibold text-ink">
                    {t('onboarding.welcome.windowWorkspace')}
                  </span>
                </div>
                <span className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full bg-success/10 px-2 text-2xs font-medium text-success">
                  <span className="size-1.5 rounded-full bg-success" />
                  {t('onboarding.welcome.windowOnDuty', { count: workers.length })}
                </span>
              </div>

              <div className="space-y-3 bg-gradient-to-b from-surface to-surface-muted/40 p-4">
                <div className="flex items-start justify-end gap-2.5">
                  <div className="max-w-[20.625rem] rounded-2xl rounded-tr-sm bg-accent px-3.5 py-2 text-sm leading-relaxed text-white shadow-[0_4px_12px_-4px_color-mix(in_srgb,var(--accent)_55%,transparent)]">
                    {t('onboarding.welcome.founderMsg')}{' '}
                    <span className="underline decoration-white/60">brief.md</span>
                    {t('onboarding.welcome.founderMsgTail')}
                  </div>
                  <Avatar name={user} size="xs" className="size-7" />
                </div>

                {lead ? (
                  <div className="flex items-start gap-2.5">
                    <Avatar name={lead.name} size="xs" className="size-7" />
                    <div className="min-w-0 flex-1 rounded-2xl rounded-tl-sm border border-line bg-panel px-3.5 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs-plus font-semibold text-ink">{lead.name}</span>
                        <span className="rounded border border-line bg-surface px-1.5 text-3xs text-ink-tertiary">
                          {t(templateKey(lead.template))}
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-center justify-between gap-2 rounded-xl border border-line bg-surface px-3 py-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <CircleCheck className="size-4 shrink-0 text-success" />
                          <span className="truncate text-xs-plus font-medium text-ink">
                            {t('onboarding.welcome.agentReady')}
                          </span>
                        </div>
                        <span className="shrink-0 font-mono text-2xs text-accent-ink">
                          {lead.skills[0] ?? t(templateKey(lead.template))}
                        </span>
                      </div>
                    </div>
                  </div>
                ) : null}

                {second ? (
                  <div className="flex items-center justify-between px-1 pt-1 text-xs-plus text-ink-tertiary">
                    <div className="flex min-w-0 items-center gap-2">
                      <Avatar name={second.name} size="xs" className="!size-5" />
                      <span className="truncate">
                        {t('onboarding.welcome.waitingDispatch', {
                          name: second.name,
                          template: t(templateKey(second.template)),
                        })}
                      </span>
                    </div>
                    <span className="onb-typing flex shrink-0 items-center gap-[3px]">
                      <span className="size-1 rounded-full bg-accent" />
                      <span className="size-1 rounded-full bg-accent" />
                      <span className="size-1 rounded-full bg-accent" />
                    </span>
                  </div>
                ) : null}
              </div>
            </div>

            {/* Right: the pi model engine */}
            <div className="onb-float hidden lg:block" style={{ animationDuration: '7.5s', animationDelay: '-2.2s' }}>
              <div className="rounded-2xl border border-line bg-surface/90 p-4 shadow-[0_20px_48px_-16px_rgba(15,23,42,0.12)] backdrop-blur-xl">
                <div className="flex items-center justify-between text-xs font-semibold text-ink-tertiary">
                  <span className="inline-flex items-center gap-1.5 text-[#5B3DF5]">
                    <Cpu className="size-3.5" />
                    {t('onboarding.welcome.engineTitle')}
                  </span>
                  <span className="tabular-nums text-ink-quaternary">
                    {t('onboarding.welcome.engineAvailable', { count: PI_CHAT_PROVIDER_TOTAL })}
                  </span>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-1.5">
                  {featured.map((provider) => (
                    <div
                      key={provider.id}
                      className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-surface-muted/60 px-2.5 py-1.5"
                    >
                      <ProviderMark providerId={provider.id} />
                      <span className="truncate text-xs-plus font-medium text-ink">{provider.name}</span>
                    </div>
                  ))}
                </div>

                <div className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3 text-center">
                  <div>
                    <div className="text-lg font-bold tabular-nums text-ink">{workers.length}</div>
                    <div className="text-3xs text-ink-quaternary">{t('onboarding.welcome.statWorkers')}</div>
                  </div>
                  <div>
                    <div className="text-lg font-bold tabular-nums text-ink">{skillCount}</div>
                    <div className="text-3xs text-ink-quaternary">{t('onboarding.welcome.statSkills')}</div>
                  </div>
                  <div>
                    <div className="text-lg font-bold tabular-nums text-ink">{providers.length}</div>
                    <div className="text-3xs text-ink-quaternary">{t('onboarding.welcome.statConfigured')}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      <footer className="onb-fade relative flex h-12 shrink-0 items-center justify-center gap-6 text-sm text-ink-tertiary">
        <span className="inline-flex items-center gap-1.5">
          <MessagesSquare className="size-3.5 text-accent" />
          {t('onboarding.welcome.capIm')}
        </span>
        <span className="size-1 rounded-full bg-ink/15" />
        <span className="inline-flex items-center gap-1.5">
          <BookOpen className="size-3.5 text-[#5B3DF5]" />
          {t('onboarding.welcome.capBrief')}
        </span>
        <span className="size-1 rounded-full bg-ink/15" />
        <span className="inline-flex items-center gap-1.5">
          <Sparkles className="size-3.5 text-success" />
          {t('onboarding.welcome.capModel')}
        </span>
      </footer>
    </div>
  );
}
