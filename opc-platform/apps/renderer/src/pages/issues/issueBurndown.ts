import type { WorkTask } from '@opc/shared/domain';

const DAY = 86_400_000;
const isDone = (task: WorkTask) => task.status === 'delivered' || task.status === 'accepted';

/**
 * Burndown, computed from timestamps only.
 *
 * "Remaining" on a given day = tasks created on or before that day and not finished
 * by its end. Nothing is modelled or smoothed: if the line looks flat, the work was
 * in fact flat. The ideal line is the straight path from the first day to zero on the
 * last day, which is what makes a flat real line visible.
 */
export interface BurndownPoint {
  day: string;
  remaining: number;
  ideal: number;
}

export function buildBurndown(tasks: readonly WorkTask[], days = 14, now = Date.now()): BurndownPoint[] {
  const startOfDay = (ms: number) => {
    const date = new Date(ms);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  };
  const lastDay = startOfDay(now);
  const firstDay = lastDay - (days - 1) * DAY;
  const total = tasks.filter((task) => task.createdAt <= now).length;

  const points: BurndownPoint[] = [];
  for (let index = 0; index < days; index += 1) {
    const dayStart = firstDay + index * DAY;
    const dayEnd = dayStart + DAY - 1;
    const created = tasks.filter((task) => task.createdAt <= dayEnd).length;
    const finished = tasks.filter((task) => task.finishedAt !== undefined && task.finishedAt <= dayEnd).length;
    points.push({
      day: new Date(dayStart).toISOString().slice(0, 10),
      remaining: Math.max(0, created - finished),
      ideal: total === 0 ? 0 : Math.max(0, total * (1 - index / (days - 1))),
    });
  }
  return points;
}

export interface PersonSummary {
  assignee: string;
  total: number;
  doing: number;
  waiting: number;
  done: number;
  stuck: number;
  /** Average hours from creation to finish, finished tasks only (null when none). */
  avgLeadHours: number | null;
  usd: number;
}

/** Per-person rollup for "who is carrying what", computed — never judged. */
export function summariseByPerson(tasks: readonly WorkTask[]): PersonSummary[] {
  const rows = new Map<string, PersonSummary>();

  for (const task of tasks) {
    const entry = rows.get(task.assigneeName) ?? {
      assignee: task.assigneeName,
      total: 0,
      doing: 0,
      waiting: 0,
      done: 0,
      stuck: 0,
      avgLeadHours: null,
      usd: 0,
    };
    entry.total += 1;
    entry.usd += task.costUsd;
    if (task.status === 'running') entry.doing += 1;
    if (task.status === 'review' || task.status === 'accepted') entry.waiting += 1;
    if (isDone(task)) entry.done += 1;
    if (task.status === 'failed' || task.status === 'rejected') entry.stuck += 1;
    rows.set(task.assigneeName, entry);
  }

  return [...rows.values()]
    .map((entry) => {
      const finished = tasks.filter(
        (task) => task.assigneeName === entry.assignee && task.finishedAt !== undefined,
      );
      const avgLeadHours =
        finished.length === 0
          ? null
          : finished.reduce(
              (sum, task) => sum + ((task.finishedAt as number) - task.createdAt) / 3_600_000,
              0,
            ) / finished.length;
      return { ...entry, avgLeadHours, usd: Math.round(entry.usd * 10_000) / 10_000 };
    })
    .sort((a, b) => b.total - a.total || a.assignee.localeCompare(b.assignee));
}
