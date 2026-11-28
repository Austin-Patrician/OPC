import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { AppWindow, ChevronRight, Maximize2, Minimize2, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AssistantActivityPhase, BuddyOverlayState } from '@opc/shared/ipc';
import i18n from '@/shared/i18n';
import { BuddyMark } from '@/shared/ui/BuddyMark';
import {
  AMBIENT_BUBBLE_KEYS,
  BUSY_PHASES,
  NEXT_SIZE,
  POKE_BUBBLE_KEYS,
  resolveBuddyClip,
  SIZE_PIXELS,
  type BuddyBubble,
} from './buddyLogic';

/**
 * Standalone transparent Electron desktop overlay hosting the animated polar bear
 * above the desktop with pixel-region click-through and smooth multi-monitor dragging.
 */
export function DesktopBuddyOverlay() {
  const { t } = useTranslation();
  const bridge = window.opc?.buddy;

  const [state, setState] = useState<BuddyOverlayState | null>(null);
  const [runningWorkers, setRunningWorkers] = useState<Record<string, true>>({});
  const [listening, setListening] = useState(false);
  const [fileDragging, setFileDragging] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [poked, setPoked] = useState(false);
  const [flustered, setFlustered] = useState(false);
  const [celebrating, setCelebrating] = useState(false);
  const [replayNonce, setReplayNonce] = useState(0);
  const [bubble, setBubble] = useState<BuddyBubble | null>(null);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [controlsHovered, setControlsHovered] = useState(false);
  const [controlsRevealNonce, setControlsRevealNonce] = useState(0);

  const bubbleTimerRef = useRef<number | null>(null);
  const pokeTimerRef = useRef<number | null>(null);
  const flusterTimerRef = useRef<number | null>(null);
  const celebrateTimerRef = useRef<number | null>(null);
  const listenTimerRef = useRef<number | null>(null);
  const controlsTimerRef = useRef<number | null>(null);
  const tapTimestampsRef = useRef<number[]>([]);
  const lastAmbientAtRef = useRef<number>(0);
  const prevPhaseRef = useRef<AssistantActivityPhase>('idle');
  const prevWorkerCountRef = useRef(0);
  const lastInteractiveRef = useRef(false);
  const draggingRef = useRef(false);
  const dragRafRef = useRef(0);
  const dragSessionRef = useRef<{
    pointerId: number;
    startScreenX: number;
    startScreenY: number;
    moved: boolean;
  } | null>(null);

  const phase: AssistantActivityPhase = state?.activity?.phase ?? 'idle';
  const runningWorkerCount = Object.keys(runningWorkers).length;
  const isPeek = state?.dock === 'peek';
  const controlsVisible = controlsOpen && !isPeek && !dragging;
  const busyNowRef = useRef(false);
  busyNowRef.current = flustered || runningWorkerCount > 0 || BUSY_PHASES.has(phase);

  const showBubble = useCallback(
    (next: BuddyBubble, durationMs = 3400) => {
      if (state && !state.bubbles) return;
      if (bubbleTimerRef.current !== null) {
        window.clearTimeout(bubbleTimerRef.current);
      }
      setBubble(next);
      bubbleTimerRef.current = window.setTimeout(() => {
        bubbleTimerRef.current = null;
        setBubble(null);
      }, durationMs);
    },
    [state],
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

  const hideControls = useCallback(() => {
    if (controlsTimerRef.current !== null) {
      window.clearTimeout(controlsTimerRef.current);
      controlsTimerRef.current = null;
    }
    setControlsOpen(false);
    setControlsHovered(false);
  }, []);

  const revealControls = useCallback(() => {
    setControlsOpen(true);
    setControlsRevealNonce((n) => n + 1);
  }, []);

  // Clear timers & animation frame handles on unmount.
  useEffect(() => {
    return () => {
      if (bubbleTimerRef.current !== null) window.clearTimeout(bubbleTimerRef.current);
      if (pokeTimerRef.current !== null) window.clearTimeout(pokeTimerRef.current);
      if (flusterTimerRef.current !== null) window.clearTimeout(flusterTimerRef.current);
      if (celebrateTimerRef.current !== null) window.clearTimeout(celebrateTimerRef.current);
      if (listenTimerRef.current !== null) window.clearTimeout(listenTimerRef.current);
      if (controlsTimerRef.current !== null) window.clearTimeout(controlsTimerRef.current);
      if (dragRafRef.current) window.cancelAnimationFrame(dragRafRef.current);
    };
  }, []);

  // Auto-hide the bottom mini controls after click-reveal unless hovered directly.
  useEffect(() => {
    if (controlsTimerRef.current !== null) {
      window.clearTimeout(controlsTimerRef.current);
      controlsTimerRef.current = null;
    }
    if (!controlsOpen || isPeek || dragging || controlsHovered || controlsRevealNonce < 0) {
      return undefined;
    }
    controlsTimerRef.current = window.setTimeout(
      () => {
        controlsTimerRef.current = null;
        setControlsOpen(false);
        setControlsHovered(false);
      },
      hovered ? 3500 : 1600,
    );
    return () => {
      if (controlsTimerRef.current !== null) {
        window.clearTimeout(controlsTimerRef.current);
        controlsTimerRef.current = null;
      }
    };
  }, [controlsOpen, controlsHovered, hovered, dragging, isPeek, controlsRevealNonce]);

  // Sync overlay state from main process.
  useEffect(() => {
    if (!bridge) return undefined;
    let cancelled = false;
    void bridge.getState().then((initial) => {
      if (!cancelled && initial) setState(initial);
    });
    const unsubscribeState = bridge.onState((next) => {
      setState(next);
    });
    return () => {
      cancelled = true;
      unsubscribeState();
    };
  }, [bridge]);

  // Keep theme and i18n locale in lockstep with the main window.
  useEffect(() => {
    if (!state) return;
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.lang = state.locale;
    if (i18n.resolvedLanguage !== state.locale) {
      void i18n.changeLanguage(state.locale);
    }
  }, [state]);

  // Track live background worker tasks directly via Electron preload bridge.
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
    if (prev > 0 && runningWorkerCount === 0 && state) {
      triggerCelebration({
        text: t(state.isOnChatPage ? 'buddy.bubble.completed' : 'buddy.bubble.completedAway'),
        actionRoute: '/chat',
      });
    }
  }, [runningWorkerCount, state, t, triggerCelebration]);

  // Subscribe to typing, file-drag, file-drop, and brand-summon signals forwarded from AppShell.
  useEffect(() => {
    if (!bridge) return undefined;
    return bridge.onSignal((signal) => {
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
        const wasPeek = state?.dock === 'peek';
        if (wasPeek) {
          hideControls();
          void bridge.updatePrefs({ dock: 'floating' });
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
  }, [bridge, hideControls, showBubble, state?.dock, t]);

  // React to assistant phase transitions with micro-bubbles and completion animations.
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;
    if (prev === phase || !state) return;

    if (phase === 'thinking') {
      showBubble({ text: t('buddy.bubble.thinking') }, 3400);
    } else if (phase === 'organizing') {
      showBubble({ text: t('buddy.bubble.organizing') }, 3200);
    } else if (phase === 'waiting_user') {
      showBubble({ text: t('buddy.bubble.waitingUser'), actionRoute: '/chat' }, 4200);
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
        text: t(state.isOnChatPage ? 'buddy.bubble.completed' : 'buddy.bubble.completedAway'),
        actionRoute: '/chat',
      });
    } else if (phase === 'error') {
      setReplayNonce((n) => n + 1);
      showBubble({ text: t('buddy.bubble.error'), actionRoute: '/chat' }, 4200);
    }
  }, [phase, runningWorkerCount, state, showBubble, triggerCelebration, t]);

  const resolvedClip = resolveBuddyClip({
    flustered,
    poked,
    celebrating,
    phase,
    runningWorkerCount,
  });

  // Low-frequency ambient greeting when idle on the desktop.
  useEffect(() => {
    if (!state?.enabled || isPeek || dragging || !state.bubbles || resolvedClip !== 'idle') {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      if (document.hidden) return;
      const now = Date.now();
      if (now - lastAmbientAtRef.current < 180_000) return;
      lastAmbientAtRef.current = now;
      const key = AMBIENT_BUBBLE_KEYS[Math.floor(Math.random() * AMBIENT_BUBBLE_KEYS.length)]!;
      showBubble({ text: t(key) }, 3400);
    }, 60_000);

    return () => window.clearTimeout(timer);
  }, [state?.enabled, state?.bubbles, isPeek, dragging, resolvedClip, showBubble, t]);

  // Dynamic pixel hit-testing so transparent regions remain completely click-through.
  useEffect(() => {
    if (!bridge) return undefined;

    const updateHitState = (hit: boolean) => {
      const effective = draggingRef.current ? true : hit;
      if (effective !== lastInteractiveRef.current) {
        lastInteractiveRef.current = effective;
        void bridge.setInteractive(effective);
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (draggingRef.current) {
        updateHitState(true);
        return;
      }
      const el = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      updateHitState(Boolean(el?.closest('[data-buddy-hit="true"]')));
    };

    const onLeave = () => {
      if (!draggingRef.current) {
        setHovered(false);
        setControlsHovered(false);
        updateHitState(false);
      }
    };

    const onBlur = () => {
      hideControls();
      setHovered(false);
      if (dragSessionRef.current?.moved) {
        dragSessionRef.current = null;
        if (dragRafRef.current) {
          window.cancelAnimationFrame(dragRafRef.current);
          dragRafRef.current = 0;
        }
        draggingRef.current = false;
        setDragging(false);
        void bridge.dragEnd();
      }
      updateHitState(false);
    };

    document.addEventListener('pointermove', onPointerMove, { passive: true });
    document.documentElement.addEventListener('mouseleave', onLeave);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.documentElement.removeEventListener('mouseleave', onLeave);
      window.removeEventListener('blur', onBlur);
    };
  }, [bridge, hideControls]);

  const handleTap = useCallback(() => {
    if (!bridge || !state) return;
    if (isPeek) {
      hideControls();
      void bridge.updatePrefs({ dock: 'floating' });
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

    revealControls();

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
  }, [bridge, hideControls, isPeek, revealControls, showBubble, state, t]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || isPeek) return;
    if ((event.target as HTMLElement).closest('[data-buddy-control]')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragSessionRef.current = {
      pointerId: event.pointerId,
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      moved: false,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const session = dragSessionRef.current;
    if (!session || session.pointerId !== event.pointerId || isPeek) return;
    const dist = Math.hypot(
      event.screenX - session.startScreenX,
      event.screenY - session.startScreenY,
    );
    if (!session.moved && dist < 6) return;

    if (!session.moved) {
      session.moved = true;
      hideControls();
      draggingRef.current = true;
      lastInteractiveRef.current = true;
      setDragging(true);
      void bridge?.dragStart();
    }

    if (!dragRafRef.current) {
      dragRafRef.current = window.requestAnimationFrame(() => {
        dragRafRef.current = 0;
        if (draggingRef.current) void bridge?.dragMove();
      });
    }
  };

  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const session = dragSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    dragSessionRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (dragRafRef.current) {
      window.cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = 0;
    }

    if (session.moved) {
      draggingRef.current = false;
      setDragging(false);
      void bridge?.dragEnd();
      return;
    }

    if (!cancelled) {
      handleTap();
    }
  };

  if (!state || !state.enabled || !state.desktopFloat) return null;

  const sizePx = SIZE_PIXELS[state.size];

  const hoverStatusBubble: BuddyBubble | null =
    !bubble && hovered && !isPeek && (runningWorkerCount > 0 || BUSY_PHASES.has(phase))
      ? {
          text:
            runningWorkerCount > 0
              ? t('buddy.bubble.workingCount', { count: runningWorkerCount })
              : t(`chat.activity.${phase}`),
          actionRoute: '/chat',
        }
      : null;

  const displayedBubble = !dragging && !isPeek ? (bubble ?? hoverStatusBubble) : null;
  const showSparkles = !isPeek && (poked || celebrating);

  return (
    <div
      className={[
        'buddy-companion pointer-events-none relative flex h-full w-full items-end pb-[24px] select-none',
        isPeek ? 'justify-end' : 'justify-center',
        dragging ? 'buddy-companion-dragging' : '',
        !isPeek && (listening || fileDragging) ? 'buddy-companion-listening' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-live="polite"
    >
      <div
        className={['relative flex items-center justify-center', isPeek ? 'buddy-companion-peek' : '']
          .filter(Boolean)
          .join(' ')}
        style={{ width: `${sizePx}px`, height: `${sizePx}px` }}
      >
        {displayedBubble ? (
          displayedBubble.actionRoute ? (
            <button
              type="button"
              data-buddy-hit="true"
              data-buddy-control="true"
              onClick={() => {
                const target = displayedBubble.actionRoute;
                setBubble(null);
                void bridge?.focusMain(target);
              }}
              className="buddy-companion-bubble buddy-companion-bubble-action pointer-events-auto left-1/2 -translate-x-1/2"
            >
              <span>{displayedBubble.text}</span>
            </button>
          ) : (
            <div
              role="status"
              className="buddy-companion-bubble pointer-events-none left-1/2 -translate-x-1/2"
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
          data-buddy-hit="true"
          aria-label={isPeek ? t('buddy.controls.wake') : t('buddy.controls.dragHint')}
          title={isPeek ? t('buddy.controls.wake') : t('buddy.controls.dragHint')}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onDoubleClick={(event) => {
            if (isPeek) return;
            if ((event.target as HTMLElement).closest('[data-buddy-control]')) return;
            hideControls();
            void bridge?.focusMain('/chat');
          }}
          onPointerDown={(event) => {
            if (isPeek) {
              if (event.button === 0) {
                dragSessionRef.current = {
                  pointerId: event.pointerId,
                  startScreenX: event.screenX,
                  startScreenY: event.screenY,
                  moved: false,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
              }
              return;
            }
            onPointerDown(event);
          }}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => finishPointer(e, false)}
          onPointerCancel={(e) => finishPointer(e, true)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && controlsVisible) {
              event.preventDefault();
              hideControls();
              return;
            }
            if ((event.target as HTMLElement).closest('[data-buddy-control]')) return;
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
              data-buddy-hit={controlsVisible ? 'true' : undefined}
              data-buddy-control={controlsVisible ? 'true' : undefined}
              aria-hidden={!controlsVisible}
              onMouseEnter={() => {
                if (controlsVisible) setControlsHovered(true);
              }}
              onMouseLeave={() => setControlsHovered(false)}
              className={[
                'buddy-companion-controls absolute -bottom-1 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full px-1.5 py-0.5 transition-[opacity,transform] duration-150',
                controlsVisible
                  ? 'pointer-events-auto translate-y-0 opacity-100'
                  : 'pointer-events-none translate-y-1 opacity-0',
              ].join(' ')}
            >
              <button
                type="button"
                tabIndex={controlsVisible ? 0 : -1}
                onClick={() => {
                  hideControls();
                  void bridge?.updatePrefs({ dock: 'peek' });
                }}
                title={t('buddy.controls.peek')}
                aria-label={t('buddy.controls.peek')}
                className="buddy-companion-ctrl-btn"
              >
                <ChevronRight size={13} strokeWidth={2.2} />
              </button>
              <button
                type="button"
                tabIndex={controlsVisible ? 0 : -1}
                onClick={() => {
                  revealControls();
                  void bridge?.updatePrefs({ size: NEXT_SIZE[state.size] });
                }}
                title={t('buddy.controls.cycleSize')}
                aria-label={t('buddy.controls.cycleSize')}
                className="buddy-companion-ctrl-btn"
              >
                {state.size === 'lg' ? (
                  <Minimize2 size={12} strokeWidth={2.2} />
                ) : (
                  <Maximize2 size={12} strokeWidth={2.2} />
                )}
              </button>
              {state.screenPosition ? (
                <button
                  type="button"
                  tabIndex={controlsVisible ? 0 : -1}
                  onClick={() => {
                    hideControls();
                    void bridge?.resetPosition();
                  }}
                  title={t('buddy.controls.resetPos')}
                  aria-label={t('buddy.controls.resetPos')}
                  className="buddy-companion-ctrl-btn"
                >
                  <RotateCcw size={12} strokeWidth={2.2} />
                </button>
              ) : null}
              <button
                type="button"
                tabIndex={controlsVisible ? 0 : -1}
                onClick={() => {
                  hideControls();
                  void bridge?.focusMain();
                }}
                title={t('buddy.controls.focusMain')}
                aria-label={t('buddy.controls.focusMain')}
                className="buddy-companion-ctrl-btn"
              >
                <AppWindow size={12} strokeWidth={2.2} />
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
