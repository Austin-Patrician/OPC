import { useEffect, useRef } from 'react';
import {
  ArrowRight,
  Brain,
  CornerDownLeft,
  MessagesSquare,
  ShieldCheck,
  Wrench,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { BuddyMark } from '@/shared/ui/BuddyMark';
import { Kbd } from './onboardingUi';

interface WelcomeHeroProps {
  leaving: boolean;
  onStart: () => void;
  onSkip: () => void;
}

/** Centered editorial welcome stage anchored by the living Polar Bear companion. */
export function WelcomeHero({ leaving, onStart, onSkip }: WelcomeHeroProps) {
  const { t } = useTranslation();
  const startRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    startRef.current?.focus({ preventScroll: true });
  }, []);

  const pillars = [
    {
      icon: MessagesSquare,
      title: t('onboarding.welcome.capChatTitle'),
      desc: t('onboarding.welcome.capChatDesc'),
    },
    {
      icon: Brain,
      title: t('onboarding.welcome.capMemoryTitle'),
      desc: t('onboarding.welcome.capMemoryDesc'),
    },
    {
      icon: Wrench,
      title: t('onboarding.welcome.capToolsTitle'),
      desc: t('onboarding.welcome.capToolsDesc'),
    },
    {
      icon: ShieldCheck,
      title: t('onboarding.welcome.capLocalTitle'),
      desc: t('onboarding.welcome.capLocalDesc'),
    },
  ];

  return (
    <div className={`absolute inset-0 flex flex-col text-ink ${leaving ? 'onb-exit' : ''}`}>
      <header className="onb-fade relative flex h-16 shrink-0 items-center justify-between px-8 lg:px-12">
        <div className="flex items-center gap-2.5">
          <BuddyMark size="xs" animated={false} showAura={false} showShadow={false} />
          <span className="text-md font-semibold tracking-tight text-ink">
            {t('onboarding.welcome.brandName')}
          </span>
          <span className="hidden text-sm text-ink-tertiary sm:inline">
            · {t('onboarding.welcome.brandTagline')}
          </span>
        </div>
        <button
          type="button"
          onClick={onSkip}
          className="flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface/75 pr-3 pl-3.5 text-sm-plus text-ink-secondary transition-all hover:bg-surface hover:text-ink"
        >
          {t('onboarding.skip')}
          <X className="size-3.5" />
        </button>
      </header>

      <main className="relative mx-auto flex min-h-0 w-full max-w-[68rem] flex-1 flex-col items-center justify-center px-6 pb-6 lg:px-12">
        {/* Living Buddy Centerpiece */}
        <div className="onb-fade-up relative flex items-center justify-center">
          <div
            aria-hidden
            className="pointer-events-none absolute size-[15rem] rounded-full bg-accent/12 blur-3xl"
          />
          <BuddyMark size="2xl" phase="idle" interactive showAura />
        </div>

        <div className="mx-auto mt-2 max-w-[40rem] text-center">
          <div
            className="onb-fade-up inline-flex h-7 items-center gap-2 rounded-full border border-line bg-surface/85 px-3 text-xs-plus text-ink-secondary"
            style={{ animationDelay: '0.08s' }}
          >
            <span className="onb-live-dot size-2 rounded-full bg-accent" />
            <span className="font-medium text-ink">{t('onboarding.welcome.badge')}</span>
          </div>

          <h1
            className="onb-fade-up mt-4 text-[clamp(2rem,4vw,3.125rem)] leading-[1.1] font-bold tracking-[-0.03em] text-ink"
            style={{ animationDelay: '0.14s' }}
          >
            {t('onboarding.welcome.titleLead')}
            <span className="text-accent-ink">{t('onboarding.welcome.titleAccent')}</span>
          </h1>

          <p
            className="onb-fade-up mx-auto mt-3.5 max-w-[33rem] text-md leading-relaxed text-ink-tertiary"
            style={{ animationDelay: '0.2s' }}
          >
            {t('onboarding.welcome.subtitle')}
          </p>

          <div
            className="onb-fade-up mt-6 flex flex-wrap items-center justify-center gap-3"
            style={{ animationDelay: '0.26s' }}
          >
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
            className="onb-fade-up mt-3 flex items-center justify-center gap-1.5 text-xs-plus text-ink-quaternary"
            style={{ animationDelay: '0.32s' }}
          >
            <span>{t('onboarding.welcome.pressPrefix')}</span>
            <Kbd>
              <CornerDownLeft className="size-3" />
            </Kbd>
            <span>{t('onboarding.welcome.pressSuffix')}</span>
          </div>
        </div>

        {/* Four concise system highlights */}
        <div
          className="onb-fade-up mt-8 grid w-full grid-cols-2 gap-3 lg:grid-cols-4"
          style={{ animationDelay: '0.38s' }}
        >
          {pillars.map(({ icon: Icon, title, desc }) => (
            <div
              key={title}
              className="rounded-2xl border border-line bg-surface/85 px-4 py-3.5 backdrop-blur-xl"
            >
              <div className="flex items-center gap-2">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-muted text-accent-ink">
                  <Icon className="size-3.5" />
                </span>
                <span className="truncate text-sm font-semibold text-ink">{title}</span>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-ink-tertiary">{desc}</p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
