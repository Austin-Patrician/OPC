import { cn } from '@/shared/lib/cn';
import type { AgentStatus } from '../model/types';

const SIZE_CLASS: Record<'xs' | 'sm' | 'md' | 'lg' | 'xl', string> = {
  xs: 'size-6 text-3xs',
  sm: 'size-8 text-2xs',
  md: 'size-avatar-md text-xs',
  lg: 'size-12 text-sm',
  xl: 'size-14 text-base',
};

const STATUS_COLOR: Record<AgentStatus, string> = {
  working: 'bg-success',
  online: 'bg-success',
  idle: 'bg-ink-quaternary',
  paused: 'bg-warning',
};

interface AvatarProps {
  name: string;
  src?: string;
  size?: keyof typeof SIZE_CLASS;
  status?: AgentStatus;
  className?: string;
}

/**
 * Cross-platform avatar: paints deterministic initials first, then layers the
 * image on top. A missing or blocked image therefore degrades gracefully instead
 * of leaving a hole in the timeline.
 */
export function Avatar({ name, src, size = 'md', status, className }: AvatarProps) {
  const initials = name.trim().slice(0, 1).toUpperCase() || '?';

  return (
    <span className={cn('relative inline-flex shrink-0', SIZE_CLASS[size], className)}>
      <span
        aria-hidden
        className="flex size-full items-center justify-center rounded-full bg-[linear-gradient(135deg,var(--accent-soft),color-mix(in_srgb,var(--accent)_28%,transparent))] font-semibold text-ink"
      >
        {initials}
      </span>

      {src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          className="absolute inset-0 size-full rounded-full object-cover"
          onError={(event) => {
            event.currentTarget.style.visibility = 'hidden';
          }}
        />
      ) : null}

      {status ? (
        <span
          aria-hidden
          className={cn(
            'absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-sidebar',
            STATUS_COLOR[status],
          )}
        />
      ) : null}
    </span>
  );
}
