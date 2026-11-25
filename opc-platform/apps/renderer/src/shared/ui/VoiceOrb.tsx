import { memo, useEffect, useRef, type CSSProperties } from 'react';
import { cn } from '@/shared/lib/cn';
import type { VoiceOrbMode } from './voiceOrbState';
import {
  createInitialAnimState,
  drawVoiceOrbFrame,
  stepAnimState,
  type VoiceOrbAnimState,
} from './voiceOrbRenderer';

interface VoiceOrbProps {
  mode: VoiceOrbMode;
  level?: number;
  size?: number;
  className?: string;
}

function readIsDarkTheme(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement.dataset.theme === 'dark';
}

function readPrefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function drawStaticVoiceOrbFrame(
  canvas: HTMLCanvasElement | null,
  stageSize: number,
  nextMode: VoiceOrbMode,
  isDark: boolean,
): VoiceOrbAnimState | null {
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const backingSize = Math.round(stageSize * dpr);
  if (canvas.width !== backingSize || canvas.height !== backingSize) {
    canvas.width = backingSize;
    canvas.height = backingSize;
  }
  const staticState = createInitialAnimState(nextMode);
  staticState.level = nextMode === 'listening' ? 0.35 : 0;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawVoiceOrbFrame(ctx, stageSize, staticState, isDark);
  return staticState;
}

/**
 * Procedural Canvas 2D fluid aurora VoiceOrb. Accessible status text lives on
 * the enclosing status container.
 */
export const VoiceOrb = memo(function VoiceOrb({
  mode,
  level = 0,
  size = 22,
  className,
}: VoiceOrbProps) {
  const stageSize = size * 2;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const modeRef = useRef<VoiceOrbMode>(mode);
  const levelRef = useRef<number>(level);
  const animRef = useRef<VoiceOrbAnimState | null>(null);
  const darkRef = useRef<boolean>(readIsDarkTheme());

  modeRef.current = mode;
  levelRef.current = level;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    darkRef.current = readIsDarkTheme();
    animRef.current ??= createInitialAnimState(modeRef.current);

    const paintStatic = (nextMode: VoiceOrbMode) => {
      const next = drawStaticVoiceOrbFrame(canvas, stageSize, nextMode, darkRef.current);
      if (next) animRef.current = next;
    };

    const renderFrame = (dt: number) => {
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const backingSize = Math.round(stageSize * dpr);
      if (canvas.width !== backingSize || canvas.height !== backingSize) {
        canvas.width = backingSize;
        canvas.height = backingSize;
      }
      const state = animRef.current ?? createInitialAnimState(modeRef.current);
      animRef.current = state;
      stepAnimState(state, modeRef.current, levelRef.current, dt);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawVoiceOrbFrame(ctx, stageSize, state, darkRef.current);
    };

    const reducedMotionQuery =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;

    let rafId: number | null = null;
    let lastTimestamp: number | null = null;

    const stopLoop = () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      lastTimestamp = null;
    };

    const tick = (timestamp: number) => {
      if (document.hidden || (reducedMotionQuery?.matches ?? false)) {
        rafId = null;
        lastTimestamp = null;
        return;
      }
      const dt = lastTimestamp === null ? 0.016 : (timestamp - lastTimestamp) / 1000;
      lastTimestamp = timestamp;
      renderFrame(dt);
      rafId = window.requestAnimationFrame(tick);
    };

    const startLoop = () => {
      if (document.hidden || (reducedMotionQuery?.matches ?? false)) {
        paintStatic(modeRef.current);
        return;
      }
      if (rafId === null) {
        lastTimestamp = null;
        rafId = window.requestAnimationFrame(tick);
      }
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        stopLoop();
      } else {
        startLoop();
      }
    };

    const onMotionPrefChange = () => {
      if (reducedMotionQuery?.matches) {
        stopLoop();
        paintStatic(modeRef.current);
      } else {
        startLoop();
      }
    };

    const themeObserver =
      typeof MutationObserver === 'function'
        ? new MutationObserver(() => {
            darkRef.current = readIsDarkTheme();
            if (readPrefersReducedMotion()) {
              paintStatic(modeRef.current);
            }
          })
        : null;

    themeObserver?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    document.addEventListener('visibilitychange', onVisibilityChange);
    reducedMotionQuery?.addEventListener('change', onMotionPrefChange);

    startLoop();

    return () => {
      stopLoop();
      themeObserver?.disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      reducedMotionQuery?.removeEventListener('change', onMotionPrefChange);
    };
  }, [stageSize]);

  useEffect(() => {
    if (readPrefersReducedMotion()) {
      const next = drawStaticVoiceOrbFrame(canvasRef.current, stageSize, mode, darkRef.current);
      if (next) animRef.current = next;
    }
  }, [mode, stageSize]);

  return (
    <span
      aria-hidden="true"
      className={cn(
        'voice-orb relative inline-flex shrink-0 items-center justify-center overflow-visible select-none',
        `voice-orb--${mode}`,
        className,
      )}
      style={{ width: `${size}px`, height: `${size}px` } as CSSProperties}
    >
      <canvas
        ref={canvasRef}
        className="voice-orb-canvas pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
        style={{ width: `${stageSize}px`, height: `${stageSize}px` }}
      />
    </span>
  );
});
