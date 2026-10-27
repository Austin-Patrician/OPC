import React from 'react';
import { ArrowRight, MessagesSquare, Network, Settings2 } from 'lucide-react';
import { AgentEmployee, CandidateAgent, NavTab } from '../../types/im';
import { AvatarIcon } from '../AvatarIcon';
import { THINKING_LEVELS, findProvider } from '../settings/piCatalog';
import { useSettings } from '../settings/settingsStore';
import { ProviderMark } from '../settings/settingsUi';
import { CompanyMark } from './onboardingShared';
import { INDUSTRIES, companyDisplayName, useOnboarding } from './onboardingStore';

const CONFETTI_COLORS = ['#38B6FF', '#B49CFF', '#45E3CF', '#FFB86B', '#F0436A', '#34C759', '#FFD60A'];

const CONFETTI = Array.from({ length: 42 }, (_, i) => ({
  left: `${(i * 53 + 7) % 100}%`,
  width: 6 + (i % 3) * 1.5,
  height: i % 4 === 0 ? 6 + (i % 3) * 1.5 : 11 + (i % 4),
  round: i % 4 === 0,
  color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
  style: {
    '--onb-dx': `${((i * 37) % 120) - 60}px`,
    '--onb-rot': `${360 + ((i * 47) % 540)}deg`,
    '--onb-dur': `${2.4 + (i % 5) * 0.35}s`,
    '--onb-delay': `${(i % 12) * 0.06}s`,
  } as React.CSSProperties,
}));

const ACTIONS: { tab: NavTab; icon: React.ElementType; title: string; sub: string }[] = [
  { tab: 'im', icon: MessagesSquare, title: '给 Agent 派发第一单任务', sub: '在 IM 中私聊员工，或 @ 部门群协同' },
  { tab: 'org', icon: Network, title: '查看组织架构', sub: '调整部门、编制与 brief.md' },
  { tab: 'settings', icon: Settings2, title: '完善模型与凭据', sub: '配置更多服务商、图像模型与自检' },
];

interface StepDoneProps {
  agents: AgentEmployee[];
  newHires: CandidateAgent[];
  onAction: (tab: NavTab) => void;
}

export const StepDone: React.FC<StepDoneProps> = ({ agents, newHires, onAction }) => {
  const { company } = useOnboarding();
  const { prefs } = useSettings();
  const provider = findProvider(prefs.defaultProvider);
  const model = provider?.models.find((m) => m.id === prefs.defaultModel);
  const thinking = THINKING_LEVELS.find((t) => t.value === prefs.defaultThinkingLevel)?.label;
  const industry = INDUSTRIES.find((i) => i.id === company.industry)?.label;

  return (
    <div className="relative">
      <div aria-hidden className="pointer-events-none absolute -inset-x-10 -top-9 h-[560px] overflow-hidden">
        {CONFETTI.map((c, i) => (
          <span
            key={i}
            className="absolute top-0 onb-confetti"
            style={{
              ...c.style,
              left: c.left,
              width: c.width,
              height: c.height,
              background: c.color,
              borderRadius: c.round ? '50%' : 2,
            }}
          />
        ))}
      </div>

      <div className="relative text-center pt-2">
        <div className="relative w-[92px] h-[92px] mx-auto">
          <span aria-hidden className="absolute inset-0 rounded-full border-2 border-[#34C759]/50 onb-burst" style={{ animationDelay: '0.3s' }} />
          <span aria-hidden className="absolute inset-0 rounded-full border-2 border-[#38B6FF]/40 onb-burst" style={{ animationDelay: '0.5s' }} />
          <div className="onb-pop absolute inset-0 rounded-full bg-gradient-to-br from-[#4ADE80] to-[#0EA5E9] flex items-center justify-center shadow-[0_18px_40px_-14px_rgba(14,165,233,0.8)]">
            <svg viewBox="0 0 48 48" className="w-12 h-12" aria-hidden>
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
        <h2 className="mt-6 text-[28px] leading-tight font-bold text-[#0B0C10] tracking-[-0.01em] onb-fade-up" style={{ animationDelay: '0.2s' }}>
          「{companyDisplayName(company)}」已准备就绪
        </h2>
        <p className="mt-2 text-[13.5px] text-[#6E6E73] onb-fade-up" style={{ animationDelay: '0.3s' }}>
          你的 AI 团队已经就位。进入工作台，给第一位 Agent 员工派发任务吧。
        </p>
      </div>

      <div className="relative mt-8 grid grid-cols-3 gap-3">
        <SummaryCard label="公司" delay={0.4}>
          <div className="flex items-center gap-2.5 min-w-0">
            <CompanyMark company={company} size={36} />
            <div className="min-w-0">
              <div className="text-[13.5px] font-semibold text-[#1C1C1E] truncate">{companyDisplayName(company)}</div>
              <div className="text-[11.5px] text-[#8E8E93] truncate">{company.vision.trim() || industry || '未填写愿景'}</div>
            </div>
          </div>
        </SummaryCard>

        <SummaryCard label="默认模型" delay={0.48}>
          <div className="flex items-center gap-2.5 min-w-0">
            {provider ? (
              <ProviderMark mark={provider.mark} color={provider.color} size="md" />
            ) : (
              <span className="w-9 h-9 rounded-lg bg-[#F2F2F5] border border-dashed border-[#C7C7CC] shrink-0" />
            )}
            <div className="min-w-0">
              <div className="text-[13.5px] font-semibold text-[#1C1C1E] truncate">{model?.name ?? '由 pi 自动选择'}</div>
              <div className="text-[11.5px] text-[#8E8E93] truncate">
                {provider ? `${provider.name} · 思考 ${thinking}` : '可随时在设置中指定'}
              </div>
            </div>
          </div>
        </SummaryCard>

        <SummaryCard label="团队" delay={0.56}>
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex -space-x-2 shrink-0">
              {newHires.slice(0, 3).map((c) => (
                <img key={c.id} src={c.avatarUrl} alt="" className="w-8 h-8 rounded-full object-cover ring-2 ring-white" />
              ))}
              {agents
                .filter((a) => a.avatarType !== 'custom')
                .slice(0, Math.max(0, 3 - newHires.length))
                .map((a) => (
                  <span key={a.id} className="rounded-full ring-2 ring-white">
                    <AvatarIcon type={a.avatarType} avatarUrl={a.avatarUrl} name={a.name} size="sm" />
                  </span>
                ))}
            </div>
            <div className="min-w-0">
              <div className="text-[13.5px] font-semibold text-[#1C1C1E] truncate">共 {agents.length} 名 Agent</div>
              <div className="text-[11.5px] text-[#8E8E93] truncate">
                {newHires.length ? `本次新聘 ${newHires.length} 名` : '暂未新聘员工'}
              </div>
            </div>
          </div>
        </SummaryCard>
      </div>

      <div className="relative mt-5 rounded-2xl border border-[#E5E5E7] overflow-hidden onb-fade-up" style={{ animationDelay: '0.64s' }}>
        {ACTIONS.map(({ tab, icon: Icon, title, sub }, i) => (
          <button
            key={tab}
            type="button"
            onClick={() => onAction(tab)}
            className={`group w-full px-4 py-3 flex items-center gap-3 text-left bg-white hover:bg-[#F7F9FC] cursor-pointer transition-colors ${
              i ? 'border-t border-[#F0F0F2]' : ''
            }`}
          >
            <span className="w-9 h-9 rounded-xl bg-[#F0F8FF] text-[#0077CC] flex items-center justify-center shrink-0">
              <Icon className="w-[18px] h-[18px]" />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-[13px] font-medium text-[#1C1C1E]">{title}</span>
              <span className="block text-[11.5px] text-[#8E8E93]">{sub}</span>
            </span>
            <ArrowRight className="w-4 h-4 text-[#C7C7CC] group-hover:text-[#0099FF] group-hover:translate-x-0.5 transition-all" />
          </button>
        ))}
      </div>
    </div>
  );
};

const SummaryCard: React.FC<{ label: string; delay: number; children: React.ReactNode }> = ({ label, delay, children }) => (
  <div className="rounded-2xl border border-[#E5E5E7] bg-white px-4 py-3.5 onb-fade-up" style={{ animationDelay: `${delay}s` }}>
    <div className="text-[11px] font-medium text-[#8E8E93] mb-2">{label}</div>
    {children}
  </div>
);
