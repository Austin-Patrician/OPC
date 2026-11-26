import { useMemo, useState } from 'react';
import { ArrowUpRight, ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { RouterObservatoryState, RouterTraceEntry } from '@opc/shared/domain';
import { groupRouterTraceByTurn, type RouterTurnGroup } from '../model/traceFolding';
import {
  extractReplyMarkdown,
  formatStepMs,
  isSlowStepMs,
  shortModelName,
} from '../model/formatters';
import { CompactMarkdown } from './CompactMarkdown';
import {
  COMPACT_VISUAL,
  EMPTY_STATE_VISUAL,
  ERROR_STATE_VISUAL,
  ObservatoryIcon,
  resolveToolVisual,
  TURN_BATCH_VISUAL,
  TURN_THINK_VISUAL,
} from './observatoryIcons';

interface RouterInspectorPaneProps {
  router: RouterObservatoryState | null;
  actionBusy: boolean;
  onCompact: () => Promise<void>;
  onJumpToThread: (threadId: string) => void;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function phaseDotColor(phase: RouterObservatoryState['phase']): string {
  switch (phase) {
    case 'thinking':
    case 'tool':
    case 'compacting':
      return 'bg-accent observatory-dot-pulse';
    case 'error':
      return 'bg-danger';
    default:
      return 'bg-ink-quaternary';
  }
}

function RouterStepRow({
  entry,
  onJumpToThread,
}: {
  entry: RouterTraceEntry;
  onJumpToThread: (threadId: string) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const visual = resolveToolVisual(entry.name, entry.summary);
  const isError = entry.ok === false;
  const slow = !isError && isSlowStepMs(entry.ms);
  const replyMarkdown = expanded ? extractReplyMarkdown(entry.name, entry.detail) : null;

  return (
    <div className="relative pl-5">
      <div className="flex items-start justify-between gap-1.5">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className={`flex min-w-0 flex-1 items-start gap-2 rounded-md px-1.5 py-1 text-left transition ${
            isError ? 'bg-danger/8 hover:bg-danger/12' : 'hover:bg-surface-hover/65'
          }`}
        >
          <span className="absolute left-0 top-[5px] flex h-[16px] w-[16px] items-center justify-center rounded bg-panel">
            <ObservatoryIcon
              visual={visual}
              size={13.5}
              className={isError ? '!text-danger' : ''}
            />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <span
                className={`shrink-0 font-mono text-[11px] font-medium ${
                  isError ? 'text-danger' : 'text-ink'
                }`}
              >
                {entry.name}
              </span>
              <span className="truncate font-mono text-[10.5px] text-ink-secondary">
                {entry.summary}
              </span>
            </div>
          </div>
        </button>

        <div className="flex shrink-0 items-center gap-1.5 pt-1 font-mono text-[10px] tabular-nums text-ink-tertiary">
          {entry.threadId ? (
            <button
              type="button"
              onClick={() => onJumpToThread(entry.threadId!)}
              title={t('observatory.router.inspectWorker')}
              className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 font-sans text-[10.5px] font-medium text-accent-ink transition hover:bg-accent-soft"
            >
              <span>Worker</span>
              <ArrowUpRight size={10.5} />
            </button>
          ) : null}
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
      </div>

      {expanded && replyMarkdown ? (
        <div className="mx-1.5 mb-1.5 mt-0.5 rounded-md border border-line bg-surface-muted/60 p-2.5 text-ink">
          <CompactMarkdown text={replyMarkdown} className="text-[11.5px]" />
        </div>
      ) : expanded && entry.detail ? (
        <pre
          className="mx-1.5 mb-1.5 mt-0.5 max-h-40 overflow-auto rounded-md border border-line p-2 font-mono text-[10.5px] leading-snug text-ink-secondary"
          style={{ background: 'var(--code-bg)' }}
        >
          {entry.detail}
        </pre>
      ) : null}
    </div>
  );
}

function RouterTurnRow({
  turn,
  defaultExpanded,
  onJumpToThread,
}: {
  turn: RouterTurnGroup;
  defaultExpanded: boolean;
  onJumpToThread: (threadId: string) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const firstEntry = turn.entries[0];
  const visual =
    turn.ok === false
      ? ERROR_STATE_VISUAL
      : turn.kind === 'lifecycle' && firstEntry
        ? resolveToolVisual(firstEntry.name, firstEntry.summary)
        : turn.entries.some((entry) => entry.kind === 'tool')
          ? TURN_BATCH_VISUAL
          : TURN_THINK_VISUAL;

  return (
    <div className="py-2">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left transition hover:bg-surface-hover/60"
        >
          {expanded ? (
            <ChevronDown size={12.5} className="shrink-0 text-ink-tertiary" />
          ) : (
            <ChevronRight size={12.5} className="shrink-0 text-ink-tertiary" />
          )}
          <ObservatoryIcon visual={visual} size={14} />
          <span className="truncate text-xs font-medium text-ink">
            {turn.inputSummary}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-2 font-mono text-[10.5px] tabular-nums text-ink-tertiary">
          {turn.toolCount > 0 ? (
            <span>{t('observatory.router.turnToolsCount', { count: turn.toolCount })}</span>
          ) : null}
          {typeof turn.totalMs === 'number' ? (
            <span className={turn.ok !== false && isSlowStepMs(turn.totalMs) ? 'font-medium text-warning' : ''}>
              {formatStepMs(turn.totalMs)}
            </span>
          ) : null}
          <span className="text-[10px] text-ink-quaternary">{formatTime(turn.startedAt)}</span>
          <span
            className={
              turn.ok === false
                ? 'text-danger'
                : turn.ok === true
                  ? 'text-success'
                  : 'text-ink-quaternary'
            }
          >
            {turn.ok === false ? '✗' : turn.ok === true ? '✓' : '·'}
          </span>
        </div>
      </div>

      {!expanded && turn.linkedThreadIds.length > 0 ? (
        <div className="mt-1 flex items-center justify-between gap-2 pl-7 text-[11px] text-ink-tertiary">
          <span className="truncate">{turn.outcomeSummary}</span>
          <button
            type="button"
            onClick={() => onJumpToThread(turn.linkedThreadIds[0]!)}
            className="inline-flex shrink-0 items-center gap-0.5 text-[10.5px] font-medium text-accent-ink hover:underline"
          >
            <span>{t('observatory.router.inspectWorker')}</span>
            <ArrowUpRight size={10.5} />
          </button>
        </div>
      ) : null}

      {expanded ? (
        <div className="relative ml-2.5 mt-1.5 space-y-0.5 border-l border-line pl-2">
          {turn.entries.map((entry) => (
            <RouterStepRow
              key={entry.id}
              entry={entry}
              onJumpToThread={onJumpToThread}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function RouterInspectorPane({
  router,
  actionBusy,
  onCompact,
  onJumpToThread,
}: RouterInspectorPaneProps) {
  const { t } = useTranslation();

  const turns = useMemo(
    () => (router ? groupRouterTraceByTurn(router.trace) : []),
    [router],
  );

  if (!router) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-xs text-ink-tertiary">
        {t('common.loading')}
      </div>
    );
  }

  const ratioPct = Math.min(100, Math.max(0, Math.round((router.contextStats.usageRatio || 0) * 100)));
  const meterColor =
    ratioPct >= 90 ? 'bg-danger' : ratioPct >= 70 ? 'bg-warning' : 'bg-accent';

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Slim ~64px Router Status & Context Header */}
      <div className="shrink-0 space-y-2 border-b border-line px-3.5 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className={`h-2 w-2 shrink-0 rounded-full ${phaseDotColor(router.phase)}`} />
            <span className="truncate text-xs font-semibold text-ink">
              {t(`observatory.router.phase.${router.phase}`)}
              {router.phase === 'tool' && router.activeTool ? ` · ${router.activeTool}` : ''}
            </span>
          </div>
          <span className="truncate font-mono text-[10.5px] text-ink-tertiary">
            {shortModelName(router.modelLabel)}
          </span>
        </div>

        <div className="flex items-center gap-2.5">
          <div className="min-w-0 flex-1">
            <div className="h-[4px] w-full overflow-hidden rounded-full bg-surface-muted">
              <div
                className={`h-full rounded-full transition-all duration-300 ${meterColor}`}
                style={{ width: `${ratioPct}%` }}
              />
            </div>
            <div className="mt-1 flex items-center justify-between font-mono text-[10.5px] tabular-nums text-ink-tertiary">
              <span>
                {router.contextStats.estimatedTokens.toLocaleString()} /{' '}
                {router.contextStats.contextWindow.toLocaleString()} ({ratioPct}%)
              </span>
              <span>
                {t('observatory.router.contextCounts', {
                  entries: router.contextStats.entryCount,
                  pruned: router.contextStats.prunedCount,
                })}
              </span>
            </div>
          </div>
          <button
            type="button"
            disabled={actionBusy || router.contextStats.compacting || router.contextStats.busy}
            onClick={() => void onCompact()}
            title={t('observatory.router.compact')}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line bg-surface-muted/60 px-2 py-1 text-[11px] font-medium text-ink-secondary transition hover:bg-surface-hover hover:text-ink disabled:opacity-50"
          >
            <ObservatoryIcon visual={COMPACT_VISUAL} size={13} />
            <span>{t('observatory.router.compact')}</span>
          </button>
        </div>

        {router.lastError ? (
          <div
            className="rounded-md border border-line border-l-[3px] px-2.5 py-1.5 font-mono text-[11px] text-danger"
            style={{
              borderLeftColor: 'var(--danger)',
              background: 'color-mix(in srgb, var(--danger) 8%, var(--surface))',
            }}
          >
            {router.lastError}
          </div>
        ) : null}
      </div>

      {/* Turn-Grouped Decision Timeline */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-2">
        {turns.length > 0 ? (
          <div className="divide-y divide-line">
            {turns.map((turn, idx) => (
              <RouterTurnRow
                key={turn.id}
                turn={turn}
                defaultExpanded={idx === 0}
                onJumpToThread={onJumpToThread}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-xs text-ink-tertiary">
            <ObservatoryIcon visual={EMPTY_STATE_VISUAL} size={26} />
            <span>{t('observatory.router.noTrace')}</span>
          </div>
        )}
      </div>
    </div>
  );
}
