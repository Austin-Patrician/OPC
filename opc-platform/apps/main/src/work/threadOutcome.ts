import type { AttentionLevel, TaskStatus, ThreadState, WorkTask } from '@opc/shared/domain';
import { isUnverified } from './acceptanceGate';

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
  /** What you is told, if anything. */
  report: { level: AttentionLevel; title: string; body: string } | null;
}

const STILL_GOING: readonly TaskStatus[] = ['open', 'running'];

export interface ThreadOutcomeOptions {
  /**
   * 静默线（§3.4）。
   *
   * 规矩是反的：**永远不 `decide`**。`decide` 的意思是「我要你放下手上的事」，而投机
   * 的前提恰恰是这件事还没有确定性价值。所以判据换成闸门：
   *
   * - 闸门过了 → `notify`（"我查了一下，是这样"，值得他知道）
   * - 没过 / 没有闸门 → `silent` + 归档（"我试过了，不值得"也是一条结论，但不该打断他）
   */
  speculative?: boolean;
}

export function threadOutcomeFor(
  task: WorkTask,
  options: ThreadOutcomeOptions = {},
): ThreadOutcome | null {
  if (!task.threadId) return null;
  if (STILL_GOING.includes(task.status)) return null;
  const speculative = options.speculative === true;

  switch (task.status) {
    case 'accepted':
      if (speculative) {
        // 静默线的价值判断只有一条：闸门过了没有。没有闸门就没有判据，也就没有资格
        // 打断他——归档，留记录。
        return isUnverified(task)
          ? { state: 'archived', report: { level: 'silent', title: task.title, body: summarise(task) } }
          : { state: 'done', report: { level: 'notify', title: task.title, body: summarise(task) } };
      }
      if (isUnverified(task)) {
        // Nothing was proven — only that files landed. Saying "done" here would
        // be the system claiming a verdict it never had.
        return {
          state: 'waiting',
          report: {
            level: 'decide',
            title: task.title,
            body: `做完了，但我没有可执行的验收条件，判定不了对错。${summarise(task)}`,
          },
        };
      }
      // The expected ending. It is recorded (level `silent` keeps it out of the
      // queue) so the thread keeps a history you can read later.
      return {
        state: 'done',
        report: { level: 'silent', title: task.title, body: summarise(task) },
      };

    case 'delivered':
      // Only reachable through the your own sign-off (`userDecision`), so asking
      // again would be asking the same person the same question twice.
      return {
        state: 'done',
        report: { level: 'silent', title: task.title, body: summarise(task) },
      };

    case 'rejected':
      if (speculative) return silentArchive(task, `没通过验收：${task.acceptance?.reason ?? ''}`);
      return {
        state: 'waiting',
        report: {
          level: 'decide',
          title: task.title,
          body: `没通过验收：${task.acceptance?.reason ?? task.error ?? '验收命令未通过'}`,
        },
      };

    case 'failed':
      if (speculative) return silentArchive(task, `跑挂了：${task.error ?? '未知错误'}`);
      return {
        state: 'failed',
        report: {
          level: 'decide',
          title: task.title,
          body: `跑挂了：${task.error ?? '未知错误'}`,
        },
      };

    case 'review':
      // A manager is looking at it. You hears about it when the verdict is
      // in, not while it is pending — otherwise sign-off costs you a glance
      // per round instead of one per task.
      return { state: 'waiting', report: null };

    case 'cancelled':
      return { state: 'archived', report: null };

    default:
      return null;
  }
}

/** 静默线没跑成：归档一条记录，不占他的注意力。 */
function silentArchive(task: WorkTask, reason: string): ThreadOutcome {
  return {
    state: 'archived',
    report: { level: 'silent', title: task.title, body: `${reason}\n${summarise(task)}` },
  };
}

function summarise(task: WorkTask): string {
  const files = task.artifacts.map((artifact) => artifact.relPath);
  if (files.length === 0) return '没有产出文件';
  return `产出：${files.join('、')}`;
}
