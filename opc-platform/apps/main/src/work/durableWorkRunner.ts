import type { WorkTask } from '@opc/shared/domain';
import type { Context } from '@earendil-works/chord/context';
import type { Conversation, Harness, TaskId } from '@earendil-works/pi-durable';
import path from 'node:path';
import type { TaskRepository } from '../data/taskRepository';
import { isUnverified } from './acceptanceGate';
import { classifyTerminal, FAILURE_LABEL } from './failure';
import { runtimeIdentityFor, type RuntimeIdentity } from './runtimeIdentity';
import { WorkTaskDefinition, type WorkTaskInput, type WorkTaskResult } from './workTaskDefinition';

export interface DurableWorkRunnerDeps {
  repository: TaskRepository;
  /** Opens (and caches) the task's runtime with our task definition installed. */
  harnessFor: (identity: RuntimeIdentity) => Promise<{ harness: Harness; root: Conversation }>;
  context: () => Promise<Context>;
  workspaceRoot: string;
  checksRoot: string;
  onTaskChanged: (taskId: string) => void;
  /** Budget settlement: pass charges, everything else releases. */
  onFinished: (
    taskId: string,
    outcome: 'completed' | 'failed' | 'aborted' | 'orphaned' | 'faulted',
    result: WorkTaskResult | null,
  ) => void;
  onResumed?: (taskId: string) => void;
}

/**
 * Drives work through pi-durable instead of an in-memory promise.
 *
 * Why: a crash mid-run must not lose the task, the files it already wrote, or its
 * budget reservation. pi commits a checkpoint at every phase boundary, so a
 * restart resumes from `produce` or `verify` — never from the beginning.
 */
export class DurableWorkRunner {
  constructor(private readonly deps: DurableWorkRunnerDeps) {}

  async run(taskId: string): Promise<WorkTask> {
    const task = this.deps.repository.getTask(taskId);
    if (!task) throw new Error(`未知任务: ${taskId}`);

    // Business state first: a crash right after this line must leave a task the
    // next start can recognise as "was running".
    this.deps.repository.setStatus(taskId, 'running', { startedAt: Date.now(), error: null });
    this.deps.onTaskChanged(taskId);

    const { harness, root } = await this.deps.harnessFor(runtimeIdentityFor(task));
    const context = await this.deps.context();

    const input: WorkTaskInput = {
      workTaskId: task.id,
      title: task.title,
      brief: task.brief,
      deliverableSpec: task.deliverableSpec,
      acceptanceCommand: task.acceptanceCommand,
      workspaceDir: path.resolve(this.deps.workspaceRoot, task.workspaceRelPath),
      checksDir: path.join(this.deps.checksRoot, task.id),
      maxAttempts: 3,
    };

    const durableId = await root.commit(
      (tx) => tx.createTask(WorkTaskDefinition, input, { ownership: { kind: 'conversation' } }),
      context,
    );

    // Stored as text; cast back when resuming (TaskId is a branded string).
    this.deps.repository.setDurableTaskId(task.id, String(durableId));
    harness.resume();

    return this.awaitOutcome(task.id, harness, durableId);
  }

  /**
   * Startup reconciliation: every task the previous process thought was running
   * either continues (durable task exists) or is failed with its reservation freed.
   */
  async resumeInterrupted(): Promise<WorkTask[]> {
    const resumed: WorkTask[] = [];

    for (const task of this.deps.repository.listPending()) {
      const storedId = this.deps.repository.getDurableTaskId(task.id);
      const durableId = storedId as TaskId<WorkTaskResult> | undefined;

      if (!durableId) {
        if (task.status === 'open') {
          // Dispatched but never started (crash between the two calls): re-dispatch.
          this.deps.repository.addStep(task.id, '启动恢复：任务未开始，重新派发');
          resumed.push(await this.run(task.id));
          continue;
        }
        this.deps.repository.addStep(task.id, '启动恢复：缺少 durable 记录，标记失败并释放预算');
        this.deps.repository.setStatus(task.id, 'failed', {
          finishedAt: Date.now(),
          error: '中断的任务缺少 durable 记录',
          // 起不来的一类：重跑也没有 durable 记录可续，得有人看一眼。
          errorKind: 'blocked',
        });
        this.deps.onFinished(task.id, 'failed', null);
        this.deps.onTaskChanged(task.id);
        continue;
      }

      this.deps.onResumed?.(task.id);
      this.deps.repository.addStep(task.id, '启动恢复：从 durable checkpoint 继续');
      const { harness } = await this.deps.harnessFor(runtimeIdentityFor(task));
      harness.resume();
      // Recovery must be bounded: a task that never reaches terminal (e.g. its
      // definition changed) would otherwise hold its reservation forever.
      resumed.push(await this.awaitOutcome(task.id, harness, durableId, 60_000));
    }

    return resumed;
  }

  private async awaitOutcome(
    taskId: string,
    harness: Harness,
    durableId: TaskId<WorkTaskResult>,
    timeoutMs = 10 * 60_000,
  ): Promise<WorkTask> {
    const context = await this.deps.context();
    let outcome: 'completed' | 'failed' | 'aborted' | 'orphaned' | 'faulted';
    let result: WorkTaskResult | null = null;

    try {
      // `waitForTask` resolves immediately with the current record when the task is
      // not in this process's live set (the normal case right after `resume()`), so
      // poll until the committed state is actually terminal.
      const startedAt = Date.now();
      let record = await harness.waitForTask(durableId, context);

      while (record.state.status !== 'terminal') {
        // 在等子任务的父，等的是**别人的算力**，不是自己的：额度按它的处境放宽。
        // 否则一次正常的团队协作会被当成"卡住十分钟"判掉——那是这一层最不该犯的错。
        const limit = this.deps.repository.listChildren(taskId).length > 0 ? 45 * 60_000 : timeoutMs;
        if (Date.now() - startedAt > limit) throw new Error('等待 durable 任务超时');
        await new Promise((resolve) => setTimeout(resolve, 200));
        record = await harness.waitForTask(durableId, context);
      }

      const terminal = record.state.outcome;
      outcome = terminal.status;
      const maybeResult = 'result' in terminal ? terminal.result : undefined;
      result = (maybeResult as WorkTaskResult | undefined) ?? null;
    } catch (error) {
      this.deps.repository.addStep(
        taskId,
        `恢复失败：${error instanceof Error ? error.message : String(error)}`,
      );
      outcome = 'faulted';
    }

    const accepted = outcome === 'completed' && result?.verdict === 'pass';
    // 分类（§3.7）：同一个"失败"背后是四种不同处境，该做的事彼此矛盾。
    const current = this.deps.repository.getTask(taskId);
    const kind = classifyTerminal({
      outcome,
      ...(result ? { verdict: result.verdict } : {}),
      unverified: current ? isUnverified(current) : false,
    });
    const label = kind ? FAILURE_LABEL[kind] : outcome;
    this.deps.repository.addStep(
      taskId,
      outcome === 'completed'
        ? accepted
          ? `任务完成（${result?.attempts ?? 1} 次尝试）`
          : `任务未通过（${result?.reason ?? '验收失败'}）`
        : `任务结束：${label}`,
    );
    // 被中止不是"没通过验收"：它的 status 是 `cancelled`，由 `threadOutcomeFor`
    // 静默归档，而不是拿一条 `decide` 去打扰人。
    const status: 'accepted' | 'rejected' | 'cancelled' =
      accepted ? 'accepted' : kind === 'cancelled' ? 'cancelled' : 'rejected';
    this.deps.repository.setStatus(taskId, status, {
      finishedAt: Date.now(),
      error: accepted ? null : (result?.reason ?? label),
      errorKind: accepted ? null : kind,
    });

    this.deps.onTaskChanged(taskId);
    try {
      this.deps.onFinished(taskId, outcome, result);
    } catch (error) {
      // Settlement is important but must never strand a finished task (this hung a
      // probe for 10 minutes once: a missing column threw inside the callback).
      console.error('onFinished failed', error);
    }

    return this.deps.repository.getTask(taskId) as WorkTask;
  }
}
