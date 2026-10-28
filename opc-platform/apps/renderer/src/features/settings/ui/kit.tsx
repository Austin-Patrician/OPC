import { useState } from 'react';
import { Eye, EyeOff, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { cn } from '@/shared/lib/cn';
import type { ReactNode as ReactNodeType } from 'react';

/** Shared settings primitives, matching the design's metrics (see README). */

export function PageHeader({
  crumbs,
  title,
  description,
  actions,
}: {
  crumbs: string[];
  title: string;
  description?: ReactNodeType;
  actions?: ReactNodeType;
}) {
  return (
    <header className="mb-5 flex items-end justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-1 text-xs-plus text-ink-tertiary">
          {crumbs.map((crumb, index) => (
            <span key={crumb} className="flex items-center gap-1">
              {index > 0 ? <span className="text-ink-quaternary">›</span> : null}
              {crumb}
            </span>
          ))}
        </div>
        <h2 className="mt-1 text-xl leading-tight font-bold tracking-tight text-ink">{title}</h2>
        {description ? (
          <p className="mt-1.5 max-w-[42.5rem] text-sm-plus leading-relaxed text-ink-tertiary">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: ReactNodeType;
  action?: ReactNodeType;
  children: ReactNodeType;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 pt-3.5 pb-3">
        <div className="min-w-0">
          <h3 className="text-base-plus font-semibold text-ink">{title}</h3>
          {description ? (
            <p className="mt-0.5 text-xs-plus leading-relaxed text-ink-tertiary">{description}</p>
          ) : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function Row({
  label,
  hint,
  settingKey,
  disabled = false,
  children,
}: {
  label: ReactNodeType;
  hint?: ReactNodeType;
  settingKey?: string;
  disabled?: boolean;
  children?: ReactNodeType;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-6 border-t border-line px-4 py-3 first:border-t-0 transition-opacity',
        disabled && 'pointer-events-none opacity-45',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base text-ink">
          {label}
          {settingKey ? <KeyTag>{settingKey}</KeyTag> : null}
        </div>
        {hint ? <div className="mt-0.5 text-xs-plus leading-relaxed text-ink-tertiary">{hint}</div> : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  );
}

export function KeyTag({ children, className = '' }: { children: ReactNodeType; className?: string }) {
  return (
    <code
      className={cn(
        'inline-block rounded bg-surface-muted px-1.5 py-px font-mono text-2xs whitespace-nowrap text-ink-tertiary select-text',
        className,
      )}
    >
      {children}
    </code>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  title,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-5 w-[2.125rem] shrink-0 rounded-full transition-colors',
        disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer',
        checked ? 'bg-accent' : 'bg-ink-quaternary/60',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.22)] transition-transform',
          checked && 'translate-x-[0.875rem]',
        )}
      />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: ReactNodeType }[];
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-[7px] bg-surface-muted p-0.5">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex h-[1.625rem] items-center gap-1 rounded-[5px] px-2.5 text-sm whitespace-nowrap transition-colors',
              active
                ? 'bg-surface font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                : 'text-ink-tertiary hover:text-ink',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function NumberField({
  value,
  onChange,
  min,
  max,
  unit,
  label,
  className = '',
}: {
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  unit?: string;
  label: string;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <input
        type="number"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-[26px] w-[6.5rem] rounded-md border border-line bg-surface px-2 text-right font-mono text-sm text-ink outline-none focus:border-accent"
      />
      {unit ? <span className="text-2xs text-ink-quaternary">{unit}</span> : null}
    </div>
  );
}

export const buttonClass = {
  primary:
    'inline-flex h-[30px] shrink-0 items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-sm-plus font-medium whitespace-nowrap text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60',
  secondary:
    'inline-flex h-[30px] shrink-0 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-3 text-sm-plus whitespace-nowrap text-ink transition-colors hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-60',
  danger:
    'inline-flex h-[30px] shrink-0 items-center justify-center gap-1.5 rounded-md border border-danger/40 bg-surface px-3 text-sm-plus whitespace-nowrap text-danger transition-colors hover:bg-danger/10',
} as const;

export function StatusBadge({ tone, label }: { tone: 'green' | 'blue' | 'amber' | 'red' | 'gray'; label: string }) {
  const tones = {
    green: 'bg-success/10 text-success',
    blue: 'bg-accent-soft text-accent-ink',
    amber: 'bg-warning/10 text-warning',
    red: 'bg-danger/10 text-danger',
    gray: 'bg-surface-muted text-ink-tertiary',
  } as const;

  return (
    <span className={cn('inline-flex h-5 items-center gap-1 rounded-full px-2 text-2xs font-medium whitespace-nowrap', tones[tone])}>
      <span className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink-secondary">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-2xs text-ink-quaternary">{hint}</span> : null}
    </label>
  );
}

export function TextField({
  value,
  onChange,
  placeholder,
  ariaLabel,
  mono,
  className = '',
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  ariaLabel: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <input
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      className={cn(
        'h-[30px] w-full rounded-md border border-line bg-surface px-2.5 text-sm text-ink outline-none placeholder:text-ink-quaternary focus:border-accent',
        mono && 'font-mono',
        className,
      )}
    />
  );
}

export function SelectField({
  value,
  onChange,
  ariaLabel,
  children,
  className = '',
}: {
  value: string;
  onChange: (next: string) => void;
  ariaLabel: string;
  children: ReactNodeType;
  className?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn(
        'h-[30px] w-full rounded-md border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-accent',
        className,
      )}
    >
      {children}
    </select>
  );
}

export function SecretField({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  ariaLabel: string;
}) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        aria-label={ariaLabel}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="h-[30px] w-full rounded-md border border-line bg-surface px-2.5 pr-9 font-mono text-sm text-ink outline-none placeholder:text-ink-quaternary focus:border-accent"
      />
      <button
        type="button"
        onClick={() => setVisible((previous) => !previous)}
        aria-label={visible ? t('common.hide') : t('common.show')}
        className="absolute top-1/2 right-2 -translate-y-1/2 text-ink-quaternary hover:text-ink"
      >
        {visible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </button>
    </div>
  );
}

export function Note({
  tone,
  children,
  action,
}: {
  tone: 'info' | 'warn';
  children: ReactNodeType;
  action?: ReactNodeType;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg px-3 py-2 text-xs leading-relaxed',
        tone === 'warn' ? 'bg-warning/10 text-warning' : 'bg-accent-soft text-accent-ink',
      )}
    >
      <Info className="mt-0.5 size-3.5 shrink-0" />
      <span className="flex-1">{children}</span>
      {action}
    </div>
  );
}
