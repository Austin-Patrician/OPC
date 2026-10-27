import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CornerDownLeft, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { BudgetView } from '@opc/shared/ipc';
import type { AgentCandidate } from '@opc/shared/domain';
import { brandColor, companyName } from '@/entities/company/model/options';
import { useCompanyProfile } from '@/entities/company/model/useCompany';
import { CompanyMark } from '@/entities/company/ui/CompanyMark';
import { useOnboarding, useOnboardingOpen } from '../model/onboardingStore';
import { useOnboardingData } from '../model/useOnboardingData';
import { AuroraBackdrop, Kbd } from './onboardingUi';
import { StepCompany } from './StepCompany';
import { StepDone, type DoneTarget } from './StepDone';
import { StepGeneral } from './StepGeneral';
import { StepModel } from './StepModel';
import { StepTeam } from './StepTeam';
import { WelcomeHero } from './WelcomeHero';

const VIEWS = ['general', 'model', 'company', 'team', 'done'] as const;
type ViewId = (typeof VIEWS)[number];

const ROUTES: Record<DoneTarget, string> = { chat: '/chat', org: '/org', settings: '/settings' };

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Mount point: renders nothing at all once the guide is done. */
export function OnboardingGuide() {
  const open = useOnboardingOpen();
  if (!open) return null;
  return <OnboardingDialog />;
}

/**
 * The first-run guide.
 *
 * Four real steps (preferences → model engine → company identity & budget →
 * hiring) and a summary. Every write goes through the same IPC the settings,
 * market and budget pages use, so nothing here is a staged fake: closing the
 * guide leaves a configured product behind.
 */
function OnboardingDialog() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const finish = useOnboarding((state) => state.finish);
  const dismiss = useOnboarding((state) => state.dismiss);
  const status = useOnboarding((state) => state.status);
  const profile = useCompanyProfile();
  const data = useOnboardingData();

  const [phase, setPhase] = useState<'welcome' | 'leaving' | 'wizard'>('welcome');
  const [step, setStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);
  const [direction, setDirection] = useState<'next' | 'prev'>('next');
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [hired, setHired] = useState<Record<string, string>>({});
  const [newHires, setNewHires] = useState<AgentCandidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [companyBudget, setCompanyBudget] = useState<BudgetView | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCompanyBudget(data.companyBudget);
  }, [data.companyBudget]);

  const currentId = VIEWS[step] as ViewId;
  const accent = brandColor(profile.colorId);
  const pending = data.candidates.filter((candidate) => selection[candidate.id] && !hired[candidate.id]);

  const go = useCallback((next: number) => {
    setDirection(next > step ? 'next' : 'prev');
    setStep(next);
    setMaxStep((current) => Math.max(current, next));
  }, [step]);

  const start = () => {
    setPhase('leaving');
    window.setTimeout(() => setPhase('wizard'), reducedMotion() ? 0 : 380);
  };

  const skipAll = () => finish('skipped');

  const complete = (target: DoneTarget) => {
    navigate(ROUTES[target]);
    finish('completed');
  };

  const back = () => (step === 0 ? setPhase('welcome') : go(step - 1));

  /** Commits the selected hires, then moves on. Failures keep the boss on the step. */
  const advance = async () => {
    if (busy) return;
    if (currentId === 'done') {
      complete('chat');
      return;
    }
    if (currentId === 'team' && pending.length > 0) {
      setBusy(true);
      setError(null);
      try {
        const committed: Record<string, string> = {};
        for (const candidate of pending) {
          const departmentId = selection[candidate.id]!;
          await window.opc!.market.hireCandidate(candidate.id, { departmentId });
          committed[candidate.id] = departmentId;
        }
        setHired((previous) => ({ ...previous, ...committed }));
        setNewHires((previous) => [...previous, ...pending]);
        await data.refreshOrgAndMarket();
        go(step + 1);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(false);
      }
      return;
    }
    go(step + 1);
  };

  // Reset scroll and hand focus to the content on every step change.
  useEffect(() => {
    if (phase !== 'wizard') return;
    scrollRef.current?.scrollTo({ top: 0 });
    if (!scrollRef.current?.contains(document.activeElement)) scrollRef.current?.focus({ preventScroll: true });
  }, [step, phase]);

  // Enter advances (ignoring IME composition and controls that own Enter); Escape goes back.
  const advanceRef = useRef(advance);
  advanceRef.current = advance;
  const backRef = useRef(back);
  backRef.current = back;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (
          tag === 'BUTTON' ||
          tag === 'SELECT' ||
          tag === 'TEXTAREA' ||
          tag === 'A' ||
          target?.getAttribute('role') === 'button'
        ) {
          return;
        }
        event.preventDefault();
        if (phase === 'welcome') start();
        else if (phase === 'wizard') void advanceRef.current();
      } else if (event.key === 'Escape' && phase === 'wizard' && tag !== 'INPUT' && tag !== 'SELECT') {
        backRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase]);

  const primaryLabel =
    currentId === 'done'
      ? t('onboarding.finish')
      : currentId === 'team' && pending.length > 0
        ? t('onboarding.hireAndContinue', { count: pending.length })
        : t('onboarding.next');

  const skipLabel = currentId === 'model' ? t('onboarding.laterConfig') : t('onboarding.skipStep');

  const content = (() => {
    switch (currentId) {
      case 'general':
        return <StepGeneral />;
      case 'model':
        return <StepModel />;
      case 'company':
        return (
          <StepCompany
            budget={companyBudget}
            departmentCount={data.departmentCount}
            agentCount={data.agentCount}
            onBudgetChange={setCompanyBudget}
          />
        );
      case 'team':
        return (
          <StepTeam
            departments={data.departments}
            candidates={data.candidates}
            agentCount={data.agentCount}
            selection={selection}
            onSelectionChange={setSelection}
            hired={hired}
            onCandidatesChange={data.setCandidates}
            onDepartmentsChange={data.refreshOrgAndMarket}
          />
        );
      case 'done':
        return (
          <StepDone
            departments={data.departments}
            agentCount={data.agentCount}
            providers={data.providers}
            defaults={data.defaults}
            thinking={data.thinking}
            budget={companyBudget}
            newHires={newHires}
            onAction={complete}
          />
        );
    }
  })();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('onboarding.ariaLabel')}
      className="onb-root fixed inset-0 z-[100] overflow-hidden bg-app text-ink select-none"
    >
      <AuroraBackdrop dimmed={phase === 'wizard'} accentFrom={accent.from} accentTo={accent.to} />

      {phase !== 'wizard' ? (
        <WelcomeHero
          departments={data.departments}
          candidates={data.candidates}
          providers={data.providers}
          agentCount={data.agentCount}
          leaving={phase === 'leaving'}
          onStart={start}
          onSkip={skipAll}
        />
      ) : (
        <div className="absolute inset-0 flex flex-col">
          <header className="onb-fade flex h-16 shrink-0 items-center justify-between px-8 lg:px-12">
            <div className="flex min-w-0 items-center gap-2.5">
              <CompanyMark name={companyName(profile, t('company.fallbackName'))} colorId={profile.colorId} src={profile.logo} size={28} />
              <span className="truncate text-md font-semibold tracking-tight text-ink">
                {companyName(profile, t('company.fallbackName'))}
              </span>
            </div>
            <button
              type="button"
              onClick={() => (status === 'pending' ? skipAll() : dismiss())}
              className="flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface/75 pr-3 pl-3.5 text-sm-plus text-ink-secondary transition-all hover:bg-surface hover:text-ink"
            >
              {t('onboarding.skip')}
              <X className="size-3.5" />
            </button>
          </header>

          <div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-8">
            <section className="onb-panel-in flex max-h-full w-full max-w-[52.5rem] flex-col overflow-hidden rounded-[1.75rem] border border-line bg-surface/95 shadow-[0_32px_90px_-24px_rgba(15,23,42,0.14),0_2px_8px_rgba(15,23,42,0.04)] backdrop-blur-2xl">
              <div ref={scrollRef} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none select-text">
                <div
                  key={step}
                  className={`px-9 pt-9 pb-8 sm:px-12 ${direction === 'next' ? 'onb-slide-next' : 'onb-slide-prev'}`}
                >
                  {content}
                </div>
              </div>

              <footer className="grid h-[4.25rem] shrink-0 grid-cols-3 items-center border-t border-line bg-surface/80 px-9 sm:px-12">
                <div className="flex items-center">
                  <button
                    type="button"
                    onClick={back}
                    className="flex h-9 cursor-pointer items-center gap-1.5 rounded-full pr-3.5 pl-2.5 text-base font-medium text-ink-secondary transition-colors hover:bg-ink/5 hover:text-ink"
                  >
                    <ArrowLeft className="size-4" />
                    {currentId === 'done'
                      ? t('onboarding.backToEdit')
                      : step === 0
                        ? t('onboarding.backHome')
                        : t('onboarding.back')}
                  </button>
                </div>

                <div className="flex items-center justify-center gap-2" role="tablist" aria-label={t('onboarding.stepNav')}>
                  {VIEWS.map((id, index) => {
                    const active = index === step;
                    const reachable = index <= maxStep && index !== step;
                    return (
                      <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        aria-label={t(`onboarding.step.${id}`)}
                        disabled={!reachable}
                        onClick={() => go(index)}
                        className={`h-2 rounded-full transition-all duration-300 ${
                          active
                            ? 'w-6 bg-accent'
                            : reachable
                              ? 'w-2 cursor-pointer bg-ink/20 hover:bg-ink/40'
                              : 'w-2 bg-ink/12'
                        }`}
                      />
                    );
                  })}
                </div>

                <div className="flex items-center justify-end gap-2.5">
                  {error ? (
                    <span className="hidden max-w-[14rem] truncate text-sm text-danger sm:inline">{error}</span>
                  ) : null}
                  {currentId !== 'done' ? (
                    <button
                      type="button"
                      onClick={() => go(step + 1)}
                      className="h-9 cursor-pointer rounded-full px-3 text-base text-ink-tertiary transition-colors hover:text-ink"
                    >
                      {skipLabel}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void advance()}
                    disabled={busy}
                    className="group flex h-10 cursor-pointer items-center gap-2 rounded-full bg-accent pr-4 pl-5 text-base-plus font-semibold text-white shadow-[0_10px_24px_-10px_color-mix(in_srgb,var(--accent)_65%,transparent)] transition-all hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
                  >
                    {primaryLabel}
                    <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                  </button>
                  <span className="hidden items-center text-xs text-ink-quaternary xl:flex">
                    <Kbd>
                      <CornerDownLeft className="size-3" />
                    </Kbd>
                  </span>
                </div>
              </footer>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
