import type { TaskStatus, WorkTask } from '@opc/shared/domain';

/**
 * Pure reads over one project's work.
 *
 * Kept out of the page because the same questions — "how far along", "what is
 * stuck", "which column does this card go in" — are asked by the rail, the
 * vitals strip and the board, and three slightly different answers is exactly
 * how a page starts contradicting itself.
 */

export interface ProjectStats {
  total: number;
  done: number;
  active: number;
  blocked: number;
  todo: number;
}

export function statsOf(tasks: readonly WorkTask[]): ProjectStats {
  const stats: ProjectStats = { total: tasks.length, done: 0, active: 0, blocked: 0, todo: 0 };
  for (const task of tasks) {
    if (task.status === 'delivered') stats.done += 1;
    else if (task.status === 'running' || task.status === 'review' || task.status === 'accepted')
      stats.active += 1;
    else if (task.status === 'rejected' || task.status === 'failed') stats.blocked += 1;
    else stats.todo += 1;
  }
  return stats;
}

/** 0–1, and 0 rather than NaN for a project nothing has been dispatched to yet. */
export function completionOf(stats: ProjectStats): number {
  return stats.total === 0 ? 0 : stats.done / stats.total;
}

export type BoardColumn = 'todo' | 'doing' | 'review' | 'done';

export const BOARD_COLUMNS = ['todo', 'doing', 'review', 'done'] as const;

/**
 * One status, one column.
 *
 * `accepted` sits in "doing" because a task the manager signed off is still not
 * delivered — collapsing it into "done" would inflate the only number the boss
 * reads as progress. Cancelled tasks leave the board entirely; they are counted
 * in the header instead of occupying a slot forever.
 */
export function columnOf(status: TaskStatus): BoardColumn | null {
  switch (status) {
    case 'delivered':
      return 'done';
    case 'review':
      return 'review';
    case 'running':
    case 'accepted':
      return 'doing';
    case 'open':
    case 'rejected':
    case 'failed':
      return 'todo';
    case 'cancelled':
      return null;
  }
}

const PRIORITY_RANK: Record<WorkTask['priority'], number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** Live work first; inside a column, urgent then most recently touched. */
export function boardOf(tasks: readonly WorkTask[]): Record<BoardColumn, WorkTask[]> {
  const board: Record<BoardColumn, WorkTask[]> = { todo: [], doing: [], review: [], done: [] };
  for (const task of tasks) {
    const column = columnOf(task.status);
    if (column) board[column].push(task);
  }
  for (const column of BOARD_COLUMNS) {
    board[column].sort(
      (left, right) =>
        PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] ||
        right.updatedAt - left.updatedAt,
    );
  }
  return board;
}

export function isOverdue(task: WorkTask, now = Date.now()): boolean {
  if (!task.dueAt) return false;
  return task.dueAt < now && task.status !== 'delivered' && task.status !== 'cancelled';
}

/** A failed or rejected task is not "to do" — it is asking to be looked at. */
export function needsAttention(status: TaskStatus): boolean {
  return status === 'rejected' || status === 'failed';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The budget period, in the same `YYYY-MM` shape the ledger uses. */
export function periodKeyOf(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** Bytes and file count across a project, so the panel does not sum twice. */
export function artifactTotalsOf(tasks: readonly WorkTask[]): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const task of tasks) {
    count += task.artifacts.length;
    for (const artifact of task.artifacts) bytes += artifact.bytes;
  }
  return { count, bytes };
}
