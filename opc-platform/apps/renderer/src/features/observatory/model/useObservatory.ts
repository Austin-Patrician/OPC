import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ObservatoryRouterEvent,
  ObservatorySnapshot,
  ObservatoryTaskDetail,
  ObservatoryThreadItem,
} from '@opc/shared/domain';

export type ObservatoryTab = 'workers' | 'router';
export type ObservatoryStatusKind = 'idle' | 'active' | 'blocked' | 'error';

export interface ObservatoryBadgeSummary {
  status: ObservatoryStatusKind;
  activeCount: number;
  blockedCount: number;
  errorCount: number;
  routerBusy: boolean;
}

export interface LiveWorkerToolActivity {
  taskId: string;
  toolName: string;
  argsDigest: string;
  startedAt: number;
}

function pickInitialThreadId(
  items: readonly ObservatoryThreadItem[],
  currentId: string | null,
): string | null {
  if (currentId && items.some((item) => item.threadId === currentId)) {
    return currentId;
  }
  const blocked = items.find(
    (item) =>
      item.blocker?.kind === 'approval' ||
      item.blocker?.kind === 'question' ||
      item.blocker?.kind === 'waiting_children',
  );
  if (blocked) return blocked.threadId;
  const active = items.find(
    (item) => item.latestTask?.status === 'running' || item.state === 'running',
  );
  if (active) return active.threadId;
  const first = items[0];
  return first ? first.threadId : null;
}

export function useObservatory(open: boolean) {
  const [snapshot, setSnapshot] = useState<ObservatorySnapshot | null>(null);
  const [selectedTab, setSelectedTab] = useState<ObservatoryTab>('workers');
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskDetail, setTaskDetail] = useState<ObservatoryTaskDetail | null>(null);
  const [liveToolsByTask, setLiveToolsByTask] = useState<Record<string, LiveWorkerToolActivity>>({});
  const [loading, setLoading] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [badgeState, setBadgeState] = useState<{
    activeCount: number;
    blockedCount: number;
    errorCount: number;
    routerPhase: string;
  }>({
    activeCount: 0,
    blockedCount: 0,
    errorCount: 0,
    routerPhase: 'idle',
  });

  const openRef = useRef(open);
  openRef.current = open;
  const selectedThreadIdRef = useRef(selectedThreadId);
  selectedThreadIdRef.current = selectedThreadId;
  const selectedTaskIdRef = useRef(selectedTaskId);
  selectedTaskIdRef.current = selectedTaskId;
  const detailSeqRef = useRef(0);
  const refreshTimerRef = useRef<number | null>(null);
  const detailTimerRef = useRef<number | null>(null);
  const wasOpenRef = useRef(false);
  const pendingFocusRef = useRef<{ threadId: string; taskId?: string } | null>(null);

  const loadDetailForThread = useCallback(
    async (
      snap: ObservatorySnapshot,
      threadId: string | null,
      preferredTaskId?: string | null,
      options?: { silent?: boolean },
    ) => {
      const bridge = window.opc?.observatory;
      if (!bridge || !threadId) {
        selectedTaskIdRef.current = null;
        setSelectedTaskId(null);
        setTaskDetail(null);
        return;
      }
      const item = snap.threads.find((entry) => entry.threadId === threadId);
      const validExplicit =
        preferredTaskId && item?.tasks?.some((t) => t.id === preferredTaskId)
          ? preferredTaskId
          : null;
      const taskId = validExplicit ?? item?.latestTask?.id ?? null;
      selectedTaskIdRef.current = taskId;
      setSelectedTaskId(taskId);
      if (!taskId) {
        setTaskDetail(null);
        return;
      }
      const seq = ++detailSeqRef.current;
      if (!options?.silent) setLoadingDetail(true);
      try {
        const detail = await bridge.taskDetail(taskId);
        if (
          detailSeqRef.current === seq &&
          selectedThreadIdRef.current === threadId &&
          selectedTaskIdRef.current === taskId
        ) {
          setTaskDetail(detail);
        }
      } catch (err) {
        if (detailSeqRef.current === seq) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!options?.silent && detailSeqRef.current === seq) {
          setLoadingDetail(false);
        }
      }
    },
    [],
  );

  const refreshTaskDetailDirect = useCallback((taskId: string) => {
    const bridge = window.opc?.observatory;
    if (!bridge || !openRef.current || detailTimerRef.current !== null) return;
    // Coalesce without resetting so continuous tool completions flush promptly.
    detailTimerRef.current = window.setTimeout(() => {
      detailTimerRef.current = null;
      if (!openRef.current || selectedTaskIdRef.current !== taskId) return;
      const seq = ++detailSeqRef.current;
      void bridge
        .taskDetail(taskId)
        .then((detail) => {
          if (detailSeqRef.current === seq && selectedTaskIdRef.current === taskId) {
            setTaskDetail(detail);
          }
        })
        .catch(() => undefined);
    }, 90);
  }, []);

  const refresh = useCallback(
    async (options?: {
      focusPriority?: boolean;
      targetThreadId?: string;
      targetTaskId?: string | null;
      silent?: boolean;
    }) => {
      const bridge = window.opc?.observatory;
      if (!bridge) return;
      if (openRef.current && !options?.silent) setLoading(true);
      try {
        const next = await bridge.snapshot();
        setSnapshot(next);
        setBadgeState({
          activeCount: next.activeCount,
          blockedCount: next.blockedCount,
          errorCount: next.errorCount,
          routerPhase: next.router.phase,
        });
        setError(null);

        const preferredThreadId = options?.targetThreadId
          ? pickInitialThreadId(next.threads, options.targetThreadId)
          : options?.focusPriority
            ? pickInitialThreadId(next.threads, null)
            : pickInitialThreadId(next.threads, selectedThreadIdRef.current);

        selectedThreadIdRef.current = preferredThreadId;
        setSelectedThreadId(preferredThreadId);

        if (
          !options?.targetThreadId &&
          options?.focusPriority &&
          next.blockedCount === 0 &&
          next.activeCount === 0 &&
          (next.router.phase === 'thinking' ||
            next.router.phase === 'tool' ||
            next.router.phase === 'compacting')
        ) {
          setSelectedTab('router');
        }

        if (openRef.current && preferredThreadId) {
          const targetTaskId = options?.targetThreadId
            ? (options.targetTaskId ?? null)
            : options?.focusPriority
              ? null
              : selectedTaskIdRef.current;
          await loadDetailForThread(next, preferredThreadId, targetTaskId, {
            silent: options?.silent,
          });
        } else if (!preferredThreadId) {
          selectedTaskIdRef.current = null;
          setSelectedTaskId(null);
          setTaskDetail(null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!options?.silent) setLoading(false);
      }
    },
    [loadDetailForThread],
  );

  const scheduleRefresh = useCallback(
    (delayMs = 200) => {
      // Never cancel an already-scheduled refresh on continuous bursts (prevents starvation).
      if (refreshTimerRef.current !== null) return;
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        void refresh({ silent: true });
      }, delayMs);
    },
    [refresh],
  );

  // Hydrate badge counts on mount & refresh when opening the drawer.
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (justOpened) {
      const pending = pendingFocusRef.current;
      pendingFocusRef.current = null;
      if (pending) {
        void refresh({
          targetThreadId: pending.threadId,
          targetTaskId: pending.taskId ?? null,
        });
      } else {
        void refresh({ focusPriority: true });
      }
    } else if (!snapshot) {
      void refresh();
    }
  }, [open, refresh, snapshot]);

  // Subscribe to real-time Worker & Router sideband streams.
  useEffect(() => {
    const unsubs: Array<() => void> = [];

    const onProgress = window.opc?.work?.onProgress;
    if (onProgress) {
      unsubs.push(
        onProgress((event) => {
          const isToolStart =
            event.phase === 'tool_start' ||
            (event.phase === undefined &&
              event.state === 'running' &&
              event.ok === null &&
              event.toolName !== 'lifecycle');

          setLiveToolsByTask((prev) => {
            if (isToolStart) {
              return {
                ...prev,
                [event.taskId]: {
                  taskId: event.taskId,
                  toolName: event.toolName,
                  argsDigest: event.argsDigest ?? event.summary,
                  startedAt: event.at,
                },
              };
            }
            if (!(event.taskId in prev)) return prev;
            const next = { ...prev };
            delete next[event.taskId];
            return next;
          });

          if (openRef.current && event.taskId === selectedTaskIdRef.current && !isToolStart) {
            refreshTaskDetailDirect(event.taskId);
          }
          scheduleRefresh(openRef.current ? 280 : 600);
        }),
      );
    }

    const onTaskChanged = window.opc?.work?.onTaskChanged;
    if (onTaskChanged) {
      unsubs.push(
        onTaskChanged((task) => {
          if (task.status !== 'running') {
            setLiveToolsByTask((prev) => {
              if (!(task.id in prev)) return prev;
              const next = { ...prev };
              delete next[task.id];
              return next;
            });
          }
          if (openRef.current && task.id === selectedTaskIdRef.current) {
            refreshTaskDetailDirect(task.id);
          }
          scheduleRefresh(openRef.current ? 220 : 500);
        }),
      );
    }

    const onRouterEvent = window.opc?.observatory?.onRouterEvent;
    if (onRouterEvent) {
      unsubs.push(
        onRouterEvent((event: ObservatoryRouterEvent) => {
          if (event.type === 'state') {
            const nextState = event.state;
            setBadgeState((prev) => ({
              ...prev,
              routerPhase: nextState.phase,
            }));
            setSnapshot((prev) => (prev ? { ...prev, router: nextState } : prev));
            return;
          }
          setBadgeState((prev) => ({
            ...prev,
            routerPhase: event.phase,
          }));
          setSnapshot((prev) => {
            if (!prev) return prev;
            const exists = prev.router.trace.some((entry) => entry.id === event.entry.id);
            const nextTrace = exists
              ? prev.router.trace
              : [...prev.router.trace, event.entry].slice(-150);
            return {
              ...prev,
              router: {
                ...prev.router,
                phase: event.phase,
                ...(event.activeTool ? { activeTool: event.activeTool } : { activeTool: undefined }),
                trace: nextTrace,
              },
            };
          });
          if (openRef.current && event.entry.kind === 'turn') {
            scheduleRefresh(220);
          }
        }),
      );
    }

    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      if (detailTimerRef.current !== null) {
        window.clearTimeout(detailTimerRef.current);
        detailTimerRef.current = null;
      }
      for (const unsub of unsubs) {
        try {
          unsub();
        } catch {
          // Ignore teardown errors.
        }
      }
    };
  }, [refreshTaskDetailDirect, scheduleRefresh]);

  const selectThread = useCallback(
    (threadId: string) => {
      selectedThreadIdRef.current = threadId;
      selectedTaskIdRef.current = null;
      setSelectedThreadId(threadId);
      setSelectedTaskId(null);
      setTaskDetail(null);
      if (snapshot) {
        void loadDetailForThread(snapshot, threadId, null);
      }
    },
    [loadDetailForThread, snapshot],
  );

  const selectTask = useCallback(
    (taskId: string) => {
      selectedTaskIdRef.current = taskId;
      setSelectedTaskId(taskId);
      if (snapshot && selectedThreadIdRef.current) {
        void loadDetailForThread(snapshot, selectedThreadIdRef.current, taskId);
      }
    },
    [loadDetailForThread, snapshot],
  );

  const jumpToThread = useCallback(
    (threadId: string) => {
      setSelectedTab('workers');
      selectedThreadIdRef.current = threadId;
      selectedTaskIdRef.current = null;
      setSelectedThreadId(threadId);
      setSelectedTaskId(null);
      setTaskDetail(null);
      if (snapshot) {
        void loadDetailForThread(snapshot, threadId, null);
      } else {
        void refresh();
      }
    },
    [loadDetailForThread, refresh, snapshot],
  );

  const focusTarget = useCallback(
    (threadId: string, taskId?: string) => {
      setSelectedTab('workers');
      selectedThreadIdRef.current = threadId;
      selectedTaskIdRef.current = taskId ?? null;
      setSelectedThreadId(threadId);
      setSelectedTaskId(taskId ?? null);
      if (openRef.current) {
        pendingFocusRef.current = null;
        void refresh({ targetThreadId: threadId, targetTaskId: taskId ?? null });
      } else {
        pendingFocusRef.current = {
          threadId,
          ...(taskId ? { taskId } : {}),
        };
      }
    },
    [refresh],
  );

  const approveBlocker = useCallback(
    async (reportId: string, allow: boolean, scope: 'once' | 'task' = 'task') => {
      const threadsBridge = window.opc?.threads;
      if (!threadsBridge) return;
      setActionBusy(true);
      try {
        await threadsBridge.answer({
          reportId,
          text: allow ? '允许执行' : '拒绝执行',
          allow,
          scope,
        });
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setActionBusy(false);
      }
    },
    [refresh],
  );

  const answerQuestion = useCallback(
    async (reportId: string, text: string) => {
      const trimmed = text.trim();
      const threadsBridge = window.opc?.threads;
      if (!threadsBridge || !trimmed) return;
      setActionBusy(true);
      try {
        await threadsBridge.answer({ reportId, text: trimmed });
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setActionBusy(false);
      }
    },
    [refresh],
  );

  const abortThread = useCallback(
    async (threadId: string) => {
      const workBridge = window.opc?.work;
      if (!workBridge) return;
      setActionBusy(true);
      try {
        await workBridge.abortThread(threadId, '用户在执行透视中中止');
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setActionBusy(false);
      }
    },
    [refresh],
  );

  const openWorkspace = useCallback(async (taskId: string) => {
    const bridge = window.opc?.observatory;
    if (!bridge) return;
    const res = await bridge.openWorkspace(taskId);
    if (!res.ok && res.error) setError(res.error);
  }, []);

  const revealArtifact = useCallback(async (taskId: string, relPath: string) => {
    const bridge = window.opc?.observatory;
    if (!bridge) return;
    const res = await bridge.revealArtifact(taskId, relPath);
    if (!res.ok && res.error) setError(res.error);
  }, []);

  const compactRouter = useCallback(async () => {
    const chatBridge = window.opc?.chat;
    if (!chatBridge) return;
    setActionBusy(true);
    try {
      await chatBridge.compactContext();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  }, [refresh]);

  const badge: ObservatoryBadgeSummary = useMemo(() => {
    const routerBusy =
      badgeState.routerPhase === 'thinking' ||
      badgeState.routerPhase === 'tool' ||
      badgeState.routerPhase === 'compacting';
    let status: ObservatoryStatusKind = 'idle';
    if (badgeState.blockedCount > 0) status = 'blocked';
    else if (badgeState.errorCount > 0 || badgeState.routerPhase === 'error') status = 'error';
    else if (badgeState.activeCount > 0 || routerBusy) status = 'active';
    return {
      status,
      activeCount: badgeState.activeCount,
      blockedCount: badgeState.blockedCount,
      errorCount: badgeState.errorCount,
      routerBusy,
    };
  }, [badgeState]);

  const selectedThread = useMemo(
    () => snapshot?.threads.find((item) => item.threadId === selectedThreadId) ?? null,
    [snapshot, selectedThreadId],
  );

  const liveToolForSelectedTask = useMemo(() => {
    const activeId = selectedTaskId ?? selectedThread?.latestTask?.id ?? null;
    return activeId ? (liveToolsByTask[activeId] ?? null) : null;
  }, [liveToolsByTask, selectedTaskId, selectedThread]);

  return {
    snapshot,
    selectedTab,
    setSelectedTab,
    selectedThreadId,
    selectedTaskId,
    selectedThread,
    taskDetail,
    liveToolForSelectedTask,
    loading,
    loadingDetail,
    actionBusy,
    error,
    badge,
    refresh,
    selectThread,
    selectTask,
    jumpToThread,
    focusTarget,
    approveBlocker,
    answerQuestion,
    abortThread,
    openWorkspace,
    revealArtifact,
    compactRouter,
  };
}
