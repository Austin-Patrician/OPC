import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronRight, Copy, Eye, EyeOff, Info, X } from 'lucide-react';
import { StatusTone } from './settingsStore';

export const TONE_CLASS: Record<StatusTone, { bg: string; text: string; dot: string }> = {
  green: { bg: 'bg-[#E9F8EC]', text: 'text-[#1E8E35]', dot: 'bg-[#27C93F]' },
  blue: { bg: 'bg-[#E8F3FF]', text: 'text-[#0066CC]', dot: 'bg-[#0099FF]' },
  amber: { bg: 'bg-[#FFF4E5]', text: 'text-[#B76E00]', dot: 'bg-[#F5A623]' },
  red: { bg: 'bg-[#FFEDED]', text: 'text-[#D93025]', dot: 'bg-[#FF4D4F]' },
  gray: { bg: 'bg-[#F2F2F5]', text: 'text-[#6E6E73]', dot: 'bg-[#AEAEB2]' },
};

export const StatusBadge: React.FC<{ tone: StatusTone; label: string }> = ({ tone, label }) => {
  const t = TONE_CLASS[tone];
  return (
    <span
      className={`inline-flex items-center gap-1 h-5 px-2 rounded-full text-[11px] font-medium whitespace-nowrap shrink-0 ${t.bg} ${t.text}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${t.dot}`} />
      {label}
    </span>
  );
};

export const KeyTag: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className = '',
}) => (
  <code
    className={`inline-block text-[10.5px] leading-[18px] px-1.5 rounded bg-[#F2F2F5] text-[#6E6E73] font-mono select-text whitespace-nowrap ${className}`}
  >
    {children}
  </code>
);

export const PageHeader: React.FC<{
  crumbs: string[];
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}> = ({ crumbs, title, description, actions }) => (
  <header className="flex items-end justify-between gap-4 mb-5">
    <div className="min-w-0">
      <div className="flex items-center gap-1 text-[11.5px] text-[#8E8E93]">
        {crumbs.map((c, i) => (
          <React.Fragment key={c}>
            {i > 0 && <ChevronRight className="w-3 h-3 text-[#C7C7CC]" />}
            <span>{c}</span>
          </React.Fragment>
        ))}
      </div>
      <h2 className="mt-1 text-[19px] leading-tight font-bold text-[#1C1C1E] tracking-tight">{title}</h2>
      {description && (
        <p className="mt-1.5 text-[12.5px] text-[#6E6E73] leading-relaxed max-w-[680px]">
          {description}
        </p>
      )}
    </div>
    {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
  </header>
);

export const Section: React.FC<{
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, description, action, children }) => (
  <section className="bg-white rounded-xl border border-[#E5E5E7] overflow-hidden">
    <div className="px-4 pt-3.5 pb-3 flex items-start justify-between gap-3 border-b border-[#F0F0F2]">
      <div className="min-w-0">
        <h3 className="text-[13.5px] font-semibold text-[#1C1C1E]">{title}</h3>
        {description && (
          <p className="mt-0.5 text-[11.5px] text-[#8E8E93] leading-relaxed">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0 flex items-center gap-2">{action}</div>}
    </div>
    {children}
  </section>
);

export const Row: React.FC<{
  label: React.ReactNode;
  hint?: React.ReactNode;
  settingKey?: string;
  disabled?: boolean;
  children?: React.ReactNode;
}> = ({ label, hint, settingKey, disabled = false, children }) => (
  <div
    className={`px-4 py-3 flex items-center gap-6 border-t border-[#F0F0F2] first:border-t-0 transition-opacity ${
      disabled ? 'opacity-45 pointer-events-none' : ''
    }`}
  >
    <div className="flex-1 min-w-0">
      <div className="flex items-center flex-wrap gap-x-2 gap-y-1 text-[13px] text-[#1C1C1E]">
        {label}
        {settingKey && <KeyTag>{settingKey}</KeyTag>}
      </div>
      {hint && <div className="mt-0.5 text-[11.5px] text-[#8E8E93] leading-relaxed">{hint}</div>}
    </div>
    {children && <div className="shrink-0 flex items-center gap-2">{children}</div>}
  </div>
);

export const Toggle: React.FC<{
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}> = ({ checked, onChange, label }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    onClick={() => onChange(!checked)}
    className={`relative w-[34px] h-5 rounded-full shrink-0 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0099FF]/40 ${
      checked ? 'bg-[#0099FF]' : 'bg-[#D1D1D6]'
    }`}
  >
    <span
      className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.22)] transition-transform ${
        checked ? 'translate-x-[14px]' : ''
      }`}
    />
  </button>
);

export interface SegmentOption<T extends string> {
  value: T;
  label: React.ReactNode;
  title?: string;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly SegmentOption<T>[];
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex p-0.5 rounded-[7px] bg-[#EFEFF1]">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={`h-[26px] px-2.5 rounded-[5px] text-[12px] whitespace-nowrap inline-flex items-center gap-1 transition-colors cursor-pointer ${
              active
                ? 'bg-white text-[#1C1C1E] font-medium shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                : 'text-[#6E6E73] hover:text-[#1C1C1E]'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export const SelectField: React.FC<
  React.SelectHTMLAttributes<HTMLSelectElement> & { wrapperClassName?: string }
> = ({ wrapperClassName = 'w-[200px]', className = '', children, ...rest }) => (
  <div className={`relative ${wrapperClassName}`}>
    <select
      {...rest}
      className={`w-full h-[30px] appearance-none rounded-[6px] bg-white border border-[#DCDCE0] pl-2.5 pr-7 text-[12.5px] text-[#1C1C1E] outline-none hover:border-[#C7C7CC] focus:border-[#0099FF] focus:ring-2 focus:ring-[#0099FF]/15 cursor-pointer ${className}`}
    >
      {children}
    </select>
    <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#8E8E93] pointer-events-none" />
  </div>
);

export const TextField = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { mono?: boolean; invalid?: boolean }
>(({ mono = false, invalid = false, className = '', ...rest }, ref) => (
  <input
    ref={ref}
    {...rest}
    className={`h-[30px] rounded-[6px] bg-[#F7F7F8] border px-2.5 text-[#1C1C1E] outline-none placeholder:text-[#AEAEB2] focus:bg-white focus:ring-2 select-text transition-colors ${
      invalid
        ? 'border-[#FF4D4F] focus:border-[#FF4D4F] focus:ring-[#FF4D4F]/15'
        : 'border-[#E5E5E7] hover:border-[#D1D1D6] focus:border-[#0099FF] focus:ring-[#0099FF]/15'
    } ${mono ? 'font-mono text-[12px]' : 'text-[12.5px]'} ${className}`}
  />
));
TextField.displayName = 'TextField';

const IconButton: React.FC<{ title: string; onClick: () => void; children: React.ReactNode }> = ({
  title,
  onClick,
  children,
}) => (
  <button
    type="button"
    title={title}
    aria-label={title}
    onClick={onClick}
    className="w-6 h-6 rounded-md flex items-center justify-center text-[#8E8E93] hover:text-[#1C1C1E] hover:bg-black/[0.05] cursor-pointer"
  >
    {children}
  </button>
);

/** Masked credential input. Values are only held in memory by the settings store. */
export const SecretField: React.FC<{
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  label: string;
  className?: string;
}> = ({ value, onChange, placeholder, label, className = 'w-full' }) => {
  const [visible, setVisible] = useState(false);
  return (
    <div className={`relative ${className}`}>
      <TextField
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
        mono
        className="w-full pr-[60px]"
      />
      <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center">
        {value && (
          <IconButton title="清除" onClick={() => onChange('')}>
            <X className="w-3.5 h-3.5" />
          </IconButton>
        )}
        <IconButton title={visible ? '隐藏' : '显示'} onClick={() => setVisible((v) => !v)}>
          {visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        </IconButton>
      </div>
    </div>
  );
};

/** Numeric input that commits on blur / Enter and clamps to the allowed range. */
export const NumberField: React.FC<{
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  unit?: string;
  label: string;
}> = ({ value, onChange, min, max, unit, label }) => {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commitDraft = () => {
    const parsed = Number(draft.replace(/[,_\s]/g, ''));
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, Math.round(parsed)));
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  };
  return (
    <div className="flex items-center gap-1.5">
      <TextField
        value={draft}
        inputMode="numeric"
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitDraft}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        mono
        className="w-[92px] text-right"
      />
      {unit && <span className="text-[11.5px] text-[#8E8E93] w-6">{unit}</span>}
    </div>
  );
};

export const CopyButton: React.FC<{ text: string; label?: string; className?: string }> = ({
  text,
  label = '复制',
  className = '',
}) => {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = window.setTimeout(() => setState('idle'), 1600);
    return () => window.clearTimeout(timer);
  }, [state]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('done');
    } catch {
      setState('failed');
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={label}
      className={`inline-flex items-center gap-1 h-6 px-1.5 rounded-md text-[11.5px] cursor-pointer transition-colors ${
        state === 'failed'
          ? 'text-[#D93025]'
          : state === 'done'
            ? 'text-[#1E8E35]'
            : 'text-[#6E6E73] hover:text-[#1C1C1E] hover:bg-black/[0.05]'
      } ${className}`}
    >
      {state === 'done' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      {state === 'done' ? '已复制' : state === 'failed' ? '复制失败' : label}
    </button>
  );
};

export const Note: React.FC<{ tone?: 'info' | 'warn'; children: React.ReactNode; action?: React.ReactNode }> = ({
  tone = 'info',
  children,
  action,
}) => (
  <div
    className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[11.5px] leading-relaxed ${
      tone === 'warn'
        ? 'bg-[#FFF8EC] border-[#FBE3BA] text-[#8A5A00]'
        : 'bg-[#F5F9FF] border-[#DCEBFF] text-[#3A5A80]'
    }`}
  >
    {tone === 'warn' ? (
      <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0 text-[#F5A623]" />
    ) : (
      <Info className="w-3.5 h-3.5 mt-px shrink-0 text-[#0099FF]" />
    )}
    <div className="flex-1 min-w-0">{children}</div>
    {action && <div className="shrink-0 -my-0.5">{action}</div>}
  </div>
);

export const ProviderMark: React.FC<{ mark: string; color: string; size?: 'sm' | 'md' | 'lg' }> = ({
  mark,
  color,
  size = 'sm',
}) => {
  const box = { sm: 'w-7 h-7 rounded-lg', md: 'w-9 h-9 rounded-[10px]', lg: 'w-11 h-11 rounded-xl' }[size];
  const text =
    mark.length > 2
      ? { sm: 'text-[8.5px]', md: 'text-[10.5px]', lg: 'text-[12px]' }[size]
      : { sm: 'text-[11px]', md: 'text-[13px]', lg: 'text-[15px]' }[size];
  return (
    <span
      className={`${box} ${text} shrink-0 flex items-center justify-center font-bold text-white tracking-tight`}
      style={{ background: color }}
      aria-hidden
    >
      {mark}
    </span>
  );
};

export const buttonClass = {
  primary:
    'inline-flex items-center justify-center gap-1.5 h-[30px] px-3 rounded-md bg-[#0099FF] hover:bg-[#008BEA] active:bg-[#007ED6] text-white text-[12.5px] font-medium cursor-pointer transition-colors disabled:opacity-60 disabled:cursor-not-allowed',
  secondary:
    'inline-flex items-center justify-center gap-1.5 h-[30px] px-3 rounded-md bg-white border border-[#DCDCE0] hover:bg-[#F5F5F7] text-[12.5px] text-[#1C1C1E] cursor-pointer transition-colors disabled:opacity-60 disabled:cursor-not-allowed',
  danger:
    'inline-flex items-center justify-center gap-1.5 h-[30px] px-3 rounded-md bg-white border border-[#F5C2C0] hover:bg-[#FFF2F1] text-[12.5px] text-[#D93025] cursor-pointer transition-colors',
  link: 'inline-flex items-center gap-1 text-[12px] text-[#0077CC] hover:text-[#0099FF] cursor-pointer',
};
