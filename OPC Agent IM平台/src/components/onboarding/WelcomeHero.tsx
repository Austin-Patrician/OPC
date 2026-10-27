import React, { useEffect, useRef } from 'react';
import {
  ArrowRight,
  BookOpen,
  CircleCheck,
  CornerDownLeft,
  Cpu,
  MessagesSquare,
  Sparkles,
  TrendingUp,
  UserPlus,
  X,
} from 'lucide-react';
import { AgentEmployee, CandidateAgent } from '../../types/im';
import { AvatarIcon } from '../AvatarIcon';
import { LLM_PROVIDERS, PI_CHAT_PROVIDER_TOTAL } from '../settings/piCatalog';
import { ProviderMark } from '../settings/settingsUi';
import { CompanyMark, Kbd } from './onboardingShared';
import { companyDisplayName, useOnboarding } from './onboardingStore';

interface WelcomeHeroProps {
  agents: AgentEmployee[];
  candidates: CandidateAgent[];
  departmentCount: number;
  leaving: boolean;
  onStart: () => void;
  onSkip: () => void;
}

export const WelcomeHero: React.FC<WelcomeHeroProps> = ({
  agents,
  candidates,
  departmentCount,
  leaving,
  onStart,
  onSkip,
}) => {
  const { company } = useOnboarding();
  const rootRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    startRef.current?.focus({ preventScroll: true });
  }, []);

  // Pointer position is written to CSS variables to drive parallax without re-rendering.
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty('--px', ((e.clientX - rect.left) / rect.width - 0.5).toFixed(3));
    el.style.setProperty('--py', ((e.clientY - rect.top) / rect.height - 0.5).toFixed(3));
  };

  const lead = agents[0];
  const secondAgent = agents[1] ?? agents[0];
  const newcomer = candidates[0];
  const featuredProviders = LLM_PROVIDERS.slice(0, 4);
  const [candName, candTitle] = (newcomer?.name ?? 'Justin · 爆款脚本总监').split('·');

  return (
    <div
      ref={rootRef}
      onPointerMove={onPointerMove}
      className={`absolute inset-0 flex flex-col text-[#1C1C1E] ${leaving ? 'onb-exit' : ''}`}
    >
      {/* Top bar */}
      <header className="relative h-16 px-8 lg:px-12 flex items-center justify-between shrink-0 onb-fade">
        <div className="flex items-center gap-2.5">
          <CompanyMark company={company} size={28} />
          <span className="text-[14px] font-semibold tracking-tight text-[#0B0C10]">{companyDisplayName(company)}</span>
          <span className="text-[12px] text-[#8E8E93] hidden sm:inline">· AI Agent 协作工作台</span>
        </div>
        <button
          type="button"
          onClick={onSkip}
          className="h-8 pl-3.5 pr-3 rounded-full flex items-center gap-1.5 text-[12.5px] text-[#6E6E73] hover:text-[#1C1C1E] bg-white/70 hover:bg-white border border-black/[0.06] shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-all cursor-pointer"
        >
          跳过引导
          <X className="w-3.5 h-3.5" />
        </button>
      </header>

      {/* Main centered editorial stage */}
      <main className="relative flex-1 min-h-0 flex flex-col items-center justify-center px-6 lg:px-12 pb-4 max-w-[1200px] w-full mx-auto">
        {/* Hero copy */}
        <div className="text-center max-w-[680px] mx-auto">
          <div
            className="onb-fade-up inline-flex items-center gap-2 h-7 pl-2.5 pr-3.5 rounded-full bg-white/85 border border-black/[0.07] shadow-[0_2px_8px_-2px_rgba(15,23,42,0.06)] text-[12px] text-[#3A3A3C]"
            style={{ animationDelay: '0.08s' }}
          >
            <span className="w-2 h-2 rounded-full bg-[#34C759] onb-live-dot" />
            <span className="font-medium text-[#1C1C1E]">OPC Workspace</span>
            <span className="w-px h-3 bg-black/10" />
            <span className="text-[#6E6E73]">原生一人公司 AI 团队操作系统</span>
          </div>

          <h1
            className="mt-5 text-[clamp(36px,4.4vw,56px)] leading-[1.08] font-bold tracking-[-0.03em] text-[#0B0C10] onb-fade-up"
            style={{ animationDelay: '0.16s' }}
          >
            一个人，
            <span className="onb-gradient-text">就是一家公司。</span>
          </h1>

          <p
            className="mt-3.5 text-[15px] leading-[1.7] text-[#6E6E73] max-w-[540px] mx-auto onb-fade-up"
            style={{ animationDelay: '0.24s' }}
          >
            招募各有所长的 AI Agent 员工，在熟悉的 IM 群聊里派单、协同与沉淀{' '}
            <code className="font-mono text-[13px] px-1.5 py-0.5 rounded bg-black/[0.045] text-[#1C1C1E]">brief.md</code>
            。只需几步轻巧设定，立即开启你的一人公司。
          </p>

          {/* CTA controls */}
          <div className="mt-6 flex items-center justify-center gap-3 onb-fade-up" style={{ animationDelay: '0.32s' }}>
            <button
              ref={startRef}
              type="button"
              onClick={onStart}
              className="group relative h-11 pl-6 pr-5 rounded-full bg-[#0B0C10] hover:bg-[#1C1E26] text-white text-[14px] font-semibold flex items-center gap-2 overflow-hidden cursor-pointer transition-all duration-200 shadow-[0_14px_32px_-10px_rgba(11,12,16,0.45),inset_0_1px_0_rgba(255,255,255,0.18)] hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#0099FF]/30"
            >
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/20 to-transparent onb-shimmer"
              />
              <span className="relative">开始配置</span>
              <ArrowRight className="relative w-4 h-4 transition-transform duration-200 group-hover:translate-x-0.5" />
            </button>
            <button
              type="button"
              onClick={onSkip}
              className="h-11 px-5 rounded-full text-[13.5px] font-medium text-[#3A3A3C] hover:text-[#0B0C10] bg-white/85 hover:bg-white border border-black/[0.08] shadow-[0_2px_6px_rgba(15,23,42,0.04)] transition-all cursor-pointer"
            >
              直接进入工作台
            </button>
          </div>

          <div
            className="mt-3 flex items-center justify-center gap-1.5 text-[11.5px] text-[#8E8E93] onb-fade-up"
            style={{ animationDelay: '0.38s' }}
          >
            <span>按</span>
            <Kbd>
              <CornerDownLeft className="w-3 h-3" />
            </Kbd>
            <span>开始 · 所有选项随时可在「设置」中调整</span>
          </div>
        </div>

        {/* Interactive miniature product stage */}
        <div
          className="relative mt-7 w-full max-w-[980px] [@media(max-height:760px)]:mt-4 [@media(max-height:760px)]:scale-[0.92] origin-top onb-fade-up"
          style={{ animationDelay: '0.44s', perspective: '1400px' }}
        >
          <div
            className="relative grid grid-cols-1 lg:grid-cols-[240px_1fr_240px] items-center gap-4 transition-transform duration-500 ease-out"
            style={{
              transformStyle: 'preserve-3d',
              transform: 'rotateX(calc(var(--py, 0) * -4deg)) rotateY(calc(var(--px, 0) * 5deg))',
            }}
          >
            {/* Left floating card: Talent Market & Quick Hire */}
            <div className="hidden lg:block onb-float" style={{ animationDuration: '7s' }}>
              <div className="rounded-2xl bg-white/90 backdrop-blur-xl border border-black/[0.07] shadow-[0_20px_48px_-16px_rgba(15,23,42,0.12)] p-4">
                <div className="flex items-center justify-between text-[11px] font-semibold text-[#6E6E73]">
                  <span className="inline-flex items-center gap-1.5 text-[#0077CC]">
                    <UserPlus className="w-3.5 h-3.5" />
                    人才市场 · 即招即用
                  </span>
                  <span className="px-1.5 py-0.5 rounded bg-[#F2F4F8] text-[#3A3A3C] tabular-nums">
                    {candidates.length} 位候选
                  </span>
                </div>

                {newcomer && (
                  <div className="mt-3 rounded-xl bg-[#F8F9FC] border border-[#ECEEF4] p-3">
                    <div className="flex items-center gap-2.5">
                      <img
                        src={newcomer.avatarUrl}
                        alt=""
                        draggable={false}
                        className="w-10 h-10 rounded-xl object-cover shrink-0 ring-1 ring-black/5"
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1">
                          <span className="text-[13px] font-bold text-[#1C1C1E] truncate">{candName}</span>
                          <span className="px-1.5 py-0.2 rounded bg-white border border-black/[0.06] text-[10px] font-semibold text-[#6E6E73]">
                            {newcomer.level}
                          </span>
                        </div>
                        <div className="text-[11px] text-[#6E6E73] truncate">{candTitle ?? newcomer.role}</div>
                      </div>
                    </div>
                    <div className="mt-2.5 flex items-center justify-between gap-1.5">
                      <span className="h-5 px-2 rounded-md bg-[#E9F8EC] text-[#1E8E35] text-[10.5px] font-medium inline-flex items-center gap-1 truncate">
                        <TrendingUp className="w-3 h-3 shrink-0" />
                        {newcomer.highlightMetric}
                      </span>
                      <span className="text-[10.5px] text-[#8E8E93] tabular-nums shrink-0">{newcomer.tokenCostPerDay}</span>
                    </div>
                  </div>
                )}

                <div className="mt-3 flex items-center justify-between text-[11px] text-[#6E6E73]">
                  <span className="inline-flex items-center gap-1">
                    <BookOpen className="w-3 h-3 text-[#8E8E93]" />
                    入职自动加载 brief.md
                  </span>
                  <span className="text-[#1E8E35] font-medium">● 就绪</span>
                </div>
              </div>
            </div>

            {/* Centerpiece: Miniature live OPC IM Workspace */}
            <div className="rounded-[22px] bg-white/95 backdrop-blur-2xl border border-black/[0.08] shadow-[0_28px_70px_-20px_rgba(15,23,42,0.16),0_2px_6px_rgba(15,23,42,0.04)] overflow-hidden">
              {/* Window chrome */}
              <div className="h-9 px-3.5 bg-[#F4F5F8] border-b border-black/[0.06] flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#FF5F56] border border-[#E0443E]" />
                  <span className="w-2.5 h-2.5 rounded-full bg-[#FFBD2E] border border-[#DEA123]" />
                  <span className="w-2.5 h-2.5 rounded-full bg-[#27C93F] border border-[#1AAB29]" />
                  <span className="ml-2 text-[11.5px] font-semibold text-[#1C1C1E]">短视频内容部 · 部门协同群</span>
                </div>
                <span className="inline-flex items-center gap-1.5 h-5 px-2 rounded-full bg-[#E9F8EC] text-[#1E8E35] text-[10.5px] font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#34C759]" />
                  {agents.length} 名 Agent 在岗
                </span>
              </div>

              {/* Workspace body */}
              <div className="p-4 space-y-3 bg-gradient-to-b from-white to-[#FAFBFD]">
                {/* Founder dispatch */}
                <div className="flex items-start justify-end gap-2.5">
                  <div className="max-w-[330px] rounded-2xl rounded-tr-sm bg-[#0099FF] text-white px-3.5 py-2 text-[12px] leading-relaxed shadow-[0_4px_12px_-4px_rgba(0,153,255,0.45)]">
                    @全体 出一版新品 30s 种草脚本与分镜，按最新 <span className="underline decoration-white/60">brief.md</span> 规范走。
                  </div>
                  <AvatarIcon type="founder-girl" size="xs" className="w-7 h-7 shrink-0" />
                </div>

                {/* Lead Agent deliverable */}
                {lead && (
                  <div className="flex items-start gap-2.5">
                    <AvatarIcon type={lead.avatarType} avatarUrl={lead.avatarUrl} name={lead.name} size="xs" className="w-7 h-7 shrink-0" />
                    <div className="flex-1 min-w-0 rounded-2xl rounded-tl-sm bg-[#F4F6FA] border border-[#E8ECF3] px-3.5 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11.5px] font-semibold text-[#1C1C1E]">{lead.name}</span>
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-white text-[#6E6E73] border border-black/[0.05]">
                          {lead.role}
                        </span>
                      </div>
                      <div className="mt-1.5 rounded-xl bg-white border border-[#E6EAF2] px-3 py-2 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <CircleCheck className="w-4 h-4 text-[#34C759] shrink-0" />
                          <span className="text-[11.5px] font-medium text-[#1C1C1E] truncate">
                            已交付 3 版黄金前 3 秒钩子 + 分镜表
                          </span>
                        </div>
                        <span className="text-[10.5px] text-[#0077CC] font-medium shrink-0">已归档</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Second Agent live collaboration */}
                {secondAgent && (
                  <div className="flex items-center justify-between pt-1 px-1 text-[11.5px] text-[#6E6E73]">
                    <div className="flex items-center gap-2 min-w-0">
                      <AvatarIcon
                        type={secondAgent.avatarType}
                        avatarUrl={secondAgent.avatarUrl}
                        name={secondAgent.name}
                        size="xs"
                        className="!w-5 !h-5 shrink-0"
                      />
                      <span className="truncate">{secondAgent.name} 正在接力生成视觉分镜提示词</span>
                    </div>
                    <span className="onb-typing flex items-center gap-[3px] shrink-0">
                      <span className="w-1 h-1 rounded-full bg-[#0099FF]" />
                      <span className="w-1 h-1 rounded-full bg-[#0099FF]" />
                      <span className="w-1 h-1 rounded-full bg-[#0099FF]" />
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Right floating card: pi Multi-model Engine & Stats */}
            <div className="hidden lg:block onb-float" style={{ animationDuration: '7.5s', animationDelay: '-2.2s' }}>
              <div className="rounded-2xl bg-white/90 backdrop-blur-xl border border-black/[0.07] shadow-[0_20px_48px_-16px_rgba(15,23,42,0.12)] p-4">
                <div className="flex items-center justify-between text-[11px] font-semibold text-[#6E6E73]">
                  <span className="inline-flex items-center gap-1.5 text-[#5B3DF5]">
                    <Cpu className="w-3.5 h-3.5" />
                    pi 多模型引擎
                  </span>
                  <span className="text-[#8E8E93] tabular-nums">{PI_CHAT_PROVIDER_TOTAL} 家服务商</span>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-1.5">
                  {featuredProviders.map((p) => (
                    <div
                      key={p.id}
                      className="rounded-lg bg-[#F8F9FC] border border-[#ECEEF4] px-2.5 py-1.5 flex items-center gap-2 min-w-0"
                    >
                      <ProviderMark mark={p.mark} color={p.color} size="sm" />
                      <span className="text-[11.5px] font-medium text-[#1C1C1E] truncate">{p.name.split(' ')[0]}</span>
                    </div>
                  ))}
                </div>

                <div className="mt-3 pt-3 border-t border-[#F0F1F5] grid grid-cols-3 gap-2 text-center">
                  <div>
                    <div className="text-[15px] font-bold text-[#0B0C10] tabular-nums">{departmentCount}</div>
                    <div className="text-[10px] text-[#8E8E93]">预置部门</div>
                  </div>
                  <div>
                    <div className="text-[15px] font-bold text-[#0B0C10] tabular-nums">{agents.length}</div>
                    <div className="text-[10px] text-[#8E8E93]">在编 Agent</div>
                  </div>
                  <div>
                    <div className="text-[15px] font-bold text-[#0B0C10] tabular-nums">{PI_CHAT_PROVIDER_TOTAL}</div>
                    <div className="text-[10px] text-[#8E8E93]">模型厂商</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Subtle bottom capability bar */}
      <footer className="relative h-12 shrink-0 flex items-center justify-center gap-6 text-[12px] text-[#8E8E93] onb-fade">
        <span className="inline-flex items-center gap-1.5">
          <MessagesSquare className="w-3.5 h-3.5 text-[#0099FF]" />
          IM 群聊派单协同
        </span>
        <span className="w-1 h-1 rounded-full bg-black/15" />
        <span className="inline-flex items-center gap-1.5">
          <BookOpen className="w-3.5 h-3.5 text-[#5B3DF5]" />
          brief.md 规范自动传承
        </span>
        <span className="w-1 h-1 rounded-full bg-black/15" />
        <span className="inline-flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-[#1E8E35]" />
          支持按岗位灵活切换底层模型
        </span>
      </footer>
    </div>
  );
};
