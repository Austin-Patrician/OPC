import { useState } from 'react';
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
  size?: keyof typeof BOX;
  className?: string;
}

/**
 * Provider avatar used everywhere a model provider is shown.
 *
 * Icons come from `public/provider-icons`; when an id has none (custom relays,
 * third-party gateways) it degrades to brand-tinted initials instead of a broken
 * image. One component, so the settings list, pickers and future chat headers all
 * look the same.
 */
export function ProviderMark({ providerId, size = 'sm', className }: ProviderMarkProps) {
  const visual = providerVisual(providerId);
  const iconUrl = providerIconUrl(providerId);
  const [failed, setFailed] = useState(false);
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
          {visual.initials}
        </span>
      )}
    </span>
  );
}
