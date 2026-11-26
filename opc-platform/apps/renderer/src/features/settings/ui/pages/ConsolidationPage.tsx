import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  Clock,
  MessageSquareText,
  Minus,
  RotateCcw,
  SkipForward,
  Sparkles,
  XCircle,
  Zap,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import type { MemoryReflectionRunView, MemoryStatusView } from '@opc/shared/ipc';
import {
  appTimeZone,
  formatAppDate,
  formatAppTime,
  formatDurationCompact,
} from '@/shared/lib/appTime';
import { cn } from '@/shared/lib/cn';
import { Select } from '@/shared/ui/Select';
import { buttonClass, Note, Section, Segmented } from '../kit';
import {
  classifyRunOutcome,
  filterRuns,
  formatRelativeAge,
  groupRunsByDay,
  summarizeRuns,
  type RunOutcomeFilter,
  type RunOutcomeKind,
  type RunTriggerFilter,
} from './consolidationModel';

interface OutcomeVisual {
  Icon: typeof CheckCircle2;
  badgeClass: string;
  rowAccentClass: string;
  summaryClass: string;
}

const OUTCOME_VISUALS: Record<RunOutcomeKind, OutcomeVisual> = {
  updated: {
    Icon: CheckCircle2,
    badgeClass: 'bg-success/14 text-success ring-1 ring-success/25 font-medium',
    rowAccentClass: 'border-l-[3px] border-l-success bg-success/[0.025]',
    summaryClass: 'font-medium text-ink',
  },
  noop: {
    Icon: Minus,
    badgeClass: 'border border-line bg-surface-muted/45 text-ink-tertiary',
    rowAccentClass: 'border-l-[3px] border-l-transparent',
    summaryClass: 'text-ink-tertiary',
  },
  skipped: {
    Icon: SkipForward,
    badgeClass: 'bg-warning/12 text-warning ring-1 ring-warning/25 font-medium',
    rowAccentClass: 'border-l-[3px] border-l-warning/70',
    summaryClass: 'text-ink-secondary',
  },
  failed: {
    Icon: XCircle,
    badgeClass: 'bg-danger/12 text-danger ring-1 ring-danger/25 font-medium',
    rowAccentClass: 'border-l-[3px] border-l-danger bg-danger/[0.025]',
    summaryClass: 'font-medium text-ink',
  },
};

interface TriggerVisual {
  Icon: typeof Zap;
  badgeClass: string;
}

const TRIGGER_VISUALS: Record<MemoryReflectionRunView['trigger'], TriggerVisual> = {
  signal: {
    Icon: Zap,
    badgeClass:
      "border border-amber-500/25 bg-amber-500/10 text-amber-700 [[data-theme='dark']_&]:text-amber-300",
  },
  conversation: {
    Icon: MessageSquareText,
    badgeClass:
      "border border-sky-500/25 bg-sky-500/10 text-sky-700 [[data-theme='dark']_&]:text-sky-300",
  },
  compact: {
    Icon: Archive,
    badgeClass:
      "border border-violet-500/25 bg-violet-500/10 text-violet-700 [[data-theme='dark']_&]:text-violet-300",
  },
  manual: {
    Icon: Sparkles,
    badgeClass:
      "border border-indigo-500/25 bg-indigo-500/10 text-indigo-700 [[data-theme='dark']_&]:text-indigo-300",
  },
};

function formatClockWithSeconds(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: appTimeZone(),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp);
}

export function ConsolidationPage() {
  const { t, i18n } = useTranslation();
  const [, setSearchParams] = useSearchParams();
  const [status, setStatus] = useState<MemoryStatusView | null>(null);
  const [running, setRunning] = useState(false);
  const [outcomeFilter, setOutcomeFilter] = useState<RunOutcomeFilter>('all');
  const [triggerFilter, setTriggerFilter] = useState<RunTriggerFilter>('all');
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [feedback, setFeedback] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const bridge = window.opc?.memory;
    if (!bridge) return;
    try {
      const next = await bridge.status();
      setStatus(next);
      setNow(Date.now());
    } catch {
      // Preserve last known state if background refresh fails transiently.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const intervalMs = status?.reflecting ? 2_500 : 30_000;
    const timer = window.setInterval(() => {
      if (status?.reflecting) {
        void load();
      } else {
        setNow(Date.now());
      }
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [load, status?.reflecting]);

  const reflectNow = async () => {
    const bridge = window.opc?.memory;
    if (!bridge || running) return;
    setRunning(true);
    setFeedback(null);
    try {
      const run = await bridge.reflectNow();
      await load();
      const hasChanges = run.status === 'done' && run.changedFiles.length > 0;
      const text =
        run.status === 'failed'
          ? `${run.summary}${run.error ? ` (${run.error})` : ''}`
          : hasChanges
            ? run.summary
            : run.status === 'skipped'
              ? run.summary
              : t('settings.runs.manualFeedback.empty');
      setFeedback({
        tone: run.status === 'failed' || run.status === 'skipped' ? 'warn' : 'info',
        text,
      });
    } catch (error) {
      setFeedback({
        tone: 'warn',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRunning(false);
    }
  };

  const openMemoryPage = useCallback(() => {
    setSearchParams({ page: 'memory' });
  }, [setSearchParams]);

  const toggleExpand = (runId: string) => {
    setExpandedIds((prev) => ({ ...prev, [runId]: !prev[runId] }));
  };

  const runs = useMemo(() => status?.recentRuns ?? [], [status?.recentRuns]);
  const stats = useMemo(() => summarizeRuns(runs), [runs]);
  const filteredRuns = useMemo(
    () => filterRuns(runs, outcomeFilter, triggerFilter),
    [outcomeFilter, runs, triggerFilter],
  );

  const dayGroups = useMemo(
    () =>
      groupRunsByDay(
        filteredRuns,
        now,
        {
          today: t('settings.runs.dayGroups.today'),
          yesterday: t('settings.runs.dayGroups.yesterday'),
          formatOtherDay: (ts) => formatAppDate(ts, i18n.language),
        },
        appTimeZone(),
      ),
    [filteredRuns, i18n.language, now, t],
  );

  const pendingSignals = status?.pendingSignals ?? 0;
  const isReflecting = running || Boolean(status?.reflecting);
  const hasFilters = outcomeFilter !== 'all' || triggerFilter !== 'all';

  const lastRunAge = status?.lastReflectedAt
    ? formatRelativeAge(status.lastReflectedAt, now, {
        justNow: t('settings.runs.age.justNow'),
        minutesAgo: (count) => t('settings.runs.age.minutesAgo', { count }),
        hoursAgo: (count) => t('settings.runs.age.hoursAgo', { count }),
        daysAgo: (count) => t('settings.runs.age.daysAgo', { count }),
      })
    : t('settings.runs.overview.neverRun');

  const sectionTitle = hasFilters
    ? `${t('settings.runs.title')} · ${t('settings.runs.countSummary', {
        shown: filteredRuns.length,
        total: runs.length,
      })}`
    : `${t('settings.runs.title')} · ${runs.length}`;

  return (
    <div className="space-y-4">
      <header className="mb-1">
        <div className="flex items-center gap-1 text-xs-plus text-ink-tertiary">
          <span>{t('settings.title')}</span>
          <span className="text-ink-quaternary">›</span>
          <span>{t('settings.group.behavior')}</span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-4">
          <h2 className="text-xl leading-tight font-bold tracking-tight text-ink">
            {t('settings.page.consolidation')}
          </h2>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={openMemoryPage}
              className={buttonClass.secondary}
            >
              <BookOpen className="size-3.5" />
              {t('settings.runs.viewMemory')}
            </button>
            <button
              type="button"
              disabled={isReflecting}
              onClick={() => void reflectNow()}
              className={buttonClass.primary}
            >
              <Sparkles className={cn('size-3.5', isReflecting && 'animate-pulse')} />
              {isReflecting ? t('settings.memory.reflecting') : t('settings.memory.reflectNow')}
            </button>
          </div>
        </div>
        <p className="mt-1.5 text-sm-plus leading-relaxed text-ink-tertiary">
          {t('settings.runs.desc')}
        </p>
      </header>

      {feedback ? (
        <Note
          tone={feedback.tone}
          action={
            <button
              type="button"
              onClick={() => setFeedback(null)}
              className="shrink-0 text-xs font-medium opacity-75 hover:opacity-100"
            >
              {t('common.close')}
            </button>
          }
        >
          {feedback.text}
        </Note>
      ) : null}

      {/* 4-card consolidation status strip */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <div
          className={cn(
            'rounded-xl border px-3.5 py-3 transition-colors',
            pendingSignals > 0
              ? 'border-warning/35 bg-warning/[0.06]'
              : 'border-line bg-surface',
          )}
        >
          <div className="flex items-center justify-between gap-2 text-xs text-ink-tertiary">
            <span>{t('settings.runs.overview.pendingSignals')}</span>
            {pendingSignals > 0 ? (
              <span className="h-2 w-2 rounded-full bg-warning observatory-dot-pulse" />
            ) : null}
          </div>
          <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-ink">
            {pendingSignals}
          </div>
          <div
            className={cn(
              'mt-0.5 truncate text-2xs',
              pendingSignals > 0 ? 'text-warning' : 'text-ink-quaternary',
            )}
          >
            {pendingSignals > 0
              ? t('settings.runs.overview.pendingAction')
              : t('settings.runs.overview.pendingClear')}
          </div>
        </div>

        <div className="rounded-xl border border-line bg-surface px-3.5 py-3">
          <div className="flex items-center justify-between gap-2 text-xs text-ink-tertiary">
            <span>{t('settings.runs.overview.lastRun')}</span>
            {isReflecting ? (
              <span className="h-2 w-2 rounded-full bg-accent observatory-dot-pulse" />
            ) : null}
          </div>
          <div className="mt-1 truncate text-lg font-semibold tracking-tight text-ink">
            {lastRunAge}
          </div>
          <div className="mt-0.5 truncate font-mono text-2xs tabular-nums text-ink-quaternary">
            {status?.lastReflectedAt
              ? `${formatAppTime(status.lastReflectedAt, i18n.language)} · ${
                  isReflecting
                    ? t('settings.runs.overview.runningNow')
                    : t('settings.runs.overview.idle')
                }`
              : isReflecting
                ? t('settings.runs.overview.runningNow')
                : t('settings.runs.overview.idle')}
          </div>
        </div>

        <div className="rounded-xl border border-line bg-surface px-3.5 py-3">
          <div className="text-xs text-ink-tertiary">
            {t('settings.runs.overview.effectiveness', { total: stats.total })}
          </div>
          <div className="mt-1 flex items-baseline gap-1 font-mono tabular-nums">
            <span className="text-lg font-semibold text-ink">{stats.updated}</span>
            <span className="text-xs text-ink-quaternary">/ {stats.total}</span>
          </div>
          <div className="mt-0.5 truncate text-2xs text-ink-quaternary">
            {t('settings.runs.overview.effectivenessSub', {
              updated: stats.updated,
              skipped: stats.skipped,
              failed: stats.failed,
            })}
          </div>
        </div>

        <button
          type="button"
          onClick={openMemoryPage}
          className="group rounded-xl border border-line bg-surface px-3.5 py-3 text-left transition hover:border-line-strong hover:bg-surface-hover/50"
        >
          <div className="text-xs text-ink-tertiary">
            {t('settings.runs.overview.libraryScale')}
          </div>
          <div className="mt-1 truncate text-sm-plus font-semibold text-ink">
            {t('settings.runs.overview.libraryDocs', {
              docs: status?.docCount ?? 0,
              rules: status?.ruleCount ?? 0,
              max: status?.maxRules ?? 20,
            })}
          </div>
          <div className="mt-1 truncate text-2xs font-medium text-accent-ink group-hover:underline">
            {t('settings.runs.overview.libraryJump')}
          </div>
        </button>
      </div>

      {/* Auto-consolidation schedule summary */}
      <div className="flex items-center gap-2 rounded-xl border border-line/80 bg-surface-muted/45 px-3.5 py-2 text-xs leading-relaxed text-ink-tertiary">
        <Clock className="size-3.5 shrink-0 text-ink-quaternary" />
        <span>
          <strong className="font-medium text-ink-secondary">
            {t('settings.runs.autoRulesTitle')}
          </strong>
          {t('settings.runs.autoRulesText')}
        </span>
      </div>

      <Section
        title={sectionTitle}
        action={
          hasFilters ? (
            <button
              type="button"
              onClick={() => {
                setOutcomeFilter('all');
                setTriggerFilter('all');
              }}
              className="inline-flex items-center gap-1 text-xs font-medium text-accent-ink hover:underline"
            >
              <RotateCcw className="size-3" />
              {t('settings.runs.filters.clear')}
            </button>
          ) : undefined
        }
      >
        {runs.length > 0 ? (
          <div className="flex items-center justify-between gap-2 overflow-x-auto border-b border-line bg-surface-muted/35 px-4 py-2">
            <div className="shrink-0">
              <Segmented<RunOutcomeFilter>
                label={t('settings.runs.title')}
                value={outcomeFilter}
                onChange={setOutcomeFilter}
                options={[
                  { value: 'all', label: t('settings.runs.filters.all') },
                  { value: 'updated', label: t('settings.runs.filters.updated') },
                  { value: 'noop', label: t('settings.runs.filters.noop') },
                  { value: 'skipped', label: t('settings.runs.filters.skipped') },
                  { value: 'failed', label: t('settings.runs.filters.failed') },
                ]}
              />
            </div>

            <div className="w-28 shrink-0">
              <Select
                size="compact"
                ariaLabel={t('settings.runs.filters.triggerLabel')}
                value={triggerFilter}
                onValueChange={(next) => setTriggerFilter(next as RunTriggerFilter)}
                options={[
                  { value: 'all', label: t('settings.runs.filters.triggerAll') },
                  { value: 'manual', label: t('settings.runs.triggers.manual') },
                  { value: 'conversation', label: t('settings.runs.triggers.conversation') },
                  { value: 'signal', label: t('settings.runs.triggers.signal') },
                  { value: 'compact', label: t('settings.runs.triggers.compact') },
                ]}
              />
            </div>
          </div>
        ) : null}

        {runs.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
            <div className="flex size-10 items-center justify-center rounded-2xl bg-surface-muted text-ink-quaternary">
              <Sparkles className="size-4" />
            </div>
            <p className="mt-2.5 text-sm text-ink-tertiary">{t('settings.runs.empty')}</p>
            <button
              type="button"
              disabled={isReflecting}
              onClick={() => void reflectNow()}
              className={cn(buttonClass.secondary, 'mt-3')}
            >
              <Sparkles className="size-3.5" />
              {isReflecting ? t('settings.memory.reflecting') : t('settings.memory.reflectNow')}
            </button>
          </div>
        ) : filteredRuns.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-8 text-center">
            <p className="text-sm text-ink-tertiary">{t('settings.runs.filters.noMatches')}</p>
            <button
              type="button"
              onClick={() => {
                setOutcomeFilter('all');
                setTriggerFilter('all');
              }}
              className={cn(buttonClass.secondary, 'mt-3')}
            >
              <RotateCcw className="size-3.5" />
              {t('settings.runs.filters.clear')}
            </button>
          </div>
        ) : (
          <div data-testid="consolidation-runs">
            {dayGroups.map((group) => (
              <div key={group.key} className="border-t border-line first:border-t-0">
                <div className="flex items-center justify-between bg-surface-muted/45 px-4 py-1.5 text-[11px] font-medium text-ink-tertiary">
                  <span>{group.label}</span>
                  <span className="font-mono tabular-nums text-ink-quaternary">
                    {group.runs.length}
                  </span>
                </div>
                <ul className="divide-y divide-line">
                  {group.runs.map((run) => (
                    <ConsolidationRunRow
                      key={run.id}
                      run={run}
                      expanded={Boolean(expandedIds[run.id])}
                      locale={i18n.language}
                      onToggle={() => toggleExpand(run.id)}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function ConsolidationRunRow({
  run,
  expanded,
  locale,
  onToggle,
}: {
  run: MemoryReflectionRunView;
  expanded: boolean;
  locale: string;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const outcome = classifyRunOutcome(run);
  const outcomeVisual = OUTCOME_VISUALS[outcome];
  const OutcomeIcon = outcomeVisual.Icon;
  const triggerVisual = TRIGGER_VISUALS[run.trigger];
  const TriggerIcon = triggerVisual.Icon;
  const durationMs = Math.max(0, (run.finishedAt || run.startedAt) - run.startedAt);
  const exactRange = `${formatClockWithSeconds(run.startedAt)} → ${formatClockWithSeconds(
    run.finishedAt || run.startedAt,
  )}`;

  return (
    <li
      data-testid="consolidation-run-row"
      className={cn(
        'px-4 py-3 transition-colors hover:bg-surface-hover/40',
        outcomeVisual.rowAccentClass,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <span
            className={cn(
              'inline-flex h-[22px] w-[5.25rem] shrink-0 items-center justify-center gap-1 rounded-full px-2 text-2xs whitespace-nowrap',
              outcomeVisual.badgeClass,
            )}
          >
            <OutcomeIcon className="size-3 shrink-0" strokeWidth={2.2} />
            <span>{t(`settings.runs.outcomes.${outcome}`)}</span>
          </span>

          <span
            className={cn(
              'inline-flex h-[22px] w-[6.25rem] shrink-0 items-center justify-center gap-1 rounded-md px-2 text-2xs font-medium whitespace-nowrap',
              triggerVisual.badgeClass,
            )}
          >
            <TriggerIcon className="size-3 shrink-0" strokeWidth={2.1} />
            <span>{t(`settings.runs.triggers.${run.trigger}`)}</span>
          </span>

          <p className={cn('min-w-[10rem] flex-1 text-sm leading-snug', outcomeVisual.summaryClass)}>
            {run.summary}
          </p>
        </div>

        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          title={`${new Date(run.startedAt).toLocaleString()} (${exactRange})`}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-ink-quaternary transition hover:bg-surface-hover hover:text-ink-secondary"
        >
          <span>{formatDurationCompact(durationMs)}</span>
          <span className="opacity-40">·</span>
          <span>{formatAppTime(run.startedAt, locale)}</span>
          <ChevronDown
            className={cn(
              'size-3.5 transition-transform',
              expanded && 'rotate-180 text-ink-secondary',
            )}
          />
        </button>
      </div>

      {run.error ? (
        <div
          className={cn(
            'mt-2 flex items-start gap-2 rounded-lg border px-2.5 py-2 text-xs leading-relaxed',
            run.status === 'failed'
              ? 'border-danger/25 bg-danger/[0.06] text-danger'
              : 'border-warning/25 bg-warning/[0.06] text-warning',
          )}
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">
            {t('settings.runs.detail.errorPrefix')}
            {run.error}
          </span>
        </div>
      ) : null}

      {expanded ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-line/70 bg-surface-muted/45 px-3 py-2 font-mono text-[11px] text-ink-tertiary">
          <span>
            {t('settings.runs.detail.runId')}:{' '}
            <span className="text-ink-secondary select-text">{run.id}</span>
          </span>
          <span>
            {t('settings.runs.detail.window')}:{' '}
            <span className="text-ink-secondary">{exactRange}</span>
          </span>
          <span>
            {t('settings.runs.detail.duration')}:{' '}
            <span className="text-ink-secondary">{formatDurationCompact(durationMs)}</span>
          </span>
        </div>
      ) : null}
    </li>
  );
}
