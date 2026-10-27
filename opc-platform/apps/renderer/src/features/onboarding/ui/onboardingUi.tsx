import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/shared/lib/cn';

/**
 * Primitives shared by the welcome stage and the centred setup cards.
 *
 * Geometry, spacing and type sizes are the Figma reference values (expressed in
 * rem so the interface-scale preference still applies); colours come from the
 * design tokens, so the guide renders correctly in light *and* dark themes
 * instead of being a light-only island inside the app.
 */

/** Soft, luminous editorial backdrop: three drifting accent blobs over the app canvas. */
export function AuroraBackdrop({
  dimmed = false,
  accentFrom = '#38B6FF',
  accentTo = '#7A4CE0',
}: {
  dimmed?: boolean;
  accentFrom?: string;
  accentTo?: string;
}) {
  return (
    <div aria-hidden className="absolute inset-0 overflow-hidden bg-app">
      <div
        className="onb-aurora absolute -top-[24%] left-[4%] size-[56vw] rounded-full opacity-35 blur-[110px] transition-[background] duration-700"
        style={{ background: `radial-gradient(circle at center, ${accentFrom}55, transparent 68%)` }}
      />
      <div
        className="onb-aurora-b absolute top-[6%] -right-[14%] size-[52vw] rounded-full opacity-30 blur-[120px] transition-[background] duration-700"
        style={{ background: `radial-gradient(circle at center, ${accentTo}48, transparent 68%)` }}
      />
      <div
        className="onb-aurora-c absolute -bottom-[28%] left-[22%] size-[54vw] rounded-full opacity-35 blur-[120px]"
        style={{ background: 'radial-gradient(circle at center, color-mix(in srgb, var(--accent) 30%, transparent), transparent 68%)' }}
      />
      <div className="onb-grid-soft absolute inset-0" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_90%_65%_at_50%_38%,var(--surface)_0%,transparent_72%)] opacity-60" />
      <div
        className={cn(
          'absolute inset-0 bg-app/45 transition-opacity duration-700',
          dimmed ? 'opacity-100' : 'opacity-0',
        )}
      />
    </div>
  );
}

/** Small brand dot used in eyebrow chips. */
function Dot({ className = 'bg-accent' }: { className?: string }) {
  return <span aria-hidden className={cn('size-1.5 rounded-full', className)} />;
}

export function StepHeader({
  eyebrow,
  title,
  description,
  aside,
}: {
  eyebrow: string;
  title: string;
  description: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <header className="mb-6 flex items-end justify-between gap-6">
      <div className="min-w-0">
        <div className="inline-flex h-6 items-center gap-1.5 rounded-full bg-accent-soft px-2.5 text-xs-plus font-semibold tracking-[0.02em] text-accent-ink">
          <Dot />
          {eyebrow}
        </div>
        <h2 className="mt-2.5 text-[1.5625rem] leading-tight font-bold tracking-[-0.015em] text-ink">{title}</h2>
        <p className="mt-1.5 max-w-[34rem] text-base-plus leading-relaxed text-ink-tertiary">{description}</p>
      </div>
      {aside ? <div className="shrink-0">{aside}</div> : null}
    </header>
  );
}

export function Block({
  title,
  hint,
  children,
  className = '',
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h3 className="text-base font-semibold text-ink">{title}</h3>
        {hint ? <span className="text-xs-plus text-ink-tertiary">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** Selectable tile with the design's blue ring + check badge. */
export function ChoiceCard({
  selected,
  onClick,
  children,
  className = '',
  label,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-label={label}
      className={cn(
        'group relative cursor-pointer rounded-xl border bg-surface text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        selected
          ? 'border-accent shadow-[0_0_0_3px_var(--accent-soft),0_8px_24px_-12px_rgba(0,119,204,0.45)]'
          : 'border-line hover:-translate-y-px hover:border-line-strong hover:shadow-[0_6px_20px_-12px_rgba(0,0,0,0.25)]',
        className,
      )}
    >
      {children}
      <span
        className={cn(
          'absolute top-2.5 right-2.5 flex size-[1.125rem] items-center justify-center rounded-full transition-all duration-200',
          selected ? 'scale-100 bg-accent opacity-100' : 'scale-50 opacity-0',
        )}
      >
        <Check className="size-3 text-white" strokeWidth={3} />
      </span>
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[1.375rem] min-w-[1.375rem] items-center justify-center rounded-md border-b-2 border-line-strong bg-surface-muted px-1.5 font-sans text-xs font-medium text-ink-secondary shadow-[inset_0_0_0_1px_var(--border)]">
      {children}
    </kbd>
  );
}

/** `5,000,000` → `500万` / `5M`, in the active locale. */
export function formatTokens(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}
