import type { TaskAcceptance, TaskOutputSpec, TaskRecord, WorkReport, WorkTask } from '@opc/shared/domain';
import type { TaskRepository } from '../data/taskRepository';
import type { Context } from '@earendil-works/chord/context';
import { defineTask, type TaskDefinition } from '@earendil-works/pi-durable';
import fs from 'node:fs';
import {
  VERIFY_HTTP_OK,
  VERIFY_IMAGE_200,
  VERIFY_NODE_TEST,
  VERIFY_REVIEW_VERDICT,
} from './acceptanceTemplate';
import type { AcceptanceFeedback, TaskBrain } from './brain';
import { runCommand } from './exec';
import type { NetworkClient } from '../network/networkClient';
import type { RuntimeService } from '../runtime/service';
import { ensureDir, listWorkspaceFiles, writeFileWithin } from './workspace';
import {
  buildChildren,
  JOIN_POLL_MS,
  JOIN_TIMEOUT_MS,
  MAX_JOINS,
  unsettledChildren,
} from './children';

/** What travels into the durable task. Paths, not objects: input must be JSON. */
export interface WorkTaskInput {
  workTaskId: string;
  title: string;
  contract: NonNullable<WorkTask['contract']>;
  acceptanceCommand: string[];
  workspaceDir: string;
  checksDir: string;
  maxAttempts: number;
}

/**
 * A discriminated union, not one object with a phase field: pi narrows each
 * handler's checkpoint with `Extract<S, { phase: P }>`, which needs real members.
 */
type WorkTaskState =
  | {
      phase: 'produce';
      attempt: number;
      /** 已经收口几次。父可以再拆，但不许无限往返。 */
      joined?: number;
      lastEvidence?: AcceptanceFeedback['evidence'];
      lastReason?: string;
    }
  | { phase: 'approval'; attempt: number; reportId: string }
  /**
   * 等子任务交回（团队收口）。
   *
   * 等必须**持久**：一个进程在等另外几个进程的活，中途崩了要能接着等。所以这里是
   * pi 的 `sleepUntil`，不是 `await new Promise`——后者在重启后什么都不会剩下。
   */
  | { phase: 'collect'; attempt: number; joined: number; since: number }
  | { phase: 'verify'; attempt: number };

export interface WorkTaskResult {
  verdict: 'pass' | 'fail';
  attempts: number;
  reason: string;
  answer?: string;
}

/**
 * Host services the phases need. Injected once at bootstrap so the durable task
 * definition itself stays a pure declaration (pi's registry stores definitions,
 * not closures over app state).
 */
export interface WorkTaskServices {
  brain: TaskBrain;
  /** Recalls Markdown-first memory pack (`USER.md` + `RULES.md`, matched `PLAYBOOK.md`, matched `topics/`). */
  recallMemoryPack?: (task: {
    assigneeId: string;
    title: string;
    brief: string;
    threadId?: string;
  }) => Promise<{ core?: string; playbook: string[]; topics: string[] }>;
  recallFacts?: (task: {
    assigneeId: string;
    /** 这条线自己的规定能一起召回。 */
    threadId?: string;
  }) => Promise<{ statement: string; scopeType: string }[]>;
  /**
   * 这件事的**原始记录**：这条线上的事件、之前的汇报、之前跑过的任务。
   *
   * 单独一个口子，和记忆那三条通道并列而不是混进去：记忆是"可能有用的事实"，
   * 记录是"这件事自己的证据"。混在一起，执行体就分不清"别人说过什么"和
   * "这次是怎么回事"。
   */
  recallRecords?: (task: {
    assigneeId: string;
    taskId: string;
    threadId?: string;
  }) => TaskRecord[];
  /** Used when the primary brain throws (e.g. revoked key): degrade, don't fail. */
  fallbackBrain: TaskBrain;
  repository: TaskRepository;
  recordDurableStep: (taskId: string, text: string) => Promise<void>;
  onTaskChanged: (taskId: string) => void;
  /** Returns true while the task still has an unanswered MCP approval. */
  approvalPending?: (taskId: string, reportId?: string) => boolean;
  approvalReport?: (taskId: string) => WorkReport | null;
  /** Proxy policy for acceptance commands (git/npm/scripts). */
  network?: NetworkClient;
  /** Company base environment; absent = ambient PATH with the Electron node fallback. */
  runtime?: RuntimeService;
}

let services: WorkTaskServices | null = null;

export function setWorkTaskServices(next: WorkTaskServices): void {
  services = next;
}

function requireServices(): WorkTaskServices {
  if (!services) throw new Error('WorkTaskServices 未初始化');
  return services;
}

/**
 * One work task, as a pi-durable state machine.
 *
 *   produce ──▶ verify ──(fail, attempts left)──▶ produce
 *      │             └──(pass / out of attempts)──▶ terminal
 *      └──(拆解过、子任务还没交回)──▶ collect ──(都回来了 / 等太久)──▶ produce
 *
 * `collect` 是"团队"和"一堆并行的任务"之间的差别：没有它，父不等子就走了，线也就
 * 被第一个跑完的那个定义了。
 *
 * Every phase commits a checkpoint, so a crash mid-run resumes from the last
 * committed phase instead of restarting the whole pipeline or leaking its budget
 * reservation.
 */
const definition: TaskDefinition<WorkTaskInput, WorkTaskState, WorkTaskResult, object> = {
  name: 'opc.work.task',
  version: 1,

  initial: () => ({ phase: 'produce', attempt: 0 }),

  phases: {
    produce: async (task, runtime, context) => {
      const { brain, repository, recordDurableStep, onTaskChanged } = requireServices();
      const attempt = task.state.checkpoint.attempt + 1;
      const feedback: AcceptanceFeedback | undefined = task.state.checkpoint.lastEvidence
        ? {
            attempt: attempt - 1,
            reason: task.state.checkpoint.lastReason ?? '验收未通过',
            evidence: task.state.checkpoint.lastEvidence,
          }
        : undefined;

      logStep(task.input.workTaskId, `第 ${attempt} 次尝试`, { repository, recordDurableStep, onTaskChanged });

      const workTask = toWorkTask(repository, task.input.workTaskId);
      const workspaceDir = ensureDir(task.input.workspaceDir);

      if (services?.recallMemoryPack) {
        try {
          const pack = await services.recallMemoryPack({
            assigneeId: workTask.assigneeId,
            title: workTask.title,
            brief: workTask.brief,
            ...(workTask.threadId ? { threadId: workTask.threadId } : {}),
          });
          if (pack.core) workTask.memoryCore = pack.core;
          if (pack.playbook.length > 0) workTask.memoryPlaybook = pack.playbook;
          if (pack.topics.length > 0) workTask.memoryTopics = pack.topics;
          const totalItems =
            (pack.core ? 1 : 0) + pack.playbook.length + pack.topics.length;
          if (totalItems > 0) {
            logStep(
              task.input.workTaskId,
              `注入记忆上下文（核心画像/铁律${pack.core ? '√' : '×'} · 避坑 ${pack.playbook.length} 条 · 专题 ${pack.topics.length} 条）`,
              { repository, recordDurableStep, onTaskChanged },
            );
          }
        } catch (error) {
          logStep(
            task.input.workTaskId,
            `记忆上下文读取失败（${error instanceof Error ? error.message : String(error)}）`,
            { repository, recordDurableStep, onTaskChanged },
          );
        }
      }

      if (services?.recallFacts) {
        try {
          const facts = await services.recallFacts({
            assigneeId: workTask.assigneeId,
            ...(workTask.threadId ? { threadId: workTask.threadId } : {}),
          });
          if (facts.length > 0) {
            workTask.facts = facts;
            logStep(task.input.workTaskId, `注入 ${facts.length} 条工作台规定`, {
              repository,
              recordDurableStep,
              onTaskChanged,
            });
          }
        } catch (error) {
          logStep(task.input.workTaskId, `事实读取失败（${error instanceof Error ? error.message : String(error)}）`, {
            repository,
            recordDurableStep,
            onTaskChanged,
          });
        }
      }

      if (services?.recallRecords) {
        try {
          const records = services.recallRecords({
            assigneeId: workTask.assigneeId,
            taskId: workTask.id,
            ...(workTask.threadId ? { threadId: workTask.threadId } : {}),
          });
          if (records.length > 0) {
            workTask.records = records;
            logStep(task.input.workTaskId, `注入 ${records.length} 条原始记录`, {
              repository,
              recordDurableStep,
              onTaskChanged,
            });
          }
        } catch (error) {
          logStep(
            task.input.workTaskId,
            `原始记录读取失败（${error instanceof Error ? error.message : String(error)}）`,
            { repository, recordDurableStep, onTaskChanged },
          );
        }
      }

      // 子任务的产出。这是汇总那几轮的主料——父要拿它们合成自己的交付物，
      // 而不是重新做一遍子任务做过的事。
      const children = repository.listChildren(workTask.id);
      if (children.length > 0) {
        workTask.children = buildChildren(children);
        logStep(task.input.workTaskId, `注入 ${children.length} 条子任务产出`, {
          repository,
          recordDurableStep,
          onTaskChanged,
        });
      }

      const runBrain = async (selected: TaskBrain) =>
        selected.execute({
          task: workTask,
          workspaceDir,
          durableTaskId: String(runtime.taskId),
          feedback,
          // Real spend is persisted per task, so a resumed run still charges correctly.
          reportUsage: (usage) => {
            repository.addTokens(task.input.workTaskId, usage.total);
            if (usage.costUsd) repository.addCost(task.input.workTaskId, usage.costUsd);
          },
          log: (text) => {
            logStep(task.input.workTaskId, text, { repository, recordDurableStep, onTaskChanged });
          },
        });

      try {
        const answer = (await runBrain(brain)).answer?.trim() ?? '';
        if (answer) repository.setAnswer(workTask.id, answer);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const latestStatus = repository.getTask(task.input.workTaskId)?.status;
        if (runtime.signal.aborted || latestStatus === 'cancelled') {
          logStep(task.input.workTaskId, '任务已中止，停止继续执行', {
            repository,
            recordDurableStep,
            onTaskChanged,
          });
          return;
        }
        if (services?.approvalPending?.(task.input.workTaskId)) {
          logStep(task.input.workTaskId, `等待审批（${message}）`, {
            repository,
            recordDurableStep,
            onTaskChanged,
          });
        } else {
          logStep(task.input.workTaskId, `主执行器失败（${message}），回退到脚本化执行`, {
            repository,
            recordDurableStep,
            onTaskChanged,
          });
          const answer = (await runBrain(requireServices().fallbackBrain)).answer?.trim() ?? '';
          if (answer) repository.setAnswer(workTask.id, answer);
        }
      }

      const approval = services?.approvalReport?.(workTask.id) ?? undefined;
      if (approval) {
        logStep(task.input.workTaskId, `任务暂停，等待审批：${approval.title}`, {
          repository,
          recordDurableStep,
          onTaskChanged,
        });
        await runtime.sleepUntil(
          Date.now() + 500,
          { phase: 'approval', attempt, reportId: approval.id },
          context,
        );
        return;
      }

      /*
       * 拆解过的任务必须先收口（原文 §2.2 的 Agent Team）。判断放在**跑完之后**：
       * 拆解是在这一轮里发生的，开跑之前它是零个子任务。
       *
       * `joined === 0` 时无条件收口一次，哪怕子任务都已经跑完了——不收口，这一轮就
       * 没见过它们的产物，父的交付物会是一份**不含子任务成果**的东西，而它还会通过
       * 验收。收口一次的真实用途不是等，是让下一轮看得见它们。
       */
      const joined = task.state.checkpoint.joined ?? 0;
      const pending = unsettledChildren(children);
      const mustJoinOnce = joined === 0 && children.length > 0;
      if ((pending.length > 0 || mustJoinOnce) && joined < MAX_JOINS) {
        logStep(
          task.input.workTaskId,
          pending.length > 0 ? `等 ${pending.length} 个子任务交回` : `收口 ${children.length} 个子任务`,
          { repository, recordDurableStep, onTaskChanged },
        );
        await runtime.sleepUntil(
          Date.now() + JOIN_POLL_MS,
          { phase: 'collect', attempt, joined, since: Date.now() },
          context,
        );
        return;
      }

      await runtime.commit(
        () => ({ status: 'running', checkpoint: { ...task.state.checkpoint, phase: 'verify', attempt } }),
        context,
      );
    },

    /**
     * 收口：等子任务。
     *
     * 只有两种结局，没有第三种：**都回来了**，或者**等太久了**。后者照样往下走，只是
     * 把"还有几个没回来"记进步骤流——挂着不动的任务是最糟的账。
     */
    collect: async (task, runtime, context) => {
      const { repository, recordDurableStep, onTaskChanged } = requireServices();
      const { attempt, joined, since } = task.state.checkpoint;
      const children = repository.listChildren(task.input.workTaskId);
      const pending = unsettledChildren(children);
      const step = (text: string) =>
        logStep(task.input.workTaskId, text, { repository, recordDurableStep, onTaskChanged });

      if (pending.length === 0) {
        step(`子任务全部交回（${children.length} 个）`);
      } else if (Date.now() - since > JOIN_TIMEOUT_MS) {
        step(`等子任务超时（还有 ${pending.length} 个没跑完），先按已有的汇总`);
      } else {
        await runtime.sleepUntil(
          Date.now() + JOIN_POLL_MS,
          { phase: 'collect', attempt, joined, since },
          context,
        );
        return;
      }

      await runtime.commit(
        () => ({ status: 'running', checkpoint: { phase: 'produce', attempt, joined: joined + 1 } }),
        context,
      );
    },

    approval: async (task, runtime, context) => {
      const { repository, recordDurableStep, onTaskChanged } = requireServices();
      const { reportId, attempt } = task.state.checkpoint;
      if (services?.approvalPending?.(task.input.workTaskId, reportId)) {
        await runtime.sleepUntil(Date.now() + 500, { phase: 'approval', attempt, reportId }, context);
        return;
      }
      logStep(task.input.workTaskId, '审批已处理，继续原任务', {
        repository,
        recordDurableStep,
        onTaskChanged,
      });
      await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'produce', attempt } }), context);
    },

    verify: async (task, runtime, context) => {
      const { repository, recordDurableStep, onTaskChanged } = requireServices();
      const workTask = toWorkTask(repository, task.input.workTaskId);
      const workspaceDir = ensureDir(task.input.workspaceDir);
      const checksDir = ensureDir(task.input.checksDir);
      writeFileWithin(
        checksDir,
        'verify.mjs',
        workTask.acceptanceTemplate === 'node-test'
          ? VERIFY_NODE_TEST
          : workTask.acceptanceTemplate === 'image-200'
            ? VERIFY_IMAGE_200
            : workTask.acceptanceTemplate === 'review-verdict'
              ? VERIFY_REVIEW_VERDICT
              : VERIFY_HTTP_OK,
      );

      const files = listWorkspaceFiles(workspaceDir);
      const answer = workTask.answer?.trim() ?? '';
      const contract = workTask.contract ?? {
        objective: workTask.brief,
        deliverable: workTask.deliverableSpec,
        outputs: [],
      };
      const outputFailure = missingOutput(contract.outputs, files, answer);
      if (outputFailure) {
        const attempts = task.state.checkpoint.attempt;
        const result: WorkTaskResult = {
          verdict: 'fail',
          attempts,
          reason: outputFailure,
          ...(answer ? { answer } : {}),
        };
        repository.addAcceptance(workTask.id, {
          verdict: 'fail',
          reason: outputFailure,
          evidence: {
            command: ['opc', 'output-contract'],
            exitCode: 1,
            stdoutTail: '',
            stderrTail: outputFailure,
            durationMs: 0,
          },
        });
        if (attempts >= task.input.maxAttempts) {
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result } }), context);
        } else {
          await runtime.commit(
            () => ({
              status: 'running',
              checkpoint: {
                ...task.state.checkpoint,
                phase: 'produce',
                lastEvidence: {
                  command: ['opc', 'output-contract'],
                  exitCode: 1,
                  stdoutTail: '',
                  stderrTail: outputFailure,
                },
                lastReason: outputFailure,
              },
            }),
            context,
          );
        }
        return;
      }

      repository.clearArtifacts(workTask.id);
      for (const file of files) {
        repository.addArtifact(workTask.id, file.relPath, file.absolutePath);
      }

      const acceptance = await accept(workTask, workspaceDir, checksDir);
      repository.addAcceptance(workTask.id, acceptance);
      logStep(
        workTask.id,
        acceptance.verdict === 'pass'
          ? '自动验收通过'
          : `自动验收未通过：${acceptance.reason}`,
        { repository, recordDurableStep, onTaskChanged },
      );

      const attempts = task.state.checkpoint.attempt;
      if (acceptance.verdict === 'pass' || attempts >= task.input.maxAttempts) {
        const result: WorkTaskResult = {
          verdict: acceptance.verdict,
          attempts,
          reason: acceptance.reason,
          ...(answer ? { answer } : {}),
        };
        await runtime.commit(
          () => ({ status: 'terminal', outcome: { status: 'completed', result } }),
          context,
        );
        return;
      }

      await runtime.commit(
        () => ({
          status: 'running',
          checkpoint: {
            ...task.state.checkpoint,
            phase: 'produce',
            lastEvidence: {
              command: acceptance.evidence.command,
              exitCode: acceptance.evidence.exitCode,
              stdoutTail: acceptance.evidence.stdoutTail,
              stderrTail: acceptance.evidence.stderrTail,
            },
            lastReason: acceptance.reason,
          },
        }),
        context,
      );
    },
  },

  abort: async (task, runtime, context) => {
    await runtime.commit(
      () => ({
        status: 'terminal',
        outcome: {
          status: 'aborted',
          result: { verdict: 'fail', attempts: task.state.checkpoint.attempt, reason: '已中止' },
        },
      }),
      context,
    );
  },
};

export const WorkTaskDefinition = defineTask(definition);

function toWorkTask(
  repository: WorkTaskServices['repository'],
  taskId: string,
): WorkTask {
  const task = repository.getTask(taskId);
  if (!task) throw new Error(`未知任务: ${taskId}`);
  return task;
}

function missingOutput(outputs: readonly TaskOutputSpec[], files: readonly { relPath: string }[], answer: string): string | null {
  for (const output of outputs) {
    if (output.kind === 'text' && !answer) return `缺少文本回答：${output.description}`;
    if (output.kind === 'file' && !files.some((file) => file.relPath === output.path)) {
      return `缺少文件交付物：${output.path}`;
    }
  }
  return null;
}

function logStep(
  taskId: string,
  text: string,
  dependencies: {
    repository: WorkTaskServices['repository'];
    recordDurableStep: (taskId: string, text: string) => Promise<void>;
    onTaskChanged: (taskId: string) => void;
  },
): void {
  dependencies.repository.addStep(taskId, text);
  void dependencies.recordDurableStep(taskId, text);
  dependencies.onTaskChanged(taskId);
}

async function accept(
  task: WorkTask,
  workspaceDir: string,
  checksDir: string,
): Promise<Omit<TaskAcceptance, 'createdAt'>> {
  const argv = task.acceptanceCommand.map((part) => part.replace('{checks}', checksDir));
  // The acceptance command runs in the same base environment as the agent's
  // tools. `env` below still wins per-key for the OPC_* contract variables.
  const runtimeEnv = requireServices().runtime?.acceptanceEnv();
  const answer = task.answer ?? '';
  const result = await runCommand(argv, {
    cwd: workspaceDir,
    timeoutMs: 25_000,
    // The report is part of the task result, not a file in the workspace. Keep
    // the legacy REPORT name for existing acceptance scripts and expose the
    // namespaced form for new ones.
    env: { OPC_ENTRY: 'server.js', OPC_EXPECT: 'ok', REPORT: answer, OPC_ANSWER: answer },
    network: requireServices().network,
    ...(runtimeEnv ? { runtime: { env: runtimeEnv } } : {}),
  });

  const passed = result.exitCode === 0;
  const reason = passed
    ? `退出码 0（${result.durationMs}ms）`
    : result.timedOut
      ? '验收命令超时'
      : `退出码 ${result.exitCode ?? 'null'}`;

  fs.accessSync(checksDir);

  return {
    verdict: passed ? 'pass' : 'fail',
    reason,
    evidence: {
      command: result.command.map((part) => part.replace(checksDir, 'checks')),
      exitCode: result.exitCode,
      stdoutTail: result.stdout,
      stderrTail: result.stderr,
      durationMs: result.durationMs,
    },
  };
}

export type { Context };
