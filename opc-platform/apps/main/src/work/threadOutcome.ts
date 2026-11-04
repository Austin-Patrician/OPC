import type { AttentionLevel, TaskFailureKind, TaskStatus, ThreadState, WorkTask } from '@opc/shared/domain';
import { isUnverified } from './acceptanceGate';
import { FAILURE_ADVICE, FAILURE_LABEL } from './failure';

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
            body: withAdvice(
              'unverified',
              `做完了，但我没有可执行的验收条件，判定不了对错。${summarise(task)}`,
            ),
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

    case 'rejected': {
      const kind: TaskFailureKind = task.errorKind ?? 'rejected';
      const reason = task.acceptance?.reason ?? task.error ?? '验收命令未通过';
      if (speculative) return silentArchive(task, withAdvice(kind, `没通过验收：${reason}`));
      return {
        state: 'waiting',
        report: {
          level: 'decide',
          title: task.title,
          body: withAdvice(kind, `没通过验收：${reason}`),
        },
      };
    }

    case 'failed': {
      // 分类（§3.7）在这里第一次变成人看得见的东西：同样是 `failed`，
      // 「没模型」和「运行时被打断」该做的事完全不同，所以话也不同。
      const kind: TaskFailureKind = task.errorKind ?? 'retryable';
      const reason = task.error ?? '未知错误';
      if (speculative) return silentArchive(task, withAdvice(kind, `${FAILURE_LABEL[kind]}：${reason}`));
      return {
        state: 'failed',
        report: {
          level: 'decide',
          title: task.title,
          body: withAdvice(kind, `${FAILURE_LABEL[kind]}：${reason}`),
        },
      };
    }

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

/**
 * 原因 + **所以呢**。
 *
 * 只给原因的话，人会读到「运行中断」然后自己猜该不该再点一次；只给建议的话，人不知道
 * 发生了什么。两行一起才是可执行的一句话——这也是 §3.7 存在的理由。
 */
function withAdvice(kind: TaskFailureKind, message: string): string {
  return `${message}\n（${FAILURE_ADVICE[kind]}）`;
}

function summarise(task: WorkTask): string {
  const files = task.artifacts.map((artifact) => artifact.relPath);
  if (files.length === 0) return '没有产出文件';
  return `产出：${files.join('、')}`;
}
