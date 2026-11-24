import { memo, useEffect, useRef, useState } from 'react';
import type { AssistantActivityPhase } from '@opc/shared/ipc';
import completedClip from '@/assets/buddy/completed.webp';
import errorClip from '@/assets/buddy/error.webp';
import idleClip from '@/assets/buddy/idle.webp';
import staticBear from '@/assets/buddy/static.webp';
import thinkingClip from '@/assets/buddy/thinking.webp';
import workingClip from '@/assets/buddy/working.webp';

export type BuddyClipKey = 'idle' | 'thinking' | 'working' | 'completed' | 'error';

const CLIP_SOURCES: Record<BuddyClipKey, string> = {
  idle: idleClip,
  thinking: thinkingClip,
  working: workingClip,
  completed: completedClip,
  error: errorClip,
};

let clipsPreloaded = false;

function preloadClips() {
  if (clipsPreloaded || typeof Image === 'undefined') return;
  clipsPreloaded = true;
  for (const src of Object.values(CLIP_SOURCES)) {
    const img = new Image();
    img.src = src;
  }
}

function resolveClip(phase: AssistantActivityPhase, poked: boolean): BuddyClipKey {
  if (poked) return 'completed';
  switch (phase) {
    case 'thinking':
    case 'organizing':
    case 'waiting_user':
      return 'thinking';
    case 'delegating':
    case 'working':
    case 'typing':
      return 'working';
    case 'delivered':
    case 'completed':
      return 'completed';
    case 'error':
      return 'error';
    case 'idle':
    default:
      return 'idle';
  }
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' &&
    Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches),
  );

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  return reduced;
}

const SIZE_CLASSES: Record<'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'fill', string> = {
  xs: 'size-7',
  sm: 'size-9',
  md: 'size-11',
  lg: 'size-[72px]',
  xl: 'size-[116px]',
  '2xl': 'size-[180px]',
  fill: 'size-full',
};

/**
 * Animated 3D polar-bear desktop companion ("Buddy") backed by matted
 * transparent WebP motion clips per activity phase, falling back to a crisp
 * static image for compact message rows and reduced-motion preferences.
 */
export const BuddyMark = memo(function BuddyMark({
  size = 'md',
  phase = 'idle',
  animated = true,
  interactive = false,
  lookAt,
  clipOverride,
  replayNonce = 0,
  showShadow = true,
  showAura,
}: {
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'fill';
  phase?: AssistantActivityPhase;
  animated?: boolean;
  interactive?: boolean;
  lookAt?: boolean;
  clipOverride?: BuddyClipKey;
  replayNonce?: number;
  showShadow?: boolean;
  showAura?: boolean;
}) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const [poked, setPoked] = useState(false);
  const [pokeCount, setPokeCount] = useState(0);
  const prefersReducedMotion = usePrefersReducedMotion();
  const isAnimated = animated && !prefersReducedMotion;
  const enableLookAt = (lookAt ?? interactive) && isAnimated;
  const renderAura = showAura ?? size !== 'xs';

  useEffect(() => {
    if (isAnimated) preloadClips();
  }, [isAnimated]);

  useEffect(() => {
    if (!enableLookAt) {
      rootRef.current?.style.setProperty('--buddy-look-x', '0');
      rootRef.current?.style.setProperty('--buddy-look-y', '0');
      return undefined;
    }

    let rafId = 0;
    let latestX = 0;
    let latestY = 0;

    const flushLook = () => {
      rafId = 0;
      const el = rootRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = (latestX - cx) / 260;
      const dy = (latestY - cy) / 220;
      const clampedX = Math.max(-1, Math.min(1, dx));
      const clampedY = Math.max(-1, Math.min(1, dy));
      el.style.setProperty('--buddy-look-x', clampedX.toFixed(3));
      el.style.setProperty('--buddy-look-y', clampedY.toFixed(3));
    };

    const onPointerMove = (event: PointerEvent) => {
      latestX = event.clientX;
      latestY = event.clientY;
      if (!rafId) rafId = window.requestAnimationFrame(flushLook);
    };

    const onPointerLeave = () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
      rootRef.current?.style.setProperty('--buddy-look-x', '0');
      rootRef.current?.style.setProperty('--buddy-look-y', '0');
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('mouseleave', onPointerLeave);
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      window.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('mouseleave', onPointerLeave);
    };
  }, [enableLookAt]);

  useEffect(() => {
    if (!poked) return undefined;
    const timer = window.setTimeout(() => setPoked(false), 3500);
    return () => window.clearTimeout(timer);
  }, [poked, pokeCount]);

  const handlePoke = () => {
    setPoked(true);
    setPokeCount((count) => count + 1);
  };

  const clip = clipOverride ?? resolveClip(phase, poked);
  const activeSrc = isAnimated ? CLIP_SOURCES[clip] : staticBear;
  const phaseClass = isAnimated ? `buddy-mark-${phase}` : 'buddy-mark-static';
  const imgKey = isAnimated
    ? `${clip}-${poked ? pokeCount : 0}-${replayNonce}`
    : 'static';

  return (
    <span
      ref={rootRef}
      onClick={interactive ? handlePoke : undefined}
      className={[
        'buddy-mark',
        phaseClass,
        interactive || lookAt ? 'buddy-mark-interactive' : '',
        interactive ? 'cursor-pointer' : '',
        poked ? 'buddy-mark-poked' : '',
        'relative inline-flex shrink-0 items-center justify-center select-none',
        SIZE_CLASSES[size],
      ]
        .filter(Boolean)
        .join(' ')}
      aria-hidden
    >
      {renderAura ? <span className="buddy-mark-aura" aria-hidden /> : null}
      {showShadow ? <span className="buddy-mark-shadow" aria-hidden /> : null}
      <span className="buddy-mark-stage relative z-10 flex size-full items-center justify-center">
        <img
          key={imgKey}
          src={activeSrc}
          alt=""
          draggable={false}
          decoding="async"
          className="buddy-mark-media size-full object-contain"
        />
      </span>
    </span>
  );
});
