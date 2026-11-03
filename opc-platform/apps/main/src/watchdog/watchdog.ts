import type { WorkTask } from '@opc/shared/domain';
import type { ThreadRepository } from '../data/threadRepository';

/**
 * 进展监督 —— 三层验收里的第 ① 层。
 *
 * 判的不是「交付物对不对」，而是「它还在往前走吗」。这个区别很重要：判错了
 * 最多是提前叫你一声，不会把一个好交付物判成坏交付物。
 *
 * Super-agent 的 Watchdog 讲的是同一件事：异常通常不是进程崩了，而是模型在
 * 无效循环里转圈、或者慢慢偏离了目标 (docs/v2/01-core.md §9)。
 *
 * 这一版只做**程序层**：不花一个 token，靠时间和步骤就能抓住大部分转圈。
 * 模型层（「这段输出还在原目标上吗」）留给下一步——它更贵，也更容易误判，
 * 应该在程序层证明抓得准之后再上。
 */

export interface WatchdogThresholds {
  /** 一直在跑、但很久没有任何新步骤。 */
  stalledMs: number;
  /** 开了之后一直没开工。 */
  orphanMs: number;
  /** 同一条步骤文本重复多少次算原地打转。 */
  repeatLimit: number;
  /** 只在最近这么多步里找重复。 */
  window: number;
}

export const DEFAULT_THRESHOLDS: WatchdogThresholds = {
  stalledMs: 30 * 60_000,
  orphanMs: 2 * 60 * 60_000,
  repeatLimit: 5,
  window: 20,
};

export type Verdict =
  | { kind: 'ok' }
  | { kind: 'spinning'; reason: string }
  | { kind: 'stalled'; reason: string }
  | { kind: 'orphaned'; reason: string };

export type Diagnosis = Exclude<Verdict, { kind: 'ok' }>;

/**
 * 一个任务的体检。纯函数，不碰数据库、不发请求，所以可以按分钟跑。
 *
 * 顺序是有意的：先看「是不是在重复同一件事」——那是转圈最典型的形状，
 * 也最早能被发现；再看时间，因为超时是结果，不是原因。
 */
export function inspectTask(
  task: WorkTask,
  now: number,
  thresholds: WatchdogThresholds = DEFAULT_THRESHOLDS,
): Verdict {
  if (task.status !== 'running' && task.status !== 'open') return { kind: 'ok' };

  const recent = task.steps.slice(-thresholds.window);
  const counts = new Map<string, number>();
  for (const step of recent) {
    const text = step.text.trim();
    if (!text) continue;
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  for (const [text, count] of counts) {
    if (count >= thresholds.repeatLimit) {
      return {
        kind: 'spinning',
        reason: `最近 ${recent.length} 步里有 ${count} 步是同一句：「${clip(text)}」。它可能卡在同一个地方了。`,
      };
    }
  }

  if (task.status === 'running') {
    const idleMs = now - task.updatedAt;
    if (idleMs >= thresholds.stalledMs) {
      return {
        kind: 'stalled',
        reason: `已经跑了 ${minutes(idleMs)} 分钟没有任何新进展。可能是命令卡住了，也可能是在等一个不会来的响应。`,
      };
    }
    return { kind: 'ok' };
  }

  const waitingMs = now - task.createdAt;
  if (waitingMs >= thresholds.orphanMs) {
    return {
      kind: 'orphaned',
      reason: `排了 ${minutes(waitingMs)} 分钟还没开工。可能是没有可用的人，也可能是被前一个任务挡住了。`,
    };
  }
  return { kind: 'ok' };
}

export interface WatchdogDeps {
  threads: ThreadRepository;
  /** Only non-terminal work is worth looking at. */
  pending: () => WorkTask[];
  now?: () => number;
  thresholds?: Partial<WatchdogThresholds>;
  /** Test seam / telemetry hook. */
  onDiagnosis?: (task: WorkTask, diagnosis: Diagnosis) => void;
}

/**
 * The loop. Runs on a timer, costs nothing when everything is healthy.
 *
 * It **surfaces**, it does not kill: a diagnosis becomes a `decide` report on the
 * line of work, and you decides. Killing a run that is about to succeed is
 * exactly the kind of clever automation this project's P6 forbids.
 */
export class Watchdog {
  private readonly thresholds: WatchdogThresholds;
  private readonly now: () => number;
  /** One report per task per diagnosis — a watchdog that repeats itself is noise. */
  private readonly reported = new Set<string>();

  constructor(private readonly deps: WatchdogDeps) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...deps.thresholds };
    this.now = deps.now ?? (() => Date.now());
  }

  /** One pass. Returns how many tasks it had to speak up about. */
  sweep = (): number => {
    const now = this.now();
    let spoken = 0;

    for (const task of this.deps.pending()) {
      const verdict = inspectTask(task, now, this.thresholds);
      if (verdict.kind === 'ok') continue;

      const key = `${task.id}:${verdict.kind}`;
      if (this.reported.has(key)) continue;
      this.reported.add(key);
      spoken += 1;

      // A task with no line of work has nowhere to report to; the ledger still
      // shows it, so nothing is hidden — it just cannot reach the your queue.
      if (task.threadId) {
        this.deps.threads.addReport({
          threadId: task.threadId,
          level: 'decide',
          title: task.title,
          body: verdict.reason,
        });
        this.deps.threads.setState(task.threadId, 'waiting');
      }
      this.deps.onDiagnosis?.(task, verdict);
    }

    return spoken;
  };

  /** Test seam: forget what was already said. */
  reset(): void {
    this.reported.clear();
  }
}

function minutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

function clip(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}
