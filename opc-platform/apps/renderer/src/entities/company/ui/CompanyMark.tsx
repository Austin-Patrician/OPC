import { useEffect, useState } from 'react';
import { cn } from '@/shared/lib/cn';
import { brandColor, companyMonogram } from '../model/options';

interface CompanyMarkProps {
  name: string;
  colorId: string;
  /** Uploaded logo (data URL). Falls back to the monogram when absent or broken. */
  src?: string;
  /** Rendered edge length in px (the radius scales with it). */
  size?: number;
  className?: string;
}

/**
 * Brand tile for the company: the uploaded logo, or the monogram over the chosen
 * gradient. Used by the title bar, the settings header and the onboarding business
 * card, so the identity chosen in one place is the same mark everywhere.
 */
export function CompanyMark({ name, colorId, src, size = 28, className }: CompanyMarkProps) {
  const color = brandColor(colorId);
  const monogram = companyMonogram(name);
  const [failed, setFailed] = useState(false);

  // A new upload is a new image: clear the previous error.
  useEffect(() => setFailed(false), [src]);

  const showImage = Boolean(src) && !failed;

  return (
    <span
      aria-hidden
      className={cn(
        'relative flex shrink-0 items-center justify-center overflow-hidden font-bold tracking-tight',
        showImage ? 'bg-white ring-1 ring-black/10' : 'text-white',
        className,
      )}
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        fontSize: size * (monogram.length > 2 ? 0.3 : 0.38),
        ...(showImage
          ? {}
          : {
              background: `linear-gradient(140deg, ${color.from}, ${color.to})`,
              boxShadow: `inset 0 1px 0 rgba(255,255,255,0.35), 0 ${size * 0.15}px ${size * 0.4}px -${size * 0.12}px ${color.to}99`,
            }),
      }}
    >
      {showImage ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full object-contain"
          style={{ padding: Math.max(2, size * 0.12) }}
          onError={() => setFailed(true)}
        />
      ) : (
        <>
          <span className="absolute inset-0 h-1/2 bg-gradient-to-b from-white/25 to-transparent" />
          <span className="relative">{monogram}</span>
        </>
      )}
    </span>
  );
}
