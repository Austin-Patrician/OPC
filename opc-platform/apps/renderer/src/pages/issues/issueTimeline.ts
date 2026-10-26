import type { WorkTask } from '@opc/shared/domain';

export interface TimelineBar {
  task: WorkTask;
  /** 0..1 offsets inside the window. */
  start: number;
  end: number;
  /** True when the task is still open-ended (running / waiting). */
  open: boolean;
}

/**
 * Timeline geometry, kept pure so the chart cannot quietly lie: every bar starts at
 * `startedAt ?? createdAt` and ends at `finishedAt ?? now`. Nothing is estimated.
 */
export function buildTimeline(
  tasks: readonly WorkTask[],
  now = Date.now(),
): { bars: TimelineBar[]; from: number; to: number } {
  if (tasks.length === 0) return { bars: [], from: now - 86_400_000, to: now };

  const starts = tasks.map((task) => task.startedAt ?? task.createdAt);
  const ends = tasks.map((task) => task.finishedAt ?? now);
  const from = Math.min(...starts);
  const to = Math.max(...ends, now);
  const span = Math.max(1, to - from);

  return {
    from,
    to,
    bars: tasks.map((task) => {
      const start = task.startedAt ?? task.createdAt;
      const end = task.finishedAt ?? now;
      return {
        task,
        start: (start - from) / span,
        end: (end - from) / span,
        open: task.finishedAt === undefined,
      };
    }),
  };
}

/** Spend per calendar day, newest last — straight from `cost_usd`, no smoothing. */
export function spendByDay(tasks: readonly WorkTask[], days = 14, now = Date.now()): { day: string; usd: number }[] {
  const buckets = new Map<string, number>();
  const key = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  for (let index = days - 1; index >= 0; index -= 1) {
    buckets.set(key(now - index * 86_400_000), 0);
  }
  for (const task of tasks) {
    const at = task.finishedAt ?? task.updatedAt;
    const day = key(at);
    if (buckets.has(day)) buckets.set(day, (buckets.get(day) ?? 0) + task.costUsd);
  }

  return [...buckets.entries()].map(([day, usd]) => ({ day, usd }));
}
