import type { MemoryReflectionRunView } from '@opc/shared/ipc';

export { formatRelativeAge, type RelativeAgeLabels } from '@/shared/lib/appTime';

export type RunOutcomeKind = 'updated' | 'noop' | 'skipped' | 'failed';
export type RunOutcomeFilter = 'all' | RunOutcomeKind;
export type RunTriggerFilter = 'all' | MemoryReflectionRunView['trigger'];

export interface ConsolidationRunStats {
  total: number;
  updated: number;
  noop: number;
  skipped: number;
  failed: number;
  touchedFilesCount: number;
}

export interface ConsolidationDayGroup {
  key: string;
  label: string;
  runs: MemoryReflectionRunView[];
}

const DAY_MS = 86_400_000;

/** Maps a persisted run status + changed files count into four user-facing outcome states. */
export function classifyRunOutcome(run: MemoryReflectionRunView): RunOutcomeKind {
  if (run.status === 'failed') return 'failed';
  if (run.status === 'skipped') return 'skipped';
  return run.changedFiles.length > 0 ? 'updated' : 'noop';
}

/** Aggregates summary counters for the top consolidation status cards. */
export function summarizeRuns(runs: readonly MemoryReflectionRunView[]): ConsolidationRunStats {
  const touchedFiles = new Set<string>();
  let updated = 0;
  let noop = 0;
  let skipped = 0;
  let failed = 0;

  for (const run of runs) {
    const outcome = classifyRunOutcome(run);
    if (outcome === 'updated') updated += 1;
    else if (outcome === 'noop') noop += 1;
    else if (outcome === 'skipped') skipped += 1;
    else failed += 1;

    for (const file of run.changedFiles) {
      touchedFiles.add(file);
    }
  }

  return {
    total: runs.length,
    updated,
    noop,
    skipped,
    failed,
    touchedFilesCount: touchedFiles.size,
  };
}

/** Filters runs by semantic outcome and trigger source without mutating input arrays. */
export function filterRuns(
  runs: readonly MemoryReflectionRunView[],
  outcomeFilter: RunOutcomeFilter,
  triggerFilter: RunTriggerFilter,
): MemoryReflectionRunView[] {
  return runs.filter((run) => {
    if (outcomeFilter !== 'all' && classifyRunOutcome(run) !== outcomeFilter) return false;
    if (triggerFilter !== 'all' && run.trigger !== triggerFilter) return false;
    return true;
  });
}

function localCalendarDayKey(timestamp: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(timestamp);
}

/** Groups consolidation runs newest-first by local calendar day (`Today`, `Yesterday`, or date). */
export function groupRunsByDay(
  runs: readonly MemoryReflectionRunView[],
  now: number,
  labels: {
    today: string;
    yesterday: string;
    formatOtherDay: (timestamp: number) => string;
  },
  timeZone?: string,
): ConsolidationDayGroup[] {
  const todayKey = localCalendarDayKey(now, timeZone);
  const yesterdayKey = localCalendarDayKey(now - DAY_MS, timeZone);

  const sorted = [...runs].sort((a, b) => b.startedAt - a.startedAt);
  const buckets = new Map<string, ConsolidationDayGroup>();

  for (const run of sorted) {
    const key = localCalendarDayKey(run.startedAt, timeZone);
    let group = buckets.get(key);
    if (!group) {
      const label =
        key === todayKey
          ? labels.today
          : key === yesterdayKey
            ? labels.yesterday
            : labels.formatOtherDay(run.startedAt);
      group = { key, label, runs: [] };
      buckets.set(key, group);
    }
    group.runs.push(run);
  }

  return [...buckets.values()];
}
