import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CornerDownLeft, X } from 'lucide-react';
import { AgentEmployee, CandidateAgent, Department, NavTab } from '../../types/im';
import { AuroraBackdrop, CompanyMark, Kbd } from './onboardingShared';
import { brandColor, companyDisplayName, onboardingStore, useOnboarding } from './onboardingStore';
import { StepCompany } from './StepCompany';
import { StepDone } from './StepDone';
import { StepGeneral } from './StepGeneral';
import { StepModel } from './StepModel';
import { StepTeam } from './StepTeam';
import { WelcomeHero } from './WelcomeHero';

const VIEWS = ['general', 'model', 'company', 'team', 'done'] as const;

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

interface OnboardingProps {
  agents: AgentEmployee[];
  departments: Department[];
  candidates: CandidateAgent[];
  onHire: (candidate: CandidateAgent, departmentId: string) => void;
  onNavigate: (tab: NavTab) => void;
}

export const Onboarding: React.FC<OnboardingProps> = ({ agents, departments, candidates, onHire, onNavigate }) => {
  const { company } = useOnboarding();
  const [phase, setPhase] = useState<'welcome' | 'leaving' | 'wizard'>('welcome');
  const [step, setStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);
  const [direction, setDirection] = useState<'next' | 'prev'>('next');
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [hired, setHired] = useState<Record<string, string>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  const currentId = VIEWS[step];
  const pending = useMemo(
    () => candidates.filter((c) => selection[c.id] && !hired[c.id]),
    [candidates, selection, hired]
  );
  const newHires = candidates.filter((c) => hired[c.id]);
  const companyMissing = currentId === 'company' && !company.name.trim();
  const color = brandColor(company.colorId);

  const start = () => {
    setPhase('leaving');
    window.setTimeout(() => setPhase('wizard'), reducedMotion() ? 0 : 380);
  };

  const skipAll = () => onboardingStore.finish('skipped');

  const complete = (tab: NavTab) => {
    onNavigate(tab);
    onboardingStore.finish('completed');
  };

  const go = (next: number) => {
    setDirection(next > step ? 'next' : 'prev');
    setStep(next);
    setMaxStep((m) => Math.max(m, next));
  };

  const back = () => (step === 0 ? setPhase('welcome') : go(step - 1));

  const advance = () => {
    if (companyMissing) return;
    if (currentId === 'done') return complete('im');
    if (currentId === 'team' && pending.length) {
      pending.forEach((c) => onHire(c, selection[c.id]));
      setHired((prev) => ({ ...prev, ...Object.fromEntries(pending.map((c) => [c.id, selection[c.id]])) }));
    }
    go(step + 1);
  };

  // Reset scroll and move focus to the content on every step change.
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
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229 || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'A' || target?.getAttribute('role') === 'button') return;
        e.preventDefault();
        if (phase === 'welcome') start();
        else if (phase === 'wizard') advanceRef.current();
      } else if (e.key === 'Escape' && phase === 'wizard' && tag !== 'INPUT' && tag !== 'SELECT') {
        backRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase]);

  const primaryLabel =
    currentId === 'done'
      ? '进入工作台'
      : currentId === 'team' && pending.length
        ? `聘用 ${pending.length} 名并继续`
        : '下一步';

  const content = (() => {
    switch (currentId) {
      case 'general':
        return <StepGeneral />;
      case 'model':
        return <StepModel />;
      case 'company':
        return <StepCompany />;
      case 'team':
        return (
          <StepTeam
            agents={agents}
            departments={departments}
            candidates={candidates}
            selection={selection}
            onSelectionChange={setSelection}
            hired={hired}
          />
        );
      case 'done':
        return <StepDone agents={agents} newHires={newHires} onAction={complete} />;
    }
  })();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="OPC 新手引导"
      className="onb-root fixed inset-0 z-[100] overflow-hidden select-none bg-[#F4F6FA] text-[#1C1C1E]"
    >
      <AuroraBackdrop dimmed={phase === 'wizard'} accentFrom={color.from} accentTo={color.to} />

      {phase !== 'wizard' ? (
        <WelcomeHero
          agents={agents}
          candidates={candidates}
          departmentCount={departments.length}
          leaving={phase === 'leaving'}
          onStart={start}
          onSkip={skipAll}
        />
      ) : (
        <div className="absolute inset-0 flex flex-col">
          {/* Minimal top bar */}
          <header className="h-16 shrink-0 px-8 lg:px-12 flex items-center justify-between onb-fade">
            <div className="flex items-center gap-2.5 min-w-0">
              <CompanyMark company={company} size={28} />
              <span className="text-[14px] font-semibold tracking-tight text-[#0B0C10] truncate">
                {companyDisplayName(company)}
              </span>
            </div>
            <button
              type="button"
              onClick={skipAll}
              className="h-8 pl-3.5 pr-3 rounded-full text-[12.5px] text-[#6E6E73] hover:text-[#1C1C1E] bg-white/75 hover:bg-white border border-black/[0.06] shadow-[0_1px_2px_rgba(0,0,0,0.03)] flex items-center gap-1.5 cursor-pointer transition-all"
            >
              跳过引导
              <X className="w-3.5 h-3.5" />
            </button>
          </header>

          {/* Centered single-card configuration canvas */}
          <div className="flex-1 min-h-0 flex items-center justify-center px-6 pb-8">
            <section className="onb-panel-in w-full max-w-[840px] max-h-full rounded-[28px] overflow-hidden flex flex-col bg-white/92 backdrop-blur-2xl shadow-[0_32px_90px_-24px_rgba(15,23,42,0.14),0_2px_8px_rgba(15,23,42,0.04)] ring-1 ring-black/[0.07]">
              <div ref={scrollRef} tabIndex={-1} className="flex-1 min-h-0 overflow-y-auto outline-none select-text">
                <div key={step} className={`px-9 sm:px-12 pt-9 pb-8 ${direction === 'next' ? 'onb-slide-next' : 'onb-slide-prev'}`}>
                  {content}
                </div>
              </div>

              {/* Bottom switching dock */}
              <footer className="h-[68px] shrink-0 border-t border-[#ECEEF2] bg-white/80 px-9 sm:px-12 grid grid-cols-3 items-center">
                <div className="flex items-center">
                  {currentId !== 'done' ? (
                    <button
                      type="button"
                      onClick={back}
                      className="h-9 pl-2.5 pr-3.5 rounded-full text-[13px] font-medium text-[#3A3A3C] hover:text-[#0B0C10] hover:bg-black/[0.05] flex items-center gap-1.5 cursor-pointer transition-colors"
                    >
                      <ArrowLeft className="w-4 h-4" />
                      {step === 0 ? '返回首页' : '上一步'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => go(step - 1)}
                      className="h-9 pl-2.5 pr-3.5 rounded-full text-[13px] font-medium text-[#6E6E73] hover:text-[#1C1C1E] hover:bg-black/[0.05] flex items-center gap-1.5 cursor-pointer transition-colors"
                    >
                      <ArrowLeft className="w-4 h-4" />
                      返回修改
                    </button>
                  )}
                </div>

                {/* Subtle dot switcher (no rigid step list) */}
                <div className="flex items-center justify-center gap-2" role="tablist" aria-label="配置页切换">
                  {VIEWS.map((id, i) => {
                    const active = i === step;
                    const reachable = i <= maxStep && i !== step;
                    return (
                      <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        aria-label={`第 ${i + 1} 页`}
                        disabled={!reachable}
                        onClick={() => go(i)}
                        className={`h-2 rounded-full transition-all duration-300 ${
                          active
                            ? 'w-6 bg-[#0B0C10]'
                            : i < step
                              ? 'w-2 bg-[#0099FF]/55 hover:bg-[#0099FF] cursor-pointer'
                              : reachable
                                ? 'w-2 bg-black/20 hover:bg-black/40 cursor-pointer'
                                : 'w-2 bg-black/12 cursor-default'
                        }`}
                      />
                    );
                  })}
                </div>

                <div className="flex items-center justify-end gap-2.5">
                  {companyMissing && <span className="text-[12px] text-[#8E8E93] hidden sm:inline">请先填写公司名称</span>}
                  {currentId !== 'done' && !companyMissing && (
                    <button
                      type="button"
                      onClick={() => go(step + 1)}
                      className="h-9 px-3 rounded-full text-[13px] text-[#8E8E93] hover:text-[#1C1C1E] cursor-pointer transition-colors"
                    >
                      {currentId === 'model' ? '稍后配置' : '跳过'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={advance}
                    disabled={companyMissing}
                    className="group h-10 pl-5 pr-4 rounded-full bg-[#0B0C10] hover:bg-[#1C1E26] text-white text-[13.5px] font-semibold flex items-center gap-2 cursor-pointer shadow-[0_10px_24px_-10px_rgba(11,12,16,0.5)] transition-all disabled:opacity-35 disabled:cursor-not-allowed disabled:shadow-none"
                  >
                    {primaryLabel}
                    <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
                  </button>
                  <span className="hidden xl:flex items-center text-[11px] text-[#AEAEB2]">
                    <Kbd>
                      <CornerDownLeft className="w-3 h-3" />
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
};
