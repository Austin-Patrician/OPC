import type { IssuePriority, WorkTask } from '@opc/shared/domain';

/** P0 first: the boss's ordering is the point of a priority field. */
const RANK: Record<IssuePriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export type IssueSort = 'priority' | 'due' | 'created' | 'cost';

/**
 * Sorting is pure and explicit: no hidden default order, so "why is this row first"
 * is always answerable. Within equal keys the newer task wins, which matches how
 * people read a ledger.
 */
export function sortIssues(tasks: readonly WorkTask[], sort: IssueSort): WorkTask[] {
  const byNewest = (a: WorkTask, b: WorkTask) => b.createdAt - a.createdAt;
  const rows = [...tasks];

  switch (sort) {
    case 'priority':
      return rows.sort((a, b) => RANK[a.priority] - RANK[b.priority] || byNewest(a, b));
    case 'due':
      // Anything without a due date goes last, not first.
      return rows.sort((a, b) => {
        if (!a.dueAt && !b.dueAt) return byNewest(a, b);
        if (!a.dueAt) return 1;
        if (!b.dueAt) return -1;
        return a.dueAt - b.dueAt || byNewest(a, b);
      });
    case 'cost':
      return rows.sort((a, b) => b.costUsd - a.costUsd || byNewest(a, b));
    case 'created':
    default:
      return rows.sort(byNewest);
  }
}

/** Overdue means "past due and not finished" — a delivered task is never overdue. */
export function isOverdue(task: WorkTask, now = Date.now()): boolean {
  if (!task.dueAt) return false;
  if (task.status === 'delivered' || task.status === 'accepted') return false;
  return task.dueAt < now;
}
