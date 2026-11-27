import { useEffect, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { useObservatory } from '../model/useObservatory';
import { RouterInspectorPane } from './RouterInspectorPane';
import { WorkerInspectorPane } from './WorkerInspectorPane';

const STORAGE_WIDTH_KEY = 'opc.observatory.width';
const MIN_WIDTH = 360;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 420;
const WIDE_BREAKPOINT = 1100;

function readInitialWidth(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_WIDTH_KEY);
    const parsed = raw ? Number(raw) : NaN;
    if (Number.isFinite(parsed)) {
      return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, parsed));
    }
  } catch {
    // Ignore storage access errors.
  }
  return DEFAULT_WIDTH;
}

interface ExecutionObservatoryDrawerProps {
  open: boolean;
  onClose: () => void;
  observatory: ReturnType<typeof useObservatory>;
}

export function ExecutionObservatoryDrawer({
  open,
  onClose,
  observatory,
}: ExecutionObservatoryDrawerProps) {
  const { t } = useTranslation();
  const [width, setWidth] = useState<number>(readInitialWidth);
  const [wide, setWide] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth >= WIDE_BREAKPOINT : true,
  );
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    const onResize = () => {
      setWide(window.innerWidth >= WIDE_BREAKPOINT);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (!open || wide) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open, wide]);

  const startResize = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    setResizing(true);

    const onMouseMove = (moveEvent: MouseEvent) => {
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + (startX - moveEvent.clientX)));
      setWidth(next);
    };

    const onMouseUp = (upEvent: MouseEvent) => {
      const finalWidth = Math.min(
        MAX_WIDTH,
        Math.max(MIN_WIDTH, startWidth + (startX - upEvent.clientX)),
      );
      setWidth(finalWidth);
      setResizing(false);
      try {
        window.localStorage.setItem(STORAGE_WIDTH_KEY, String(finalWidth));
      } catch {
        // Ignore storage write errors.
      }
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  if (!open) return null;

  const workerCountBadge = observatory.badge.blockedCount > 0
    ? { label: observatory.badge.blockedCount, tone: 'warning' as const }
    : observatory.badge.activeCount > 0
      ? { label: observatory.badge.activeCount, tone: 'accent' as const }
      : null;

  const workersActive = observatory.selectedTab === 'workers';
  const routerActive = observatory.selectedTab === 'router';

  const content = (
    <aside
      aria-label={t('observatory.title')}
      data-layout={wide ? 'docked' : 'overlay'}
      style={wide ? { width: `${width}px` } : { width: 'min(92vw, 440px)' }}
      className={`observatory-drawer relative flex h-full min-h-0 shrink-0 flex-col border-l border-line bg-panel ${
        wide ? '' : 'shadow-2xl'
      } ${resizing ? 'select-none' : ''}`}
    >
      {wide ? (
        <div
          role="separator"
          aria-orientation="vertical"
          onMouseDown={startResize}
          className="observatory-resize-handle absolute inset-y-3 left-0 z-20 w-[6px] -translate-x-1/2 cursor-col-resize rounded-full"
        />
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
        {/* Layer 1: Minimal 40px underline tab bar */}
        <div className="flex h-[40px] shrink-0 items-stretch justify-between border-b border-line px-3.5">
          <div className="flex items-stretch gap-5">
            <button
              type="button"
              onClick={() => observatory.setSelectedTab('workers')}
              className={`relative inline-flex items-center gap-1.5 text-xs font-medium transition ${
                workersActive ? 'text-ink' : 'text-ink-tertiary hover:text-ink-secondary'
              }`}
            >
              <span>{t('observatory.tabs.workers')}</span>
              {workerCountBadge ? (
                <span
                  className={`rounded-full px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none tabular-nums ${
                    workerCountBadge.tone === 'warning'
                      ? 'bg-warning/18 text-warning'
                      : 'bg-accent-soft text-accent-ink'
                  }`}
                >
                  {workerCountBadge.label}
                </span>
              ) : null}
              {workersActive ? (
                <span className="absolute inset-x-0 bottom-0 h-[2px] rounded-full bg-accent" />
              ) : null}
            </button>

            <button
              type="button"
              onClick={() => observatory.setSelectedTab('router')}
              className={`relative inline-flex items-center gap-1.5 text-xs font-medium transition ${
                routerActive ? 'text-ink' : 'text-ink-tertiary hover:text-ink-secondary'
              }`}
            >
              <span>{t('observatory.tabs.router')}</span>
              {observatory.badge.routerBusy ? (
                <span className="h-1.5 w-1.5 rounded-full bg-accent observatory-dot-pulse" />
              ) : null}
              {routerActive ? (
                <span className="absolute inset-x-0 bottom-0 h-[2px] rounded-full bg-accent" />
              ) : null}
            </button>
          </div>

          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => void observatory.refresh()}
              disabled={observatory.loading}
              aria-label={t('observatory.refresh')}
              title={t('observatory.refresh')}
              className="buddy-header-action"
            >
              <RefreshCw
                size={13.5}
                strokeWidth={1.8}
                className={observatory.loading ? 'animate-spin' : ''}
              />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('common.close')}
              title={t('observatory.closeHint')}
              className="buddy-header-action"
            >
              <X size={14.5} strokeWidth={1.8} />
            </button>
          </div>
        </div>

        {observatory.error ? (
          <div className="shrink-0 border-b border-line bg-danger/10 px-3.5 py-1.5 text-[11.5px] text-danger">
            {observatory.error}
          </div>
        ) : null}

        {workersActive ? (
          <WorkerInspectorPane
            threads={observatory.snapshot?.threads ?? []}
            selectedThreadId={observatory.selectedThreadId}
            selectedTaskId={observatory.selectedTaskId}
            selectedThread={observatory.selectedThread}
            taskDetail={observatory.taskDetail}
            liveTool={observatory.liveToolForSelectedTask}
            loadingDetail={observatory.loadingDetail}
            actionBusy={observatory.actionBusy}
            onSelectThread={observatory.selectThread}
            onSelectTask={observatory.selectTask}
            onApproveBlocker={observatory.approveBlocker}
            onAnswerQuestion={observatory.answerQuestion}
            onAbortThread={observatory.abortThread}
            onOpenWorkspace={observatory.openWorkspace}
            onRevealArtifact={observatory.revealArtifact}
          />
        ) : (
          <RouterInspectorPane
            router={observatory.snapshot?.router ?? null}
            actionBusy={observatory.actionBusy}
            onCompact={observatory.compactRouter}
            onJumpToThread={observatory.jumpToThread}
          />
        )}
      </div>
    </aside>
  );

  if (wide) return content;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 bg-black/20 backdrop-blur-[2px]"
      />
      <div className="relative z-10 h-full">{content}</div>
    </div>
  );
}
