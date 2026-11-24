import { Search, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/shared/lib/cn';

export interface StatItem {
  label: string;
  value: string | number;
  hint?: string;
  accent?: boolean;
}

/** Compact 3-column summary metric cards shared across Capabilities & MCP pages. */
export function StatStrip({ items }: { items: readonly StatItem[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {items.map((item) => (
        <div
          key={item.label}
          className="rounded-xl border border-line bg-surface px-4 py-3"
        >
          <div className="text-3xs font-medium tracking-wide text-ink-tertiary uppercase">
            {item.label}
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span
              className={cn(
                'text-lg leading-none font-semibold tracking-tight tabular-nums',
                item.accent ? 'text-accent-ink' : 'text-ink',
              )}
            >
              {item.value}
            </span>
            {item.hint ? (
              <span className="truncate text-3xs text-ink-quaternary">{item.hint}</span>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Search input paired with segmented filter pills on a single clean row. */
export function FilterToolbar({
  query,
  onQueryChange,
  placeholder,
  rightSlot,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  placeholder: string;
  rightSlot?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2.5">
      <div className="relative min-w-[14rem] flex-1 sm:max-w-[20rem]">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-quaternary" />
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="h-8 w-full rounded-lg border border-line bg-surface pr-7 pl-8 text-sm text-ink placeholder:text-ink-quaternary outline-none transition-colors focus:border-accent"
        />
        {query ? (
          <button
            type="button"
            onClick={() => onQueryChange('')}
            aria-label="Clear"
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-ink-quaternary hover:text-ink"
          >
            <X className="size-3" />
          </button>
        ) : null}
      </div>
      {rightSlot ? <div className="flex flex-wrap items-center gap-2">{rightSlot}</div> : null}
    </div>
  );
}

/** Segmented pill bar styled consistently with Settings kit primitives. */
export function FilterPills<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (next: T) => void;
  options: readonly { value: T; label: string; count?: number }[];
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="inline-flex rounded-lg border border-line bg-surface-muted/70 p-0.5"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2.5 text-xs whitespace-nowrap transition-colors',
              active
                ? 'bg-surface font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                : 'text-ink-tertiary hover:text-ink',
            )}
          >
            <span>{option.label}</span>
            {option.count !== undefined ? (
              <span
                className={cn(
                  'rounded-full px-1.5 py-px text-3xs tabular-nums',
                  active ? 'bg-surface-muted text-ink-secondary' : 'text-ink-quaternary',
                )}
              >
                {option.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
