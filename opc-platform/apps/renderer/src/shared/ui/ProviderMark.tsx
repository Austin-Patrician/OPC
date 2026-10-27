import { useEffect, useState } from 'react';
import { providerIconUrl, providerVisual } from '@/shared/providers/visuals';
import { cn } from '@/shared/lib/cn';

const BOX = {
  sm: 'size-7 rounded-lg',
  md: 'size-9 rounded-[0.625rem]',
  lg: 'size-11 rounded-xl',
} as const;

const ICON_INSET = {
  sm: 'p-1',
  md: 'p-1.5',
  lg: 'p-2',
} as const;

interface ProviderMarkProps {
  providerId: string;
  /** Reuse another provider's icon; custom providers pick one from the catalogue. */
  icon?: string;
  /** Human name, used for the initials fallback when no icon is chosen. */
  label?: string;
  size?: keyof typeof BOX;
  className?: string;
}

function initialsOf(label: string | undefined, providerId: string): string {
  const source = label?.trim() || providerId;
  return (
    source
      .replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '')
      .slice(0, 2)
      .toUpperCase() || '?'
  );
}

/**
 * Provider avatar used everywhere a model provider is shown.
 *
 * Icons come from `public/provider-icons`; a custom provider can borrow one via
 * `icon`. When nothing matches (or the image fails) it degrades to tinted
 * initials instead of a broken image. One component, so the settings list,
 * pickers and future chat headers all look the same.
 */
export function ProviderMark({ providerId, icon, label, size = 'sm', className }: ProviderMarkProps) {
  const visual = providerVisual(icon || providerId);
  const iconUrl = providerIconUrl(icon || providerId);
  const [failed, setFailed] = useState(false);

  // A different icon is a different image: clear the previous error.
  useEffect(() => setFailed(false), [icon, providerId]);

  const showIcon = Boolean(iconUrl) && !failed;

  return (
    <span
      aria-hidden
      className={cn(
        BOX[size],
        'relative flex shrink-0 items-center justify-center overflow-hidden font-bold tracking-tight',
        showIcon ? 'bg-white ring-1 ring-black/5' : 'text-white',
        className,
      )}
      style={showIcon ? undefined : { backgroundColor: visual.color }}
    >
      {showIcon ? (
        <img
          src={iconUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className={cn('size-full object-contain', ICON_INSET[size])}
          onError={() => setFailed(true)}
        />
      ) : (
        <span className={size === 'lg' ? 'text-[0.9375rem]' : size === 'md' ? 'text-[0.8125rem]' : 'text-[0.6875rem]'}>
          {icon ? visual.initials : initialsOf(label, providerId)}
        </span>
      )}
    </span>
  );
}
