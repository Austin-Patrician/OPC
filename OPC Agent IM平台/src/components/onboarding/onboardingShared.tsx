import React from 'react';
import { Check } from 'lucide-react';
import { CompanyProfile, brandColor, companyMonogram } from './onboardingStore';

/** Soft, luminous editorial backdrop shared by the welcome stage and centered setup cards. */
export const AuroraBackdrop: React.FC<{ dimmed?: boolean; accentFrom?: string; accentTo?: string }> = ({
  dimmed = false,
  accentFrom = '#38B6FF',
  accentTo = '#7A4CE0',
}) => (
  <div
    aria-hidden
    className="absolute inset-0 overflow-hidden"
    style={{ background: 'linear-gradient(180deg, #FAFBFD 0%, #F2F4F8 55%, #EBEEF5 100%)' }}
  >
    <div
      className="absolute -top-[24%] left-[4%] w-[56vw] h-[56vw] rounded-full opacity-35 blur-[110px] transition-[background] duration-700"
      style={{
        background: `radial-gradient(circle at center, ${accentFrom}55, transparent 68%)`,
        animation: 'onb-aurora-a 24s ease-in-out infinite',
      }}
    />
    <div
      className="absolute top-[6%] -right-[14%] w-[52vw] h-[52vw] rounded-full opacity-30 blur-[120px] transition-[background] duration-700"
      style={{
        background: `radial-gradient(circle at center, ${accentTo}48, transparent 68%)`,
        animation: 'onb-aurora-b 28s ease-in-out infinite',
      }}
    />
    <div
      className="absolute -bottom-[28%] left-[22%] w-[54vw] h-[54vw] rounded-full opacity-35 blur-[120px]"
      style={{
        background: 'radial-gradient(circle at center, rgba(56,182,255,0.28), transparent 68%)',
        animation: 'onb-aurora-c 32s ease-in-out infinite',
      }}
    />
    <div className="absolute inset-0 onb-grid-light" />
    <div
      className="absolute inset-0"
      style={{
        background: 'radial-gradient(ellipse 90% 65% at 50% 38%, rgba(255,255,255,0.65) 0%, rgba(255,255,255,0) 72%)',
      }}
    />
    <div
      className={`absolute inset-0 bg-[#F4F6FA]/40 transition-opacity duration-700 ${dimmed ? 'opacity-100' : 'opacity-0'}`}
    />
  </div>
);

export const CompanyMark: React.FC<{
  company: CompanyProfile;
  size?: number;
  className?: string;
}> = ({ company, size = 40, className = '' }) => {
  const color = brandColor(company.colorId);
  const mono = companyMonogram(company.name);
  return (
    <span
      aria-hidden
      className={`relative shrink-0 flex items-center justify-center text-white font-bold tracking-tight overflow-hidden transition-[background] duration-500 ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        fontSize: size * (mono.length > 2 ? 0.3 : 0.38),
        background: `linear-gradient(140deg, ${color.from}, ${color.to})`,
        boxShadow: `inset 0 1px 0 rgba(255,255,255,0.35), 0 ${size * 0.15}px ${size * 0.4}px -${size * 0.12}px ${color.to}99`,
      }}
    >
      <span className="absolute inset-0 bg-gradient-to-b from-white/25 to-transparent h-1/2" />
      <span className="relative">{mono}</span>
    </span>
  );
};

export const StepHeader: React.FC<{ eyebrow: string; title: string; description: React.ReactNode; aside?: React.ReactNode }> = ({
  eyebrow,
  title,
  description,
  aside,
}) => (
  <header className="flex items-end justify-between gap-6 mb-6">
    <div className="min-w-0">
      <div className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full bg-[#0099FF]/[0.08] text-[11.5px] font-semibold tracking-[0.02em] text-[#0077CC]">
        <span className="w-1.5 h-1.5 rounded-full bg-[#0099FF]" />
        {eyebrow}
      </div>
      <h2 className="mt-2.5 text-[25px] leading-tight font-bold text-[#0B0C10] tracking-[-0.015em]">{title}</h2>
      <p className="mt-1.5 text-[13.5px] text-[#6E6E73] leading-relaxed max-w-[540px]">{description}</p>
    </div>
    {aside && <div className="shrink-0">{aside}</div>}
  </header>
);

export const Block: React.FC<{ title: string; hint?: React.ReactNode; children: React.ReactNode; className?: string }> = ({
  title,
  hint,
  children,
  className = '',
}) => (
  <section className={className}>
    <div className="mb-2.5 flex items-baseline justify-between gap-3">
      <h3 className="text-[13px] font-semibold text-[#1C1C1E]">{title}</h3>
      {hint && <span className="text-[11.5px] text-[#8E8E93]">{hint}</span>}
    </div>
    {children}
  </section>
);

export const ChoiceCard: React.FC<{
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
  label?: string;
}> = ({ selected, onClick, children, className = '', label }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={selected}
    aria-label={label}
    className={`group relative text-left rounded-xl border bg-white cursor-pointer transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0099FF]/40 ${
      selected
        ? 'border-[#0099FF] shadow-[0_0_0_3px_rgba(0,153,255,0.14),0_8px_24px_-12px_rgba(0,119,204,0.45)]'
        : 'border-[#E5E5E7] hover:border-[#C7C7CC] hover:shadow-[0_6px_20px_-12px_rgba(0,0,0,0.25)] hover:-translate-y-px'
    } ${className}`}
  >
    {children}
    <span
      className={`absolute top-2.5 right-2.5 w-[18px] h-[18px] rounded-full flex items-center justify-center transition-all duration-200 ${
        selected ? 'bg-[#0099FF] scale-100 opacity-100' : 'scale-50 opacity-0'
      }`}
    >
      <Check className="w-3 h-3 text-white" strokeWidth={3} />
    </span>
  </button>
);

export const Kbd: React.FC<{ children: React.ReactNode; dark?: boolean }> = ({ children, dark = false }) => (
  <kbd
    className={`inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-md text-[11px] font-sans font-medium border-b-2 ${
      dark
        ? 'bg-white/10 border-white/15 text-white/80'
        : 'bg-[#F5F5F7] border-[#D9D9DE] text-[#3A3A3C] shadow-[inset_0_0_0_1px_#E5E5EA]'
    }`}
  >
    {children}
  </kbd>
);

export const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
