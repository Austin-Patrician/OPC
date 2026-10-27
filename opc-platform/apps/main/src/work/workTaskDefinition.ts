import type { TaskAcceptance, WorkTask } from '@opc/shared/domain';
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
import { ensureDir, listWorkspaceFiles, writeFileWithin } from './workspace';

/** What travels into the durable task. Paths, not objects: input must be JSON. */
export interface WorkTaskInput {
  workTaskId: string;
  title: string;
  brief: string;
  deliverableSpec: string;
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
      lastEvidence?: AcceptanceFeedback['evidence'];
      lastReason?: string;
    }
  | { phase: 'verify'; attempt: number };

export interface WorkTaskResult {
  verdict: 'pass' | 'fail';
  attempts: number;
  reason: string;
}

/**
 * Host services the phases need. Injected once at bootstrap so the durable task
 * definition itself stays a pure declaration (pi's registry stores definitions,
 * not closures over app state).
 */
export interface WorkTaskServices {
  brain: TaskBrain;
  /** Recalls the assignee's memories for this task; absent = memory disabled. */
  recallMemories?: (task: {
    assigneeId: string;
    title: string;
    brief: string;
  }) => Promise<{ kind: string; content: string; scopeType: string }[]>;
  /** Company/department facts that apply to this assignee. */
  recallFacts?: (task: {
    assigneeId: string;
  }) => Promise<{ statement: string; scopeType: string }[]>;
  /** Used when the primary brain throws (e.g. revoked key): degrade, don't fail. */
  fallbackBrain: TaskBrain;
  repository: TaskRepository;
  recordDurableStep: (taskId: string, text: string) => Promise<void>;
  onTaskChanged: (taskId: string) => void;
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
 *                    └──(pass / out of attempts)──▶ terminal
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

      // Recall before producing: the same ranking the design specifies (identity →
      // scoped memory → task query), with a hard cap so the prompt stays small.
      if (services?.recallMemories) {
        try {
          const memories = await services.recallMemories({
            assigneeId: workTask.assigneeId,
            title: workTask.title,
            brief: workTask.brief,
          });
          if (memories.length > 0) {
            workTask.memories = memories;
            logStep(task.input.workTaskId, `注入 ${memories.length} 条记忆`, {
              repository,
              recordDurableStep,
              onTaskChanged,
            });
          }
        } catch (error) {
          logStep(task.input.workTaskId, `记忆检索失败（${error instanceof Error ? error.message : String(error)}）`, {
            repository,
            recordDurableStep,
            onTaskChanged,
          });
        }
      }

      if (services?.recallFacts) {
        try {
          const facts = await services.recallFacts({ assigneeId: workTask.assigneeId });
          if (facts.length > 0) {
            workTask.facts = facts;
            logStep(task.input.workTaskId, `注入 ${facts.length} 条公司事实`, {
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
        await runBrain(brain);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logStep(task.input.workTaskId, `主执行器失败（${message}），回退到脚本化执行`, {
          repository,
          recordDurableStep,
          onTaskChanged,
        });
        await runBrain(requireServices().fallbackBrain);
      }

      await runtime.commit(
        () => ({ status: 'running', checkpoint: { ...task.state.checkpoint, phase: 'verify', attempt } }),
        context,
      );
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
      if (files.length === 0) {
        throw new Error('员工没有产出任何文件');
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
  const result = await runCommand(argv, {
    cwd: workspaceDir,
    timeoutMs: 25_000,
    env: { OPC_ENTRY: 'server.js', OPC_EXPECT: 'ok' },
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
