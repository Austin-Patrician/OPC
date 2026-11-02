import type { AttentionLevel, TaskStatus, ThreadState, WorkTask } from '@opc/shared/domain';

/**
 * How a finished task speaks to its line of work.
 *
 * Kept pure and separate from `WorkService` for one reason: this mapping *is* the
 * product promise, and it must be testable without running a model, a workspace
 * or a harness. "Finished quietly" is not a default that drifted in — it is the
 * case written first below.
 *
 * Returns null for tasks that do not belong to a thread (nothing to report to)
 * and for states that are not yet an outcome (a task still running, or one that
 * is sitting in manager sign-off).
 */
export interface ThreadOutcome {
  /** The line of work's new state. */
  state: ThreadState;
  /** What the boss is told, if anything. */
  report: { level: AttentionLevel; title: string; body: string } | null;
}

const STILL_GOING: readonly TaskStatus[] = ['open', 'running'];

export function threadOutcomeFor(task: WorkTask): ThreadOutcome | null {
  if (!task.threadId) return null;
  if (STILL_GOING.includes(task.status)) return null;

  switch (task.status) {
    case 'accepted':
      // The expected ending. It is recorded (level `silent` keeps it out of the
      // queue) so the thread keeps a history the boss can read later.
      return {
        state: 'done',
        report: { level: 'silent', title: task.title, body: summarise(task) },
      };

    case 'delivered':
      // Produced, but the last word is human by design.
      return {
        state: 'waiting',
        report: {
          level: 'decide',
          title: task.title,
          body: `交付物已生成，等你过一眼。${summarise(task)}`,
        },
      };

    case 'rejected':
      return {
        state: 'waiting',
        report: {
          level: 'decide',
          title: task.title,
          body: `没通过验收：${task.acceptance?.reason ?? task.error ?? '验收命令未通过'}`,
        },
      };

    case 'failed':
      return {
        state: 'failed',
        report: {
          level: 'decide',
          title: task.title,
          body: `跑挂了：${task.error ?? '未知错误'}`,
        },
      };

    case 'review':
      // A manager is looking at it. The boss hears about it when the verdict is
      // in, not while it is pending — otherwise sign-off costs the boss a glance
      // per round instead of one per task.
      return { state: 'waiting', report: null };

    case 'cancelled':
      return { state: 'archived', report: null };

    default:
      return null;
  }
}

function summarise(task: WorkTask): string {
  const files = task.artifacts.map((artifact) => artifact.relPath);
  if (files.length === 0) return '没有产出文件';
  return `产出：${files.join('、')}`;
}
