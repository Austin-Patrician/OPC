import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  FolderOpen,
  FolderSearch,
  Layers,
  OctagonX,
  Paperclip,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  partitionTaskArtifacts,
  type ObservatoryBlocker,
  type ObservatoryTaskDetail,
  type ObservatoryThreadItem,
  type TaskArtifact,
  type TaskTrace,
} from '@opc/shared/domain';
import {
  groupWorkerTrace,
  type WorkerTraceDisplayItem,
} from '../model/traceFolding';
import {
  formatCostCompact,
  formatDurationCompact,
  formatStepMs,
  formatTokensCompact,
  isSlowStepMs,
  shortModelName,
} from '../model/formatters';
import { openDocPreview } from '@/shared/model/docPreviewStore';
import type { LiveWorkerToolActivity } from '../model/useObservatory';
import { CompactMarkdown } from './CompactMarkdown';
import {
  APPROVAL_VISUAL,
  EMPTY_STATE_VISUAL,
  ERROR_STATE_VISUAL,
  ObservatoryIcon,
  resolveArtifactVisual,
  resolveToolVisual,
} from './observatoryIcons';

type DetailSubTab = 'trace' | 'artifacts' | 'contract';

interface WorkerInspectorPaneProps {
  threads: readonly ObservatoryThreadItem[];
  selectedThreadId: string | null;
  selectedTaskId: string | null;
  selectedThread: ObservatoryThreadItem | null;
  taskDetail: ObservatoryTaskDetail | null;
  liveTool?: LiveWorkerToolActivity | null;
  loadingDetail: boolean;
  actionBusy: boolean;
  onSelectThread: (threadId: string) => void;
  onSelectTask: (taskId: string) => void;
  onApproveBlocker: (reportId: string, allow: boolean) => Promise<void>;
  onAnswerQuestion: (reportId: string, text: string) => Promise<void>;
  onAbortThread: (threadId: string) => Promise<void>;
  onOpenWorkspace: (taskId: string) => Promise<void>;
  onRevealArtifact: (taskId: string, relPath: string) => Promise<void>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function statusDotClass(item: ObservatoryThreadItem): string {
  if (item.blocker && item.blocker.kind !== 'error') {
    return 'bg-warning observatory-dot-pulse';
  }
  if (
    item.blocker?.kind === 'error' ||
    item.latestTask?.status === 'failed' ||
    item.latestTask?.status === 'rejected'
  ) {
    return 'bg-danger';
  }
  if (item.latestTask?.status === 'running' || item.state === 'running') {
    return 'bg-accent observatory-dot-pulse';
  }
  if (item.latestTask?.status === 'accepted' || item.latestTask?.status === 'delivered') {
    return 'bg-success';
  }
  return 'bg-ink-quaternary';
}

function ThreadPicker({
  threads,
  selectedThread,
  onSelect,
}: {
  threads: readonly ObservatoryThreadItem[];
  selectedThread: ObservatoryThreadItem | null;
  onSelect: (threadId: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const grouped = useMemo(() => {
    const blocked: ObservatoryThreadItem[] = [];
    const active: ObservatoryThreadItem[] = [];
    const recent: ObservatoryThreadItem[] = [];
    for (const item of threads) {
      if (item.blocker && item.blocker.kind !== 'error') {
        blocked.push(item);
      } else if (item.latestTask?.status === 'running' || item.state === 'running') {
        active.push(item);
      } else {
        recent.push(item);
      }
    }
    return [
      { key: 'blocked' as const, label: t('observatory.threadPicker.blockedGroup'), items: blocked },
      { key: 'active' as const, label: t('observatory.threadPicker.activeGroup'), items: active },
      { key: 'recent' as const, label: t('observatory.threadPicker.recentGroup'), items: recent },
    ].filter((section) => section.items.length > 0);
  }, [t, threads]);

  if (!selectedThread) {
    return (
      <span className="truncate text-xs text-ink-tertiary">
        {t('observatory.noThreads')}
      </span>
    );
  }

  return (
    <div ref={rootRef} className="relative min-w-0 flex-1">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition hover:bg-surface-hover"
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass(selectedThread)}`} />
        <span className="truncate text-xs font-semibold text-ink">
          {selectedThread.title}
        </span>
        {threads.length > 1 ? (
          <span className="shrink-0 rounded bg-surface-muted px-1 py-0.5 font-mono text-[10px] tabular-nums text-ink-tertiary">
            {threads.length}
          </span>
        ) : null}
        <ChevronDown
          size={13}
          className={`shrink-0 text-ink-tertiary transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open ? (
        <div
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-xl border border-line bg-surface p-1.5"
          style={{ boxShadow: 'var(--shadow-popover)' }}
        >
          {grouped.map((section) => (
            <div key={section.key} className="mb-1 last:mb-0">
              <div className="px-2 py-1 text-[10.5px] font-medium text-ink-quaternary">
                {section.label}
              </div>
              {section.items.map((item) => {
                const isSelected = item.threadId === selectedThread.threadId;
                return (
                  <button
                    key={item.threadId}
                    type="button"
                    onClick={() => {
                      onSelect(item.threadId);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition ${
                      isSelected
                        ? 'bg-accent-soft/65 text-ink'
                        : 'text-ink-secondary hover:bg-surface-hover hover:text-ink'
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(item)}`} />
                      <span className="truncate text-xs font-medium">{item.title}</span>
                    </div>
                    <span className="shrink-0 font-mono text-[10.5px] text-ink-tertiary">
                      {item.worker?.name ?? '—'}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function BlockerFocalCard({
  blocker,
  actionBusy,
  now,
  onApprove,
  onAnswer,
}: {
  blocker: ObservatoryBlocker;
  actionBusy: boolean;
  now: number;
  onApprove: (reportId: string, allow: boolean) => Promise<void>;
  onAnswer: (reportId: string, text: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [replyText, setReplyText] = useState('');

  if (blocker.kind === 'approval') {
    return (
      <div
        className="rounded-lg border border-line border-l-[3px] px-3 py-2.5"
        style={{
          borderLeftColor: 'var(--warning)',
          background: 'color-mix(in srgb, var(--warning) 8%, var(--surface))',
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-warning">
            <ObservatoryIcon visual={APPROVAL_VISUAL} size={14} />
            <span>{t('observatory.blocker.approvalTitle')}</span>
            {blocker.tool ? (
              <span className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-ink">
                {blocker.tool}
              </span>
            ) : null}
          </div>
          <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-ink-tertiary">
            {formatDurationCompact(now - blocker.createdAt)}
          </span>
        </div>
        <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink-secondary">
          {blocker.body}
        </p>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            disabled={actionBusy}
            onClick={() => void onApprove(blocker.reportId, true)}
            className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[11.5px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-50"
          >
            <Check size={12.5} strokeWidth={2.2} />
            <span>{t('observatory.blocker.allowInTask')}</span>
          </button>
          <button
            type="button"
            disabled={actionBusy}
            onClick={() => void onApprove(blocker.reportId, false)}
            className="inline-flex items-center gap-1 rounded-md border border-line-strong bg-surface px-2.5 py-1 text-[11.5px] font-medium text-ink-secondary transition hover:bg-surface-hover hover:text-ink disabled:opacity-50"
          >
            <X size={12.5} strokeWidth={2} />
            <span>{t('observatory.blocker.deny')}</span>
          </button>
        </div>
      </div>
    );
  }

  if (blocker.kind === 'question') {
    return (
      <div
        className="rounded-lg border border-line border-l-[3px] px-3 py-2.5"
        style={{
          borderLeftColor: 'var(--accent)',
          background: 'color-mix(in srgb, var(--accent) 7%, var(--surface))',
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-accent-ink">
            <ObservatoryIcon visual={APPROVAL_VISUAL} size={14} className="!text-accent-ink" />
            <span>{t('observatory.blocker.questionTitle')}</span>
          </div>
          <span className="font-mono text-[10.5px] tabular-nums text-ink-tertiary">
            {formatDurationCompact(now - blocker.createdAt)}
          </span>
        </div>
        <CompactMarkdown
          text={blocker.body}
          className="mt-1.5 text-xs leading-relaxed text-ink-secondary"
        />
        <form
          className="mt-2 flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!replyText.trim() || actionBusy) return;
            const payload = replyText.trim();
            setReplyText('');
            void onAnswer(blocker.reportId, payload);
          }}
        >
          <input
            type="text"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            placeholder={t('observatory.blocker.questionPlaceholder')}
            className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={actionBusy || !replyText.trim()}
            className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-[11.5px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-50"
          >
            {t('common.send')}
          </button>
        </form>
      </div>
    );
  }

  if (blocker.kind === 'waiting_children') {
    return (
      <div
        className="rounded-lg border border-line border-l-[3px] px-3 py-2"
        style={{
          borderLeftColor: 'var(--text-tertiary)',
          background: 'var(--surface-muted)',
        }}
      >
        <div className="flex items-center gap-1.5 text-xs font-medium text-ink">
          <Layers size={13.5} strokeWidth={1.8} />
          <span>{t('observatory.blocker.waitingChildren', { count: blocker.children.length })}</span>
        </div>
        <div className="mt-1 space-y-0.5">
          {blocker.children.map((child) => (
            <div
              key={child.id}
              className="flex items-center justify-between gap-2 text-[11px] text-ink-secondary"
            >
              <span className="truncate">{child.title}</span>
              <span className="shrink-0 font-mono text-[10px] text-ink-tertiary">
                {child.status}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      className="rounded-lg border border-line border-l-[3px] px-3 py-2.5"
      style={{
        borderLeftColor: 'var(--danger)',
        background: 'color-mix(in srgb, var(--danger) 8%, var(--surface))',
      }}
    >
      <div className="flex items-center justify-between gap-2 text-xs font-semibold text-danger">
        <span className="flex items-center gap-1.5">
          <ObservatoryIcon visual={ERROR_STATE_VISUAL} size={14} />
          {t('observatory.blocker.errorTitle')}
        </span>
        {typeof blocker.exitCode === 'number' ? (
          <span className="font-mono text-[10.5px] opacity-85">
            exit {blocker.exitCode}
          </span>
        ) : null}
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-ink">
        {blocker.message}
      </p>
      {blocker.stderrTail ? (
        <pre
          className="mt-1.5 max-h-24 overflow-auto rounded p-2 font-mono text-[10.5px] leading-snug text-ink-secondary"
          style={{ background: 'var(--code-bg)' }}
        >
          {blocker.stderrTail}
        </pre>
      ) : null}
    </div>
  );
}

function StepRailRow({
  entry,
  indented = false,
}: {
  entry: TaskTrace;
  indented?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const visual = resolveToolVisual(entry.name, entry.argsDigest);
  const isError = entry.ok === false;
  const slow = !isError && isSlowStepMs(entry.ms);

  return (
    <div className={`relative ${indented ? 'pl-5' : 'pl-6'}`}>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className={`group flex w-full items-start justify-between gap-2 rounded-md px-1.5 py-1 text-left transition ${
          isError
            ? 'bg-danger/8 hover:bg-danger/12'
            : expanded
              ? 'bg-surface-hover/80'
              : 'hover:bg-surface-hover/65'
        }`}
      >
        <span
          className="observatory-rail-node absolute left-[1px] top-[5px] flex h-[18px] w-[18px] items-center justify-center rounded bg-panel"
        >
          <ObservatoryIcon
            visual={visual}
            size={14}
            className={isError ? '!text-danger' : ''}
          />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span
              className={`shrink-0 font-mono text-[11.5px] font-medium ${
                isError ? 'text-danger' : 'text-ink'
              }`}
            >
              {entry.name}
            </span>
            {entry.argsDigest ? (
              <span className="truncate font-mono text-[11px] text-ink-secondary">
                {entry.argsDigest}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5 pt-0.5 font-mono text-[10.5px] tabular-nums text-ink-tertiary">
          {typeof entry.ms === 'number' ? (
            <span className={slow ? 'font-medium text-warning' : ''}>
              {formatStepMs(entry.ms)}
            </span>
          ) : null}
          <span
            className={
              isError
                ? 'text-danger'
                : entry.ok === true
                  ? 'text-success'
                  : 'text-ink-quaternary'
            }
          >
            {isError ? '✗' : entry.ok === true ? '✓' : '·'}
          </span>
        </div>
      </button>

      {expanded ? (
        <div
          className="mx-1.5 mb-1.5 mt-0.5 rounded-md border border-line px-2.5 py-2 font-mono text-[10.5px] text-ink-secondary"
          style={{ background: 'var(--code-bg)' }}
        >
          <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-ink-quaternary">
            <span>#{entry.seq}</span>
            <span>{formatTime(entry.at)}</span>
            {typeof entry.tokens === 'number' ? <span>{entry.tokens} tok</span> : null}
          </div>
          <div className="whitespace-pre-wrap break-all text-ink">
            {entry.argsDigest || entry.name}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function BurstRailRow({
  item,
}: {
  item: Extract<WorkerTraceDisplayItem, { kind: 'burst' }>;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const visual = resolveToolVisual(item.representative.name, item.representative.argsDigest);

  return (
    <div className="relative pl-6">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left transition hover:bg-surface-hover/65"
      >
        <span className="observatory-rail-node absolute left-[1px] top-[5px] flex h-[18px] w-[18px] items-center justify-center rounded bg-panel">
          <ObservatoryIcon visual={visual} size={14} />
        </span>

        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="shrink-0 text-[11.5px] font-medium text-ink-secondary">
            {t('observatory.trace.burstLabel', { count: item.items.length })}
          </span>
          <span className="truncate font-mono text-[10.5px] text-ink-tertiary">
            {item.sampleDigest}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] tabular-nums text-ink-tertiary">
          {item.totalMs > 0 ? (
            <span className={isSlowStepMs(item.totalMs) ? 'font-medium text-warning' : ''}>
              {formatStepMs(item.totalMs)}
            </span>
          ) : null}
          <span className="text-success">✓</span>
          {expanded ? <ChevronDown size={11.5} /> : <ChevronRight size={11.5} />}
        </div>
      </button>

      {expanded ? (
        <div className="mt-0.5 space-y-0.5 border-l border-line pl-1">
          {item.items.map((child) => (
            <StepRailRow key={child.id} entry={child} indented />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ArtifactRow({
  artifact,
  taskId,
  muted = false,
  onReveal,
}: {
  artifact: TaskArtifact;
  taskId: string;
  muted?: boolean;
  onReveal: (taskId: string, relPath: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const visual = resolveArtifactVisual(artifact.relPath);
  const fileName = artifact.relPath.split(/[\\/]/).pop() || artifact.relPath;
  const openPreview = () => {
    openDocPreview({
      source: { kind: 'artifact', taskId, relPath: artifact.relPath },
      fileName,
      bytes: artifact.bytes,
    });
  };
  return (
    <div
      className={`group flex items-center justify-between gap-2 ${muted ? 'py-1.5 opacity-85' : 'py-2'}`}
    >
      <button
        type="button"
        onClick={openPreview}
        title={t('observatory.previewArtifact')}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left transition hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <ObservatoryIcon visual={visual} size={muted ? 14 : 16} />
        <div className="min-w-0">
          <div
            className={`truncate font-mono ${
              muted ? 'text-[11px] text-ink-secondary' : 'text-[11.5px] text-ink'
            }`}
          >
            {artifact.relPath}
          </div>
          <div className="font-mono text-[10px] tabular-nums text-ink-tertiary">
            {formatBytes(artifact.bytes)}
          </div>
        </div>
      </button>
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={openPreview}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-ink-tertiary opacity-80 transition hover:bg-surface-hover hover:text-ink group-hover:opacity-100"
        >
          <Eye size={12.5} strokeWidth={1.8} />
          <span>{t('observatory.previewArtifact')}</span>
        </button>
        <button
          type="button"
          onClick={() => void onReveal(taskId, artifact.relPath)}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-ink-tertiary opacity-80 transition hover:bg-surface-hover hover:text-ink group-hover:opacity-100"
        >
          <FolderSearch size={12.5} strokeWidth={1.8} />
          <span>{t('observatory.revealArtifact')}</span>
        </button>
      </div>
    </div>
  );
}

export function WorkerInspectorPane({
  threads,
  selectedThreadId: _selectedThreadId,
  selectedTaskId,
  selectedThread,
  taskDetail,
  liveTool = null,
  loadingDetail,
  actionBusy,
  onSelectThread,
  onSelectTask,
  onApproveBlocker,
  onAnswerQuestion,
  onAbortThread,
  onOpenWorkspace,
  onRevealArtifact,
}: WorkerInspectorPaneProps) {
  const { t } = useTranslation();
  const [subTab, setSubTab] = useState<DetailSubTab>('trace');
  const [keyOnly, setKeyOnly] = useState(false);
  const [stepsExpanded, setStepsExpanded] = useState(false);
  const [intermediateExpanded, setIntermediateExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const traceViewportRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);

  const activeRunning = useMemo(() => {
    const status = taskDetail?.task.status ?? selectedThread?.latestTask?.status;
    return status === 'running' || selectedThread?.state === 'running';
  }, [selectedThread, taskDetail]);

  useEffect(() => {
    if (!activeRunning && !taskDetail?.blocker && !selectedThread?.blocker) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeRunning, selectedThread?.blocker, taskDetail?.blocker]);

  const task = taskDetail?.task ?? null;
  const effectiveBlocker = taskDetail?.blocker ?? selectedThread?.blocker ?? null;
  const elapsedMs = useMemo(() => {
    const start = task?.startedAt ?? selectedThread?.latestTask?.startedAt ?? task?.createdAt;
    if (!start) return null;
    const end = task?.finishedAt ?? selectedThread?.latestTask?.finishedAt ?? now;
    return Math.max(0, end - start);
  }, [now, selectedThread, task]);

  const foldedTrace = useMemo(() => {
    if (!taskDetail) return [];
    return groupWorkerTrace(taskDetail.trace, { keyOnly, running: activeRunning });
  }, [activeRunning, keyOnly, taskDetail]);
  const hasRealActionsInTrace = useMemo(
    () => foldedTrace.some((item) => item.kind !== 'settlement' && item.kind !== 'gap'),
    [foldedTrace],
  );
  const threadTasks = useMemo(() => selectedThread?.tasks ?? [], [selectedThread]);
  const activeViewedTaskId = selectedTaskId ?? task?.id ?? selectedThread?.latestTask?.id ?? null;
  useEffect(() => {
    setIntermediateExpanded(false);
    pinnedToBottomRef.current = true;
  }, [activeViewedTaskId]);

  const traceLength = taskDetail?.trace.length ?? 0;
  useEffect(() => {
    if (subTab !== 'trace' || !activeRunning || !pinnedToBottomRef.current) return;
    const viewport = traceViewportRef.current;
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [activeRunning, liveTool, subTab, traceLength]);

  const partitionedArtifacts = useMemo(
    () => partitionTaskArtifacts(task?.artifacts ?? [], task?.contract?.outputs),
    [task],
  );
  const selectedRoundTask = useMemo(
    () =>
      threadTasks.find((roundTask) => roundTask.id === activeViewedTaskId) ??
      threadTasks[threadTasks.length - 1] ??
      null,
    [activeViewedTaskId, threadTasks],
  );

  const rawModelLabel = taskDetail?.modelLabel ?? selectedThread?.worker?.modelLabel ?? '—';
  const modelLabel = shortModelName(rawModelLabel);
  const totalTokens = task?.tokensUsed ?? selectedThread?.spentTokens ?? 0;
  const costUsd = task?.costUsd ?? selectedThread?.latestTask?.costUsd ?? 0;
  const telemetryTooltip = selectedThread
    ? [
        selectedThread.worker?.name,
        rawModelLabel,
        ...(elapsedMs !== null ? [formatDurationCompact(elapsedMs)] : []),
        ...(totalTokens > 0 ? [`${totalTokens.toLocaleString()} tok`] : []),
        ...(costUsd > 0 ? [formatCostCompact(costUsd)] : []),
      ]
        .filter(Boolean)
        .join(' · ')
    : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Layer 2: Compact Context Anchor (~58px, zero boxed cards) */}
      <div className="shrink-0 border-b border-line px-3.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <ThreadPicker
            threads={threads}
            selectedThread={selectedThread}
            onSelect={onSelectThread}
          />
          {selectedThread ? (
            <div className="flex shrink-0 items-center gap-1">
              {task ? (
                <button
                  type="button"
                  onClick={() => void onOpenWorkspace(task.id)}
                  title={t('observatory.openWorkspace')}
                  aria-label={t('observatory.openWorkspace')}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-ink-tertiary transition hover:bg-surface-hover hover:text-ink"
                >
                  <FolderOpen size={13.5} strokeWidth={1.8} />
                </button>
              ) : null}
              {activeRunning ? (
                <button
                  type="button"
                  disabled={actionBusy}
                  onClick={() => void onAbortThread(selectedThread.threadId)}
                  title={t('observatory.abort')}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-danger transition hover:bg-danger/10 disabled:opacity-50"
                >
                  <OctagonX size={12.5} strokeWidth={1.9} />
                  <span>{t('observatory.abort')}</span>
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {selectedThread ? (
          <div
            title={telemetryTooltip}
            className="mt-0.5 flex flex-nowrap items-center gap-1.5 overflow-hidden whitespace-nowrap px-1.5 font-mono text-[10.5px] tabular-nums text-ink-tertiary"
          >
            <span className="min-w-0 truncate text-ink-secondary">{modelLabel}</span>
            {elapsedMs !== null ? (
              <>
                <span className="shrink-0 opacity-40">·</span>
                <span className="shrink-0">{formatDurationCompact(elapsedMs)}</span>
              </>
            ) : null}
            {totalTokens > 0 ? (
              <>
                <span className="shrink-0 opacity-40">·</span>
                <span className="shrink-0">{formatTokensCompact(totalTokens)} tok</span>
              </>
            ) : null}
            {costUsd > 0 ? (
              <>
                <span className="shrink-0 opacity-40">·</span>
                <span className="shrink-0">{formatCostCompact(costUsd)}</span>
              </>
            ) : null}
          </div>
        ) : null}

        {selectedThread && threadTasks.length > 1 ? (
          <div className="mt-2 flex items-center justify-between gap-2 px-1.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 text-[10.5px] font-medium text-ink-tertiary">
                {t('observatory.trace.roundsLabel')}
              </span>
              <div
                role="tablist"
                aria-label={t('observatory.trace.roundsLabel')}
                className="observatory-round-track inline-flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-lg border border-line bg-surface-muted/75 p-0.5"
              >
                {threadTasks.map((roundTask, idx) => {
                  const selected = roundTask.id === activeViewedTaskId;
                  const isRunning = roundTask.status === 'running';
                  const isFailed = roundTask.status === 'failed' || roundTask.status === 'rejected';
                  const isPassed = roundTask.status === 'accepted' || roundTask.status === 'delivered';
                  const roundNumber = idx + 1;
                  const modeLabel = roundTask.turnMode
                    ? t(`observatory.trace.turnMode.${roundTask.turnMode}`)
                    : null;
                  const statusLabel = t(`task.status.${roundTask.status}`);
                  const tooltip = [
                    t('observatory.trace.roundTooltipTitle', { index: roundNumber }),
                    ...(modeLabel ? [modeLabel] : []),
                    statusLabel,
                    ...(isRunning ? [] : [t('observatory.trace.roundTooltipSteps', { count: roundTask.traceCount })]),
                    ...(roundTask.tokensUsed > 0 ? [`${formatTokensCompact(roundTask.tokensUsed)} tok`] : []),
                  ].join(' · ');

                  return (
                    <button
                      key={roundTask.id}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      title={tooltip}
                      aria-label={tooltip}
                      onClick={(event) => {
                        event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                        onSelectTask(roundTask.id);
                      }}
                      className={`inline-flex h-[20px] shrink-0 items-center gap-1 rounded-[5px] px-1.5 font-mono text-[10.5px] leading-none tabular-nums transition-all ${
                        selected
                          ? 'bg-surface font-semibold text-ink shadow-card ring-1 ring-line/85'
                          : 'font-medium text-ink-tertiary hover:bg-surface/55 hover:text-ink-secondary'
                      }`}
                    >
                      {isRunning ? (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent observatory-dot-pulse" />
                      ) : isPassed ? (
                        <Check size={9.5} strokeWidth={2.5} className="shrink-0 text-success" />
                      ) : isFailed ? (
                        <X size={9.5} strokeWidth={2.5} className="shrink-0 text-danger" />
                      ) : (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink-quaternary" />
                      )}
                      <span>#{roundNumber}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {selectedRoundTask ? (
              <div className="flex shrink-0 items-center gap-1.5 text-[10.5px] tabular-nums">
                {selectedRoundTask.turnMode ? (
                  <span className="rounded bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium leading-none text-ink-secondary">
                    {t(`observatory.trace.turnMode.${selectedRoundTask.turnMode}`)}
                  </span>
                ) : null}
                <span
                  className={`font-medium ${
                    selectedRoundTask.status === 'running'
                      ? 'text-accent-ink'
                      : selectedRoundTask.status === 'failed' || selectedRoundTask.status === 'rejected'
                        ? 'text-danger'
                        : selectedRoundTask.status === 'accepted' || selectedRoundTask.status === 'delivered'
                          ? 'text-success'
                          : 'text-ink-tertiary'
                  }`}
                >
                  {t(`task.status.${selectedRoundTask.status}`)}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {selectedThread ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* Layer 3: Blocker Diagnostic Focal Card (only present when blocked/errored) */}
          {effectiveBlocker ? (
            <div className="shrink-0 border-b border-line px-3.5 py-2.5">
              <BlockerFocalCard
                blocker={effectiveBlocker}
                actionBusy={actionBusy}
                now={now}
                onApprove={onApproveBlocker}
                onAnswer={onAnswerQuestion}
              />
            </div>
          ) : null}

          {/* Slim 32px Underline Sub-tabs + Key-Only Toggle */}
          <div className="flex h-[34px] shrink-0 items-stretch justify-between border-b border-line px-3.5">
            <div className="flex items-stretch gap-4">
              {(['trace', 'artifacts', 'contract'] as const).map((tab) => {
                const active = subTab === tab;
                const badgeCount =
                  tab === 'trace'
                    ? (taskDetail
                        ? taskDetail.trace.filter((entry) => entry.kind !== 'usage').length
                        : (selectedThread.latestTask?.traceCount ?? 0))
                    : tab === 'artifacts'
                      ? (task
                          ? partitionedArtifacts.deliverables.length
                          : (selectedThread.latestTask?.artifactCount ?? 0))
                      : null;
                return (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setSubTab(tab)}
                    className={`relative inline-flex items-center gap-1 text-[11.5px] font-medium transition ${
                      active ? 'text-ink' : 'text-ink-tertiary hover:text-ink-secondary'
                    }`}
                  >
                    <span>{t(`observatory.subtabs.${tab}`)}</span>
                    {badgeCount !== null && badgeCount > 0 ? (
                      <span className="font-mono text-[10px] tabular-nums text-ink-tertiary">
                        {badgeCount}
                      </span>
                    ) : null}
                    {active ? (
                      <span className="absolute inset-x-0 bottom-0 h-[1.5px] rounded-full bg-accent" />
                    ) : null}
                  </button>
                );
              })}
            </div>

            {subTab === 'trace' ? (
              <div className="flex items-center">
                <button
                  type="button"
                  onClick={() => setKeyOnly((prev) => !prev)}
                  className={`rounded-md px-2 py-0.5 text-[10.5px] font-medium transition ${
                    keyOnly
                      ? 'bg-accent-soft text-accent-ink'
                      : 'text-ink-tertiary hover:bg-surface-hover hover:text-ink-secondary'
                  }`}
                >
                  {keyOnly ? t('observatory.trace.keyOnly') : t('observatory.trace.allSteps')}
                </button>
              </div>
            ) : null}
          </div>

          {/* Layer 4: Primary Viewport (Trace Rail / Artifacts / Contract) */}
          <div
            ref={traceViewportRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              pinnedToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
            className="min-h-0 flex-1 overflow-y-auto px-3.5 py-2.5"
          >
            {loadingDetail && !taskDetail ? (
              <div className="py-10 text-center text-xs text-ink-tertiary">
                {t('common.loading')}
              </div>
            ) : subTab === 'trace' ? (
              foldedTrace.length > 0 || (activeRunning && liveTool) ? (
                <div className="space-y-1">
                  {!activeRunning && !hasRealActionsInTrace ? (
                    <div className="rounded-md bg-surface-muted/60 px-2.5 py-1.5 text-[11px] text-ink-tertiary">
                      {t('observatory.trace.noToolCallsInRound')}
                    </div>
                  ) : null}
                  <div className="relative space-y-0.5 before:absolute before:bottom-2 before:left-[9.5px] before:top-2 before:w-px before:bg-line">
                    {foldedTrace.map((item) => {
                    if (item.kind === 'gap') {
                      return (
                        <div
                          key={item.id}
                          className="py-1 pl-6 font-mono text-[10px] text-ink-quaternary"
                        >
                          ··· {t('observatory.prunedSteps', { count: item.count })} ···
                        </div>
                      );
                    }
                    if (item.kind === 'settlement') {
                      const parts = [t('observatory.trace.turnSettlement')];
                      if (typeof item.entry.tokens === 'number' && item.entry.tokens > 0) {
                        parts.push(`${formatTokensCompact(item.entry.tokens)} tok`);
                      }
                      if (item.entry.argsDigest) {
                        parts.push(item.entry.argsDigest);
                      }
                      return (
                        <div
                          key={item.id}
                          className="relative flex items-center gap-2.5 py-2 pl-6 pr-6"
                        >
                          <span className="absolute left-[7px] h-1.5 w-1.5 rounded-full bg-line-strong" />
                          <span className="h-px flex-1 bg-line" />
                          <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-quaternary">
                            {parts.join(' · ')}
                          </span>
                          <span className="h-px flex-1 bg-line" />
                        </div>
                      );
                    }
                    if (item.kind === 'burst') {
                      return <BurstRailRow key={item.id} item={item} />;
                    }
                    return <StepRailRow key={item.id} entry={item.entry} />;
                  })}
                  {activeRunning && liveTool ? (
                    <div className="relative pl-6">
                      <div className="flex items-start justify-between gap-2 rounded-md bg-accent-soft/45 px-1.5 py-1">
                        <span className="observatory-rail-node absolute left-[1px] top-[5px] flex h-[18px] w-[18px] items-center justify-center rounded bg-panel">
                          <ObservatoryIcon
                            visual={resolveToolVisual(liveTool.toolName, liveTool.argsDigest)}
                            size={14}
                            className="!text-accent-ink"
                          />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-1.5">
                            <span className="shrink-0 font-mono text-[11.5px] font-medium text-accent-ink">
                              {liveTool.toolName}
                            </span>
                            {liveTool.argsDigest ? (
                              <span className="truncate font-mono text-[11px] text-ink-secondary">
                                {liveTool.argsDigest}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5 pt-0.5 font-mono text-[10.5px] tabular-nums text-accent-ink">
                          <span>{formatDurationCompact(Math.max(0, now - liveTool.startedAt))}</span>
                          <span className="h-1.5 w-1.5 rounded-full bg-accent observatory-dot-pulse" />
                        </div>
                      </div>
                    </div>
                  ) : activeRunning ? (
                    <div className="relative flex items-center gap-2 py-1.5 pl-6 text-[11px] text-accent-ink">
                      <span className="absolute left-[6px] h-2 w-2 rounded-full bg-accent observatory-dot-pulse" />
                      <span>{t('observatory.workerLiveRunning')}</span>
                    </div>
                  ) : null}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-xs text-ink-tertiary">
                  <ObservatoryIcon visual={EMPTY_STATE_VISUAL} size={26} />
                  <span>
                    {activeRunning
                      ? t('observatory.workerLiveRunning')
                      : t('observatory.noTrace')}
                  </span>
                </div>
              )
            ) : subTab === 'artifacts' ? (
              task &&
              (partitionedArtifacts.deliverables.length > 0 ||
                partitionedArtifacts.intermediate.length > 0) ? (
                <div>
                  {partitionedArtifacts.deliverables.length > 0 ? (
                    <div className="divide-y divide-line">
                      {partitionedArtifacts.deliverables.map((artifact) => (
                        <ArtifactRow
                          key={artifact.id}
                          artifact={artifact}
                          taskId={task.id}
                          onReveal={onRevealArtifact}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="py-5 text-center text-xs text-ink-tertiary">
                      {t('observatory.noArtifacts')}
                    </div>
                  )}

                  {partitionedArtifacts.intermediate.length > 0 ? (
                    <div
                      className={
                        partitionedArtifacts.deliverables.length > 0
                          ? 'mt-2 border-t border-line pt-2.5'
                          : 'border-t border-line pt-2.5'
                      }
                    >
                      <button
                        type="button"
                        onClick={() => setIntermediateExpanded((prev) => !prev)}
                        className="flex w-full items-center justify-between py-1 text-[10.5px] font-medium text-ink-tertiary transition hover:text-ink-secondary"
                      >
                        <span>
                          {t('observatory.intermediateArtifacts', {
                            count: partitionedArtifacts.intermediate.length,
                          })}
                        </span>
                        {intermediateExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      </button>
                      {intermediateExpanded ? (
                        <div className="mt-1 divide-y divide-line/60">
                          {partitionedArtifacts.intermediate.map((artifact) => (
                            <ArtifactRow
                              key={artifact.id}
                              artifact={artifact}
                              taskId={task.id}
                              muted
                              onReveal={onRevealArtifact}
                            />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-xs text-ink-tertiary">
                  <ObservatoryIcon visual={EMPTY_STATE_VISUAL} size={26} />
                  <span>{t('observatory.noArtifacts')}</span>
                </div>
              )
            ) : task ? (
              <div className="divide-y divide-line text-xs">
                <div className="pb-3">
                  <div className="text-[10.5px] font-medium text-ink-tertiary">
                    {t('observatory.contract.objective')}
                  </div>
                  <CompactMarkdown
                    text={task.contract?.objective || task.brief}
                    className="mt-1 text-xs text-ink"
                  />
                </div>

                <div className="py-3">
                  <div className="text-[10.5px] font-medium text-ink-tertiary">
                    {t('observatory.contract.deliverable')}
                  </div>
                  <CompactMarkdown
                    text={task.contract?.deliverable || task.deliverableSpec}
                    className="mt-1 text-xs text-ink-secondary"
                  />
                </div>

                {task.answer?.trim() ? (
                  <div className="py-3">
                    <div className="text-[10.5px] font-medium text-ink-tertiary">
                      {t('observatory.contract.workerAnswer')}
                    </div>
                    <CompactMarkdown
                      text={task.answer.trim()}
                      className="mt-1 text-xs text-ink-secondary"
                    />
                  </div>
                ) : null}

                {task.contract?.attachments && task.contract.attachments.length > 0 ? (
                  <div className="py-3">
                    <div className="flex items-center gap-1.5 text-[10.5px] font-medium text-ink-tertiary">
                      <Paperclip size={11.5} />
                      <span>{t('observatory.contract.attachments')}</span>
                    </div>
                    <ul className="mt-1.5 space-y-1">
                      {task.contract.attachments.map((att) => (
                        <li
                          key={att.id}
                          className="flex items-center justify-between gap-2 font-mono text-[11px] text-ink-secondary"
                        >
                          <span className="flex min-w-0 items-center gap-1.5">
                            <ObservatoryIcon visual={resolveArtifactVisual(att.name)} size={14} />
                            <span className="truncate">{att.name}</span>
                          </span>
                          <span className="shrink-0 tabular-nums text-ink-tertiary">
                            {formatBytes(att.size)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {task.acceptance ? (
                  <div className="py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10.5px] font-medium text-ink-tertiary">
                        {t('observatory.contract.acceptance')}
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${
                          task.acceptance.verdict === 'pass'
                            ? 'bg-accent-soft text-accent-ink'
                            : 'bg-danger/15 text-danger'
                        }`}
                      >
                        {task.acceptance.verdict}
                      </span>
                    </div>
                    <CompactMarkdown
                      text={task.acceptance.reason}
                      className="mt-1 text-xs text-ink-secondary"
                    />
                    {task.acceptance.evidence.command.length > 0 ? (
                      <div
                        className="mt-1.5 rounded p-1.5 font-mono text-[10.5px] text-ink-secondary"
                        style={{ background: 'var(--code-bg)' }}
                      >
                        {task.acceptance.evidence.command.join(' ')}
                      </div>
                    ) : null}
                    {task.acceptance.evidence.stderrTail ? (
                      <pre
                        className="mt-1.5 max-h-24 overflow-auto rounded p-1.5 font-mono text-[10.5px] text-danger"
                        style={{ background: 'var(--code-bg)' }}
                      >
                        {task.acceptance.evidence.stderrTail}
                      </pre>
                    ) : null}
                  </div>
                ) : null}

                {task.steps.length > 0 ? (
                  <div className="pt-2.5">
                    <button
                      type="button"
                      onClick={() => setStepsExpanded((prev) => !prev)}
                      className="flex w-full items-center justify-between py-1 text-[10.5px] font-medium text-ink-tertiary hover:text-ink-secondary"
                    >
                      <span>{t('observatory.contract.systemSteps', { count: task.steps.length })}</span>
                      {stepsExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </button>
                    {stepsExpanded ? (
                      <ul className="mt-1.5 space-y-1 text-[11px] text-ink-tertiary">
                        {task.steps.map((step, idx) => (
                          <li key={`${step.at}-${idx}`} className="flex items-start justify-between gap-2">
                            <span className="break-words">{step.text}</span>
                            <span className="shrink-0 font-mono text-[10px] text-ink-quaternary">
                              {formatTime(step.at)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-xs text-ink-tertiary">
                <ObservatoryIcon visual={EMPTY_STATE_VISUAL} size={26} />
                <span>{t('observatory.noTaskYet')}</span>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2.5 px-6 text-center text-xs text-ink-tertiary">
          <ObservatoryIcon visual={EMPTY_STATE_VISUAL} size={28} />
          <span>{t('observatory.selectThreadHint')}</span>
        </div>
      )}
    </div>
  );
}
