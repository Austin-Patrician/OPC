import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronRight, Maximize2, Minimize2, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { AssistantActivity, AssistantActivityPhase } from '@opc/shared/ipc';
import { useUiPrefs } from '@/shared/prefs/useUiPrefs';
import type { BuddyPosition, BuddySizeId } from '@/shared/theme/types';
import { subscribeBuddySignal } from '@/shared/ui/buddyEvents';
import { BuddyMark, type BuddyClipKey } from '@/shared/ui/BuddyMark';

interface BuddyCompanionProps {
  activity?: AssistantActivity;
  /** Hide while WelcomeCanvas renders the centered 180px hero bear. */
  hidden?: boolean;
  /** True when the user is viewing the chat workspace. */
  isOnChatPage: boolean;
}

interface BuddyBubble {
  text: string;
  actionRoute?: string;
}

const SIZE_PIXELS: Record<BuddySizeId, number> = {
  sm: 116,
  md: 156,
  lg: 196,
};

const NEXT_SIZE: Record<BuddySizeId, BuddySizeId> = {
  sm: 'md',
  md: 'lg',
  lg: 'sm',
};

const DEFAULT_POSITION: BuddyPosition = { right: 24, bottom: 24 };

const BUSY_PHASES: ReadonlySet<AssistantActivityPhase> = new Set([
  'thinking',
  'organizing',
  'delegating',
  'working',
  'typing',
  'waiting_user',
]);

const POKE_BUBBLE_KEYS = [
  'buddy.bubble.poke1',
  'buddy.bubble.poke2',
  'buddy.bubble.poke3',
  'buddy.bubble.poke4',
] as const;

const AMBIENT_BUBBLE_KEYS = [
  'buddy.bubble.ambient1',
  'buddy.bubble.ambient2',
  'buddy.bubble.ambient3',
] as const;

function clampPosition(
  pos: BuddyPosition,
  sizePx: number,
  viewportW: number,
  viewportH: number,
): BuddyPosition {
  const minRight = 16;
  const minBottom = 16;
  const maxRight = Math.max(minRight, viewportW - 64 - sizePx - 16);
  const maxBottom = Math.max(minBottom, viewportH - 44 - sizePx - 24);
  return {
    right: Math.round(Math.min(maxRight, Math.max(minRight, pos.right))),
    bottom: Math.round(Math.min(maxBottom, Math.max(minBottom, pos.bottom))),
  };
}

/**
 * Persistent borderless polar-bear desktop companion living across all pages.
 * Reacts to chat activity, background workers, user typing/file drops, pointer
 * dragging, edge peeking, and poke easter eggs.
 */
export function BuddyCompanion({ activity, hidden = false, isOnChatPage }: BuddyCompanionProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const companion = useUiPrefs((state) => state.buddyCompanion);
  const updateBuddyCompanion = useUiPrefs((state) => state.updateBuddyCompanion);
  const resetBuddyPosition = useUiPrefs((state) => state.resetBuddyPosition);

  const [viewport, setViewport] = useState(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 1280,
    h: typeof window !== 'undefined' ? window.innerHeight : 800,
  }));
  const [runningWorkers, setRunningWorkers] = useState<Record<string, true>>({});
  const [listening, setListening] = useState(false);
  const [fileDragging, setFileDragging] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dragPos, setDragPos] = useState<BuddyPosition | null>(null);
  const [poked, setPoked] = useState(false);
  const [flustered, setFlustered] = useState(false);
  const [celebrating, setCelebrating] = useState(false);
  const [replayNonce, setReplayNonce] = useState(0);
  const [bubble, setBubble] = useState<BuddyBubble | null>(null);

  const bubbleTimerRef = useRef<number | null>(null);
  const pokeTimerRef = useRef<number | null>(null);
  const flusterTimerRef = useRef<number | null>(null);
  const celebrateTimerRef = useRef<number | null>(null);
  const listenTimerRef = useRef<number | null>(null);
  const tapTimestampsRef = useRef<number[]>([]);
  const lastAmbientAtRef = useRef<number>(0);
  const prevPhaseRef = useRef<AssistantActivityPhase>(activity?.phase ?? 'idle');
  const prevWorkerCountRef = useRef(0);
  const dragSessionRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startRight: number;
    startBottom: number;
    moved: boolean;
  } | null>(null);

  const phase: AssistantActivityPhase = activity?.phase ?? 'idle';
  const runningWorkerCount = Object.keys(runningWorkers).length;
  const isPeek = companion.dock === 'peek';
  const busyNowRef = useRef(false);
  busyNowRef.current = flustered || runningWorkerCount > 0 || BUSY_PHASES.has(phase);
  const baseSize = SIZE_PIXELS[companion.size];
  const effectiveSize = viewport.w < 960 ? Math.min(baseSize, 120) : baseSize;

  const dockedPos = useMemo(
    () =>
      clampPosition(
        companion.position ?? DEFAULT_POSITION,
        effectiveSize,
        viewport.w,
        viewport.h,
      ),
    [companion.position, effectiveSize, viewport.w, viewport.h],
  );

  const showBubble = useCallback(
    (next: BuddyBubble, durationMs = 3400) => {
      if (!useUiPrefs.getState().buddyCompanion.bubbles) return;
      if (bubbleTimerRef.current !== null) {
        window.clearTimeout(bubbleTimerRef.current);
      }
      setBubble(next);
      bubbleTimerRef.current = window.setTimeout(() => {
        bubbleTimerRef.current = null;
        setBubble(null);
      }, durationMs);
    },
    [],
  );

  const triggerCelebration = useCallback(
    (message?: BuddyBubble, durationMs = 3600) => {
      if (celebrateTimerRef.current !== null) {
        window.clearTimeout(celebrateTimerRef.current);
      }
      setCelebrating(true);
      setReplayNonce((n) => n + 1);
      if (message) showBubble(message, durationMs);
      celebrateTimerRef.current = window.setTimeout(() => {
        celebrateTimerRef.current = null;
        setCelebrating(false);
      }, durationMs);
    },
    [showBubble],
  );

  // Clean up timers on unmount.
  useEffect(() => {
    return () => {
      if (bubbleTimerRef.current !== null) window.clearTimeout(bubbleTimerRef.current);
      if (pokeTimerRef.current !== null) window.clearTimeout(pokeTimerRef.current);
      if (flusterTimerRef.current !== null) window.clearTimeout(flusterTimerRef.current);
      if (celebrateTimerRef.current !== null) window.clearTimeout(celebrateTimerRef.current);
      if (listenTimerRef.current !== null) window.clearTimeout(listenTimerRef.current);
    };
  }, []);

  // Track viewport size for responsive scaling & safe coordinate clamping.
  useEffect(() => {
    const onResize = () => {
      setViewport({ w: window.innerWidth, h: window.innerHeight });
    };
    window.addEventListener('resize', onResize, { passive: true });
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Track live background worker tasks.
  useEffect(() => {
    const onProgress = window.opc?.work?.onProgress;
    if (!onProgress) return undefined;
    return onProgress((event) => {
      setRunningWorkers((current) => {
        const isRunning = event.state === 'running';
        const alreadyRunning = Boolean(current[event.threadId]);
        if (isRunning === alreadyRunning) return current;
        if (isRunning) return { ...current, [event.threadId]: true };
        const next = { ...current };
        delete next[event.threadId];
        return next;
      });
    });
  }, []);

  // Celebrate when background workers finish a batch.
  useEffect(() => {
    const prev = prevWorkerCountRef.current;
    prevWorkerCountRef.current = runningWorkerCount;
    if (prev > 0 && runningWorkerCount === 0) {
      triggerCelebration({
        text: t(isOnChatPage ? 'buddy.bubble.completed' : 'buddy.bubble.completedAway'),
        actionRoute: isOnChatPage ? undefined : '/chat',
      });
    }
  }, [runningWorkerCount, isOnChatPage, t, triggerCelebration]);

  // Listen to Composer typing & file drag/drop signals.
  useEffect(() => {
    return subscribeBuddySignal((signal) => {
      if (signal.kind === 'typing') {
        setListening(true);
        if (listenTimerRef.current !== null) window.clearTimeout(listenTimerRef.current);
        listenTimerRef.current = window.setTimeout(() => {
          listenTimerRef.current = null;
          setListening(false);
        }, 1400);
        return;
      }
      if (signal.kind === 'file-drag') {
        setFileDragging(signal.active);
        return;
      }
      if (signal.kind === 'file-drop') {
        setFileDragging(false);
        setListening(true);
        if (listenTimerRef.current !== null) window.clearTimeout(listenTimerRef.current);
        listenTimerRef.current = window.setTimeout(() => {
          listenTimerRef.current = null;
          setListening(false);
        }, 700);
        showBubble({ text: t('buddy.bubble.fileDrop') }, 2400);
        return;
      }
      if (signal.kind === 'sent') {
        setListening(false);
        setFileDragging(false);
        return;
      }
      if (signal.kind === 'brand-summon') {
        const wasPeek = useUiPrefs.getState().buddyCompanion.dock === 'peek';
        if (wasPeek) {
          updateBuddyCompanion({ dock: 'floating' });
        }
        if (wasPeek || !busyNowRef.current) {
          if (pokeTimerRef.current !== null) window.clearTimeout(pokeTimerRef.current);
          setPoked(true);
          setReplayNonce((n) => n + 1);
          showBubble({ text: t(wasPeek ? 'buddy.bubble.wakeUp' : 'buddy.bubble.poke1') }, 2600);
          pokeTimerRef.current = window.setTimeout(() => {
            pokeTimerRef.current = null;
            setPoked(false);
          }, 2600);
        }
      }
    });
  }, [showBubble, t, updateBuddyCompanion]);

  // React to assistant phase transitions with targeted micro-bubbles & celebratory jumps.
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;
    if (prev === phase) return;

    if (phase === 'thinking') {
      showBubble({ text: t('buddy.bubble.thinking') }, 3400);
    } else if (phase === 'organizing') {
      showBubble({ text: t('buddy.bubble.organizing') }, 3200);
    } else if (phase === 'waiting_user') {
      showBubble(
        {
          text: t('buddy.bubble.waitingUser'),
          actionRoute: isOnChatPage ? undefined : '/chat',
        },
        4200,
      );
    } else if (phase === 'working' || phase === 'delegating' || phase === 'typing') {
      const text =
        runningWorkerCount > 0
          ? t('buddy.bubble.workingCount', { count: runningWorkerCount })
          : t('buddy.bubble.working');
      showBubble({ text }, 3600);
    } else if (
      (phase === 'completed' || phase === 'delivered' || phase === 'idle') &&
      BUSY_PHASES.has(prev)
    ) {
      triggerCelebration({
        text: t(isOnChatPage ? 'buddy.bubble.completed' : 'buddy.bubble.completedAway'),
        actionRoute: isOnChatPage ? undefined : '/chat',
      });
    } else if (phase === 'error') {
      setReplayNonce((n) => n + 1);
      showBubble(
        {
          text: t('buddy.bubble.error'),
          actionRoute: isOnChatPage ? undefined : '/chat',
        },
        4200,
      );
    }
  }, [phase, runningWorkerCount, isOnChatPage, showBubble, triggerCelebration, t]);

  // Resolved animation clip according to priority engine.
  let resolvedClip: BuddyClipKey = 'idle';
  if (flustered) {
    resolvedClip = 'error';
  } else if (poked || celebrating) {
    resolvedClip = 'completed';
  } else if (phase === 'error') {
    resolvedClip = 'error';
  } else if (phase === 'thinking' || phase === 'organizing' || phase === 'waiting_user') {
    resolvedClip = 'thinking';
  } else if (
    runningWorkerCount > 0 ||
    phase === 'working' ||
    phase === 'delegating' ||
    phase === 'typing'
  ) {
    resolvedClip = 'working';
  } else if (phase === 'completed' || phase === 'delivered') {
    resolvedClip = 'completed';
  }

  // Low-frequency ambient greeting when staying idle for a while.
  useEffect(() => {
    if (
      !companion.enabled ||
      hidden ||
      isPeek ||
      dragging ||
      !companion.bubbles ||
      resolvedClip !== 'idle'
    ) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const now = Date.now();
      if (now - lastAmbientAtRef.current < 180_000) return;
      lastAmbientAtRef.current = now;
      const key = AMBIENT_BUBBLE_KEYS[Math.floor(Math.random() * AMBIENT_BUBBLE_KEYS.length)]!;
      showBubble({ text: t(key) }, 3400);
    }, 60_000);

    return () => window.clearTimeout(timer);
  }, [companion.enabled, companion.bubbles, hidden, isPeek, dragging, resolvedClip, showBubble, t]);

  const handleTap = useCallback(() => {
    if (isPeek) {
      updateBuddyCompanion({ dock: 'floating' });
      if (pokeTimerRef.current !== null) window.clearTimeout(pokeTimerRef.current);
      setPoked(true);
      setReplayNonce((n) => n + 1);
      showBubble({ text: t('buddy.bubble.wakeUp') }, 3000);
      pokeTimerRef.current = window.setTimeout(() => {
        pokeTimerRef.current = null;
        setPoked(false);
      }, 2400);
      return;
    }

    const now = Date.now();
    const recent = tapTimestampsRef.current.filter((ts) => now - ts < 1800);
    recent.push(now);
    tapTimestampsRef.current = recent;

    if (recent.length >= 3) {
      tapTimestampsRef.current = [];
      setPoked(false);
      if (pokeTimerRef.current !== null) {
        window.clearTimeout(pokeTimerRef.current);
        pokeTimerRef.current = null;
      }
      if (flusterTimerRef.current !== null) window.clearTimeout(flusterTimerRef.current);
      setFlustered(true);
      setReplayNonce((n) => n + 1);
      showBubble({ text: t('buddy.bubble.triplePoke') }, 3000);
      flusterTimerRef.current = window.setTimeout(() => {
        flusterTimerRef.current = null;
        setFlustered(false);
      }, 2600);
      return;
    }

    setFlustered(false);
    if (pokeTimerRef.current !== null) window.clearTimeout(pokeTimerRef.current);
    setPoked(true);
    setReplayNonce((n) => n + 1);
    const key = POKE_BUBBLE_KEYS[Math.floor(Math.random() * POKE_BUBBLE_KEYS.length)]!;
    showBubble({ text: t(key) }, 3200);
    pokeTimerRef.current = window.setTimeout(() => {
      pokeTimerRef.current = null;
      setPoked(false);
    }, 3500);
  }, [isPeek, showBubble, t, updateBuddyCompanion]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('[data-buddy-control]')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragSessionRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startRight: dockedPos.right,
      startBottom: dockedPos.bottom,
      moved: false,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const session = dragSessionRef.current;
    if (!session || session.pointerId !== event.pointerId || isPeek) return;
    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;
    if (!session.moved && Math.hypot(dx, dy) < 6) return;
    session.moved = true;
    setDragging(true);
    const nextPos = clampPosition(
      {
        right: session.startRight - dx,
        bottom: session.startBottom - dy,
      },
      effectiveSize,
      viewport.w,
      viewport.h,
    );
    setDragPos(nextPos);
  };

  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const session = dragSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    dragSessionRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (session.moved && !cancelled && dragPos) {
      updateBuddyCompanion({ position: dragPos });
      setDragging(false);
      setDragPos(null);
      return;
    }

    setDragging(false);
    setDragPos(null);
    if (!cancelled && !session.moved) {
      handleTap();
    }
  };

  if (!companion.enabled || hidden) return null;

  const activePos = isPeek
    ? { right: 0, bottom: Math.max(40, Math.min(dockedPos.bottom, viewport.h - 44 - effectiveSize - 24)) }
    : (dragPos ?? dockedPos);

  const hoverStatusBubble: BuddyBubble | null =
    !bubble && hovered && !isPeek && (runningWorkerCount > 0 || BUSY_PHASES.has(phase))
      ? {
          text:
            runningWorkerCount > 0
              ? t('buddy.bubble.workingCount', { count: runningWorkerCount })
              : t(`chat.activity.${phase}`),
          actionRoute: isOnChatPage ? undefined : '/chat',
        }
      : null;

  const displayedBubble = !dragging && !isPeek ? (bubble ?? hoverStatusBubble) : null;
  const alignBubbleLeft = activePos.right < 110;
  const showSparkles = !isPeek && (poked || celebrating);

  return (
    <div
      className={[
        'buddy-companion group pointer-events-none fixed z-30 select-none',
        dragging ? 'buddy-companion-dragging' : '',
        isPeek ? 'buddy-companion-peek' : '',
        !isPeek && (listening || fileDragging) ? 'buddy-companion-listening' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        right: `${activePos.right}px`,
        bottom: `${activePos.bottom}px`,
        width: `${effectiveSize}px`,
        height: `${effectiveSize}px`,
      }}
      aria-live="polite"
    >
      {displayedBubble ? (
        displayedBubble.actionRoute ? (
          <button
            type="button"
            data-buddy-control="true"
            onClick={() => {
              const target = displayedBubble.actionRoute;
              setBubble(null);
              if (target) navigate(target);
            }}
            className={[
              'buddy-companion-bubble buddy-companion-bubble-action pointer-events-auto',
              alignBubbleLeft ? 'right-1' : 'left-1/2 -translate-x-1/2',
            ].join(' ')}
          >
            <span>{displayedBubble.text}</span>
          </button>
        ) : (
          <div
            role="status"
            className={[
              'buddy-companion-bubble pointer-events-none',
              alignBubbleLeft ? 'right-1' : 'left-1/2 -translate-x-1/2',
            ].join(' ')}
          >
            <span>{displayedBubble.text}</span>
          </div>
        )
      ) : null}

      {showSparkles ? (
        <span className="buddy-companion-sparkles pointer-events-none" aria-hidden>
          <span className="buddy-sparkle buddy-sparkle-a">✦</span>
          <span className="buddy-sparkle buddy-sparkle-b">✦</span>
          <span className="buddy-sparkle buddy-sparkle-c">✧</span>
        </span>
      ) : null}

      <div
        role="button"
        tabIndex={0}
        aria-label={isPeek ? t('buddy.controls.wake') : t('buddy.controls.dragHint')}
        title={isPeek ? t('buddy.controls.wake') : t('buddy.controls.dragHint')}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finishPointer(e, false)}
        onPointerCancel={(e) => finishPointer(e, true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleTap();
          }
        }}
        className={[
          'buddy-companion-body pointer-events-auto relative flex size-full items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
          isPeek ? 'cursor-pointer' : dragging ? 'cursor-grabbing' : 'cursor-grab',
        ].join(' ')}
      >
        <BuddyMark
          size="fill"
          phase={phase}
          animated
          lookAt={!isPeek && !dragging}
          clipOverride={resolvedClip}
          replayNonce={replayNonce}
          showShadow={!isPeek && !dragging}
        />

        {!isPeek ? (
          <div
            data-buddy-control="true"
            className="buddy-companion-controls pointer-events-none absolute -bottom-1 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full px-1.5 py-0.5 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
          >
            <button
              type="button"
              onClick={() => updateBuddyCompanion({ dock: 'peek' })}
              title={t('buddy.controls.peek')}
              aria-label={t('buddy.controls.peek')}
              className="buddy-companion-ctrl-btn"
            >
              <ChevronRight size={13} strokeWidth={2.2} />
            </button>
            <button
              type="button"
              onClick={() => updateBuddyCompanion({ size: NEXT_SIZE[companion.size] })}
              title={t('buddy.controls.cycleSize')}
              aria-label={t('buddy.controls.cycleSize')}
              className="buddy-companion-ctrl-btn"
            >
              {companion.size === 'lg' ? (
                <Minimize2 size={12} strokeWidth={2.2} />
              ) : (
                <Maximize2 size={12} strokeWidth={2.2} />
              )}
            </button>
            {companion.position ? (
              <button
                type="button"
                onClick={resetBuddyPosition}
                title={t('buddy.controls.resetPos')}
                aria-label={t('buddy.controls.resetPos')}
                className="buddy-companion-ctrl-btn"
              >
                <RotateCcw size={12} strokeWidth={2.2} />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
