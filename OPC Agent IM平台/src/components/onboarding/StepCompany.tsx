import React, { useRef } from 'react';
import { Briefcase, Clapperboard, CodeXml, GraduationCap, ShoppingBag, Sparkles } from 'lucide-react';
import { Block, CompanyMark, StepHeader } from './onboardingShared';
import {
  BRAND_COLORS,
  INDUSTRIES,
  Industry,
  brandColor,
  onboardingStore,
  useOnboarding,
} from './onboardingStore';

const INDUSTRY_ICON: Record<Industry, React.ElementType> = {
  content: Clapperboard,
  ecommerce: ShoppingBag,
  software: CodeXml,
  knowledge: GraduationCap,
  consulting: Briefcase,
  other: Sparkles,
};

const NAME_MAX = 24;
const VISION_MAX = 40;

const inputClass =
  'w-full rounded-xl border border-[#DCDCE0] bg-white outline-none text-[#1C1C1E] placeholder:text-[#C7C7CC] hover:border-[#C7C7CC] focus:border-[#0099FF] focus:ring-4 focus:ring-[#0099FF]/12 transition select-text';

export const StepCompany: React.FC = () => {
  const { company } = useOnboarding();
  const color = brandColor(company.colorId);
  const cardRef = useRef<HTMLDivElement>(null);
  const industry = INDUSTRIES.find((i) => i.id === company.industry);
  const now = new Date();

  const onCardMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = cardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    el.style.setProperty('--ry', `${(x - 0.5) * 16}deg`);
    el.style.setProperty('--rx', `${(0.5 - y) * 12}deg`);
    el.style.setProperty('--gx', `${x * 100}%`);
    el.style.setProperty('--gy', `${y * 100}%`);
  };
  const onCardLeave = () => {
    const el = cardRef.current;
    if (!el) return;
    el.style.setProperty('--ry', '0deg');
    el.style.setProperty('--rx', '0deg');
  };

  return (
    <>
      <StepHeader
        eyebrow="公司名片"
        title="给你的公司起个名字"
        description="名称会显示在标题栏中，所有 Agent 员工都将以它的名义协作与交付。"
      />

      <div className="grid grid-cols-[minmax(0,1fr)_300px] gap-9 items-start">
        <div className="space-y-6">
          <div>
            <label htmlFor="onb-company-name" className="text-[13px] font-semibold text-[#1C1C1E]">
              公司名称 <span className="text-[#FF4D4F]">*</span>
            </label>
            <div className="relative mt-2.5">
              <input
                id="onb-company-name"
                autoFocus
                value={company.name}
                maxLength={NAME_MAX}
                onChange={(e) => onboardingStore.updateCompany({ name: e.target.value })}
                placeholder="例如：星河内容工作室"
                autoComplete="off"
                className={`${inputClass} h-12 pl-4 pr-16 text-[17px] font-medium`}
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[11.5px] text-[#AEAEB2] tabular-nums">
                {Array.from(company.name).length}/{NAME_MAX}
              </span>
            </div>
          </div>

          <div>
            <label htmlFor="onb-company-vision" className="text-[13px] font-semibold text-[#1C1C1E]">
              一句话愿景 <span className="text-[11.5px] font-normal text-[#8E8E93]">选填</span>
            </label>
            <input
              id="onb-company-vision"
              value={company.vision}
              maxLength={VISION_MAX}
              onChange={(e) => onboardingStore.updateCompany({ vision: e.target.value })}
              placeholder="例如：用 AI Agent 打造爆款内容工厂"
              autoComplete="off"
              className={`${inputClass} mt-2.5 h-10 px-3.5 text-[13.5px]`}
            />
          </div>

          <Block title="主营方向">
            <div className="flex flex-wrap gap-2">
              {INDUSTRIES.map((item) => {
                const Icon = INDUSTRY_ICON[item.id];
                const active = company.industry === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onboardingStore.updateCompany({ industry: active ? '' : item.id })}
                    className={`h-9 px-3.5 rounded-full border flex items-center gap-1.5 text-[12.5px] cursor-pointer transition-all ${
                      active
                        ? 'border-[#0099FF] bg-[#F0F8FF] text-[#0066CC] font-medium shadow-[0_0_0_3px_rgba(0,153,255,0.12)]'
                        : 'border-[#E5E5E7] bg-white text-[#3A3A3C] hover:border-[#C7C7CC]'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {item.label}
                  </button>
                );
              })}
            </div>
          </Block>

          <Block title="品牌色" hint={color.label}>
            <div className="flex items-center gap-3">
              {BRAND_COLORS.map((c) => {
                const active = company.colorId === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    title={c.label}
                    aria-label={c.label}
                    aria-pressed={active}
                    onClick={() => onboardingStore.updateCompany({ colorId: c.id })}
                    className={`w-8 h-8 rounded-full cursor-pointer transition-transform ${
                      active ? 'scale-110 ring-2 ring-offset-2 ring-[#0099FF]' : 'hover:scale-110'
                    }`}
                    style={{ background: `linear-gradient(140deg, ${c.from}, ${c.to})` }}
                  />
                );
              })}
            </div>
          </Block>
        </div>

        {/* Live business-card preview */}
        <div className="pt-7" style={{ perspective: '1000px' }}>
          <div
            ref={cardRef}
            onPointerMove={onCardMove}
            onPointerLeave={onCardLeave}
            className="relative h-[188px] rounded-[20px] overflow-hidden text-white p-5 flex flex-col transition-transform duration-300 ease-out shadow-[0_30px_60px_-24px_rgba(0,0,0,0.55)]"
            style={{
              transform: 'rotateX(var(--rx, 0deg)) rotateY(var(--ry, 0deg))',
              background: `linear-gradient(140deg, ${color.to} 0%, #0B0D14 78%)`,
            }}
          >
            <div
              aria-hidden
              className="absolute -top-12 -right-10 w-44 h-44 rounded-full blur-2xl opacity-70 transition-[background] duration-500"
              style={{ background: color.from }}
            />
            <div aria-hidden className="absolute inset-0 onb-grid opacity-60" />
            <div
              aria-hidden
              className="absolute inset-0"
              style={{
                background: 'radial-gradient(260px circle at var(--gx, 20%) var(--gy, 0%), rgba(255,255,255,0.2), transparent 55%)',
              }}
            />
            <div className="relative flex items-start justify-between">
              <CompanyMark company={company} size={44} />
              <span className="text-[10px] font-semibold tracking-[0.24em] text-white/50">OPC</span>
            </div>
            <div className="relative mt-auto min-w-0">
              <div className={`text-[19px] font-bold tracking-tight truncate ${company.name.trim() ? '' : 'text-white/35'}`}>
                {company.name.trim() || '你的公司名称'}
              </div>
              <div className={`mt-1 text-[12px] truncate ${company.vision.trim() ? 'text-white/70' : 'text-white/30'}`}>
                {company.vision.trim() || '一句话描述你的愿景'}
              </div>
              <div className="mt-3 flex items-center justify-between text-[10.5px] text-white/50">
                <span className="h-5 px-2 rounded-full bg-white/10 flex items-center">{industry?.label ?? '未选择方向'}</span>
                <span className="font-mono">
                  EST. {now.getFullYear()}.{String(now.getMonth() + 1).padStart(2, '0')}
                </span>
              </div>
            </div>
          </div>
          <p className="mt-3.5 text-center text-[11.5px] text-[#AEAEB2]">实时预览 · 移动鼠标查看质感</p>
        </div>
      </div>
    </>
  );
};
