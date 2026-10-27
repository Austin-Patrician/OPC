import type {
  Agent,
  LinkType,
  Budget,
  BudgetError,
  CreateTaskInput,
  CreateTaskResult,
  SubtaskDraft,
  TaskError,
  WorkTask,
} from '@opc/shared/domain';
import type { Context } from '@earendil-works/chord/context';
import { createRegistry, defineExtension } from '@earendil-works/pi-durable';
import type { Conversation, Harness } from '@earendil-works/pi-durable';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BudgetRepository } from '../data/budgetRepository';
import { createSandboxExtension } from '../sandbox/extension';
import { createToolLimitExtension } from '../sandbox/toolLimit';
import type { CompanyDatabase } from '../data/companyDatabase';
import { TaskRepository, taskWorkspaceRelPath } from '../data/taskRepository';
import type { AppPaths } from '../env';
import type { ImageService } from '../models/imageService';
import type { OrgService } from '../org/orgService';
import type { MemoryService } from '../memory/memoryService';
import type { OrgFactService } from '../memory/orgFactService';
import type { ProjectService } from '../org/projectService';
import { validateDecomposition } from './decomposition';
import type { ModelConfigService } from '../models/modelConfigService';
import { BudgetBlockedError, BudgetService } from './budgetService';
import { scriptedBrain, type TaskBrain } from './brain';
import { DurableWorkRunner } from './durableWorkRunner';
import { HarnessBrain } from './harnessBrain';
import { createDecomposeToolExtension } from './decomposeTool';
import { createImageToolExtension } from './imageTool';
import { createRememberToolExtension } from '../memory/rememberTool';
import { createCommToolExtension } from '../comm/commTools';
import type { CommService } from '../comm/commService';
import { setWorkTaskServices, WorkTaskDefinition } from './workTaskDefinition';

/** How many manager rework rounds a task may take before it is parked for the boss. */
const MAX_REVIEW_ROUNDS = 2;

/** Which work task each employee is executing right now (for tools that need it). */
const runningTaskByEmployee = new Map<string, string>();

function currentTaskIdFor(employeeId: string): string | undefined {
  return runningTaskByEmployee.get(employeeId);
}

interface EmployeeHarness {
  harness: Harness;
  root: Conversation;
}

export interface WorkServiceDeps {
  db: CompanyDatabase;
  paths: AppPaths;
  agents: readonly Agent[];
  /** Injects / updates the task card in the conversation. */
  upsertTaskCard: (task: WorkTask) => void;
  modelConfig?: ModelConfigService;
  images?: ImageService;
  org?: OrgService;
  memory?: MemoryService;
  facts?: OrgFactService;
  projects?: ProjectService;
  /** Colleague messaging (F5); absent = employees cannot talk to each other. */
  comm?: CommService;
}

const REAPER_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Orchestrates work: business state in SQLite, execution in the employee's
 * durable pi task, and a live event stream for the UI.
 *
 * Crash safety is the point of this class: nothing runs as an un-tracked promise,
 * and startup reconciles whatever the previous process left behind.
 */
export class WorkService {
  private readonly repository: TaskRepository;
  private readonly budgets: BudgetService;
  private readonly runner: DurableWorkRunner;
  private readonly listeners = new Set<(task: WorkTask) => void>();
  private readonly budgetListeners = new Set<(budgets: Budget[]) => void>();
  private readonly harnesses = new Map<string, EmployeeHarness>();
  private reaperTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: WorkServiceDeps) {
    this.repository = new TaskRepository(deps.db);
    this.repository.seedEmployees(deps.agents);

    this.budgets = new BudgetService(new BudgetRepository(deps.db));
    for (const agent of deps.agents) this.budgets.ensureForEmployee(agent.id);

    // The real loop: HarnessBrain drives pi's generation/tool tasks. Without a
    // configured model we fall back to the deterministic brain so the app still works.
    const modelBrain = deps.modelConfig
      ? new HarnessBrain({
          harnessFor: (employeeId) => this.harnessFor(employeeId),
          context: () => getBackgroundContext(),
          model: () => deps.modelConfig?.getDefaults().llm ?? null,
          thinking: () => deps.modelConfig?.getThinking() ?? 'medium',
          price: (ref) => {
            const provider = deps.modelConfig?.listProviders().find((entry) => entry.id === ref.providerId);
            const model = provider?.models.find((entry) => entry.id === ref.modelId);
            return {
              inputUsdPerM: model?.inputUsdPerM ?? 0,
              outputUsdPerM: model?.outputUsdPerM ?? 0,
            };
          },
          onTokens: (taskId, tokens) => this.repository.addTokens(taskId, tokens),
        })
      : null;

    this.runner = new DurableWorkRunner({
      repository: this.repository,
      workspaceRoot: deps.paths.workspaceDir,
      checksRoot: path.join(deps.paths.userData, 'checks'),
      harnessFor: (employeeId) => this.harnessFor(employeeId),
      context: () => getBackgroundContext(),
      onTaskChanged: (taskId) => {
        const task = this.repository.getTask(taskId);
        if (task) this.emit(task);
      },
      onResumed: () => undefined,
      onFinished: (taskId, outcome, result) => {
        for (const [employeeId, running] of runningTaskByEmployee) {
          if (running === taskId) runningTaskByEmployee.delete(employeeId);
        }
        const task = this.repository.getTask(taskId);
        // A session that failed at the storage layer is closed for good; keeping it
        // cached would make every later run of this employee fail with "Harness is closed".
        if (outcome === 'faulted' && task) this.harnesses.delete(task.assigneeId);
        const passed = outcome === 'completed' && result?.verdict === 'pass';
        if (passed) {
          // §5.6: a hard stop pauses the assignment, not the employee. The charge is
          // what trips it, so the reaction belongs here, right after settling.
          const stopped = this.budgets.settle(taskId, task?.tokensUsed ?? 0, task?.costUsd ?? 0);
          for (const axis of stopped) this.applyHardStop(axis.scope, axis.scopeId, taskId);
        } else {
          this.budgets.release(taskId);
        }
        this.emitBudgetChange();

        if (passed && task && this.deps.memory) {
          void this.deps.memory
            .remember({
              employeeId: task.assigneeId,
              kind: 'experience',
              content: `任务《${task.title}》通过验收。交付物：${task.artifacts
                .map((artifact) => artifact.relPath)
                .join('、') || '（无）'}。要求：${task.deliverableSpec}`,
              scope: { type: 'personal' },
              sourceType: 'task',
              sourceId: task.id,
            })
            .catch(() => undefined);
        }

        if (passed && task?.isReview) this.applyManagerVerdict(taskId);
        else if (passed && task) this.openManagerReview(task);
        else if (!passed && task?.isReview && task.reviewOfTaskId) {
          // The reviewer never produced a verdict: surface it instead of leaving the
          // reviewed task stuck in `review` forever.
          this.repository.setStatus(task.reviewOfTaskId, 'rejected', {
            finishedAt: Date.now(),
            error: `负责人验收未完成（${result?.reason ?? outcome}）`,
          });
          const original = this.repository.getTask(task.reviewOfTaskId);
          if (original) this.emit(original);
        }
      },
    });

    setWorkTaskServices({
      recallMemories: this.deps.memory
        ? async (task) => {
            const member = this.deps.org
              ?.list()
              .flatMap((department) => department.members)
              .find((entry) => entry.id === task.assigneeId);
            const departmentId = member?.departmentId;
            const scopes = [
              { type: 'personal' as const },
              ...(departmentId ? [{ type: 'department' as const, id: departmentId }] : []),
              // Only the projects this employee is on — never every project.
              ...(this.deps.projects?.activeProjectIdsOf(task.assigneeId) ?? []).map((id) => ({
                type: 'project' as const,
                id,
              })),
            ];
            const snippets = await this.deps.memory!.retrieve({
              employeeId: task.assigneeId,
              query: `${task.title} ${task.brief}`,
              scopes,
              limit: 5,
            });
            return snippets.map((snippet) => ({
              kind: snippet.kind,
              content: snippet.content,
              scopeType: snippet.scopeType,
            }));
          }
        : undefined,
      recallFacts: this.deps.facts
        ? async (task) => {
            const member = this.deps.org
              ?.list()
              .flatMap((department) => department.members)
              .find((entry) => entry.id === task.assigneeId);
            const scopes = [
              { type: 'org' as const },
              ...(member?.departmentId ? [{ type: 'department' as const, id: member.departmentId }] : []),
              ...(this.deps.projects?.activeProjectIdsOf(task.assigneeId) ?? []).map((id) => ({
                type: 'project' as const,
                id,
              })),
            ];
            return this.deps.facts!.current(scopes).map((fact) => ({
              statement: fact.statement,
              scopeType: fact.scopeType,
            }));
          }
        : undefined,
      brain: (process.env.OPC_BRAIN_VARIANT ? scriptedBrain : (modelBrain ?? scriptedBrain)) as TaskBrain,
      fallbackBrain: scriptedBrain,
      repository: this.repository,
      recordDurableStep: (taskId, text) => this.recordDurableStep(taskId, text),
      onTaskChanged: (taskId) => {
        const task = this.repository.getTask(taskId);
        if (task) this.emit(task);
      },
    });
  }

  listTasks = (limit?: number): WorkTask[] => this.repository.listTasks(limit);

  /** Everything, newest first — the issue list needs the whole set, not a page. */
  listAllTasks = (limit = 500): WorkTask[] => this.repository.listTasks(limit);

  /** One-time backfill for rows created before issue keys existed. */
  backfillIssueKeys = (): number => this.repository.ensureIssueKeys();

  linkTasks = (fromId: string, toId: string, type: LinkType = 'blocks'): WorkTask => {
    this.repository.link(fromId, toId, type);
    return this.repository.getTask(toId) as WorkTask;
  };

  unlinkTasks = (fromId: string, toId: string, type: LinkType = 'blocks'): WorkTask => {
    this.repository.unlink(fromId, toId, type);
    return this.repository.getTask(toId) as WorkTask;
  };

  /** Edits the issue fields the boss owns (priority / labels / due date). */
  setIssueMeta = (
    taskId: string,
    patch: { priority?: WorkTask['priority']; labels?: string[]; dueAt?: number | null },
  ): WorkTask => {
    this.repository.setIssueMeta(taskId, patch);
    const updated = this.repository.getTask(taskId) as WorkTask;
    this.emit(updated);
    return updated;
  };

  getTask = (taskId: string): WorkTask | undefined => this.repository.getTask(taskId);

  listSubtasks = (taskId: string): WorkTask[] => this.repository.listChildren(taskId);

  listReviews = (taskId: string): WorkTask[] => this.repository.listReviews(taskId);

  /**
   * Third and last acceptance: the boss. Only a task the system and the manager
   * both passed can be signed off, so the boss is judging a finished deliverable.
   */
  bossDecision = (taskId: string, decision: 'approve' | 'reject', reason?: string): WorkTask => {
    const task = this.repository.getTask(taskId);
    if (!task) throw new Error('任务不存在');
    if (task.status !== 'accepted') throw new Error(`当前状态不能终审：${task.status}`);

    const approve = decision === 'approve';
    const note = reason?.trim() || (approve ? '老板确认交付' : '老板否决');
    this.repository.addAcceptance(
      taskId,
      {
        verdict: approve ? 'pass' : 'fail',
        reason: `老板终审：${note}`,
        evidence: { command: ['boss', decision], exitCode: approve ? 0 : 1, stdoutTail: note, stderrTail: '', durationMs: 0 },
      },
      'boss',
    );
    this.repository.setStatus(taskId, approve ? 'delivered' : 'rejected', {
      finishedAt: Date.now(),
      error: approve ? null : `老板否决：${note}`,
    });
    const updated = this.repository.getTask(taskId) as WorkTask;
    this.emit(updated);
    return updated;
  };

  listBudgets = (): Budget[] => this.budgets.list();

  /**
   * Manager decomposition. Children are ordinary tasks, so they run through the
   * same pi loop, acceptance and budget as anything the boss dispatches.
   */
  decompose = (
    parentTaskId: string,
    requesterId: string,
    subtasks: readonly SubtaskDraft[],
  ): { ok: true; created: WorkTask[] } | { ok: false; error: TaskError } => {
    const parent = this.repository.getTask(parentTaskId);
    if (!parent) return { ok: false, error: { code: 'DECOMPOSE_EMPTY', message: '未知父任务' } };
    if (parent.assigneeId !== requesterId) {
      return { ok: false, error: { code: 'DECOMPOSE_SELF', message: '只有负责人能拆解自己的任务' } };
    }

    const subordinates = this.deps.org?.subordinatesOf(requesterId) ?? [];
    const refusal = validateDecomposition({
      parent,
      requesterId,
      subtasks,
      subordinates,
      parentRemainingTokens: Math.max(0, parent.estTokens - parent.tokensUsed),
    });
    if (refusal) return { ok: false, error: refusal };

    const created: WorkTask[] = [];
    for (const subtask of subtasks) {
      const childId = `task-${crypto.randomUUID()}`;
      try {
        this.budgets.reserve({
          employeeId: subtask.assigneeId,
          taskId: childId,
          estTokens: subtask.estTokens,
          // A subtask spends the same project budget its parent does.
          ...(parent.projectGroupId ? { projectGroupId: parent.projectGroupId } : {}),
          ...(this.departmentOf(subtask.assigneeId)
            ? { departmentId: this.departmentOf(subtask.assigneeId) }
            : {}),
        });
      } catch (error) {
        if (error instanceof BudgetBlockedError) {
          return {
            ok: false,
            error: {
              code: error.code,
              message: `子任务「${subtask.title}」预算不足：${error.message}`,
              budget: error.budget,
            },
          };
        }
        throw error;
      }

      const child = this.repository.createTask(
        {
          title: subtask.title,
          brief: subtask.brief,
          deliverableSpec: subtask.deliverableSpec,
          assigneeId: subtask.assigneeId,
          estTokens: subtask.estTokens,
          acceptanceCommand: ['node', '{checks}/verify.mjs'],
          acceptanceTemplate: subtask.acceptanceTemplate ?? 'http-ok',
        },
        taskWorkspaceRelPath(childId),
        childId,
        { parentTaskId: parent.id, depth: parent.depth + 1 },
      );
      this.emit(child);
      created.push(child);
      // A decomposed subtask is dispatched just like boss work: it must progress
      // without another manual click.
      this.runTask(child.id);
    }

    this.repository.addStep(parent.id, `拆解为 ${created.length} 个子任务`);
    this.emit(this.repository.getTask(parent.id) as WorkTask);
    return { ok: true, created };
  };

  /**
   * Reservation happens before the row exists: refusing a task must cost nothing
   * and must not leave an orphan task the boss thinks is running.
   */
  /**
   * A configured-but-unusable default LLM used to make the harness wait on the
   * network until the task timed out ("stuck in 进行中" with no explanation).
   * Refuse up front with a message the boss can act on.
   */
  private assertModelUsable(): void {
    const config = this.deps.modelConfig;
    if (!config) return;
    const llm = config.getDefaults().llm;
    // 没配模型就不装成"员工在干活"：脚本化执行只留给探针（它们显式设 OPC_BRAIN_VARIANT）。
    // 真实公司里先把模型配好（设置 → 模型），否则任务直接失败并说明原因，而不是让一个
    // 写死 hello-world 的替身把任务"干完"。
    if (!llm && !process.env.OPC_BRAIN_VARIANT) {
      throw new Error(
        '未配置默认模型：到 设置 → 模型 选一个 LLM 后再执行（演练可设 OPC_BRAIN_VARIANT=ok）',
      );
    }
    if (!llm) return; // 探针模式：脚本化大脑离线可跑
    const provider = config.listProviders().find((entry) => entry.id === llm.providerId);
    if (!provider) throw new Error(`默认模型指向不存在的 provider：${llm.providerId}`);
    if (!provider.hasKey) {
      throw new Error(`默认模型 ${provider.name} / ${llm.modelId} 没有可用的 API Key，任务未启动`);
    }
  }

  createTask = (input: CreateTaskInput): CreateTaskResult => {
    const taskId = `task-${crypto.randomUUID()}`;
    const workspaceRelPath = taskWorkspaceRelPath(taskId);
    const draft = {
      ...input,
      acceptanceTemplate: input.acceptanceTemplate ?? 'http-ok',
      acceptanceCommand:
        input.acceptanceCommand.length > 0
          ? input.acceptanceCommand
          : ['node', '{checks}/verify.mjs'],
    };

    try {
      this.budgets.reserve({
        employeeId: input.assigneeId,
        taskId,
        estTokens: input.estTokens,
        ...(input.projectGroupId ? { projectGroupId: input.projectGroupId } : {}),
        ...(this.departmentOf(input.assigneeId)
          ? { departmentId: this.departmentOf(input.assigneeId) }
          : {}),
        allowOverdraft: (input as { allowOverdraft?: boolean }).allowOverdraft === true,
      });
    } catch (error) {
      if (error instanceof BudgetBlockedError) {
        return {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            budget: error.budget,
            requestedTokens: error.requestedTokens,
          } satisfies BudgetError,
        };
      }
      throw error;
    }

    let task: WorkTask;
    try {
      task = this.repository.createTask(draft, workspaceRelPath, taskId);
    } catch (error) {
      // The assignee may have been fired between the balance check and the insert:
      // give the reservation back and answer with a structured refusal.
      this.budgets.release(taskId);
      return {
        ok: false,
        error: {
          code: 'ASSIGNEE_UNAVAILABLE',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }

    this.emit(task);
    return { ok: true, task };
  };

  /**
   * Second-level acceptance: a system-passed deliverable goes to the assignee's
   * manager, who files `verdict.json`. Without a manager the task lands directly
   * on the boss. Review tasks themselves are never reviewed again (no recursion).
   */
  private openManagerReview = (task: WorkTask): void => {
    const org = this.deps.org;
    if (!org || task.isReview) return;
    // One sign-off per round, capped: a rework gets a fresh review, not a loop.
    if (this.repository.listReviews(task.id).length >= MAX_REVIEW_ROUNDS) return;

    const members = org.list().flatMap((department) => department.members);
    const assignee = members.find((member) => member.id === task.assigneeId);
    const managerId = assignee?.reportsToEmployeeId;
    if (!managerId || managerId === task.assigneeId) return;
    const manager = members.find((member) => member.id === managerId);
    if (!manager || manager.status !== 'active') return;

    const artifactList = task.artifacts.map((artifact) => artifact.relPath).join('、') || '（无）';
    const created = (() => {
      try {
        return this.createTask({
          title: `验收：${task.title}`,
          brief: [
            `你的下属 ${task.assigneeName} 交付了「${task.title}」。`,
            `任务要求：${task.deliverableSpec}`,
            `产物文件：${artifactList}`,
            '',
            '请判定这份交付是否达标。达标写 pass；不达标写 revise 并给出具体返工理由。',
          ].join('\n'),
          deliverableSpec: '在当前工作目录写 verdict.json：{"verdict":"pass"|"revise","reason":"说明"}',
          assigneeId: managerId,
          estTokens: Math.max(500, Math.round(task.estTokens / 3)),
          acceptanceCommand: ['node', '{checks}/verify.mjs'],
          acceptanceTemplate: 'review-verdict',
          allowOverdraft: true,
        });
      } catch {
        return null;
      }
    })();

    if (!created || !created.ok) {
      // The sign-off is a mandatory step: it may overdraw the budget, never skip.
      this.repository.addStep(task.id, '负责人验收任务创建失败，任务留在 review 供人工处理');
      return;
    }

    // Re-key the created task as the review of `task` (it was inserted as a plain task).
    this.repository.markAsReview(created.task.id, task.id);
    this.repository.setStatus(task.id, 'review');
    this.emit(this.repository.getTask(task.id) as WorkTask);
    this.runTask(created.task.id);
  };

  /** Applies the reviewer's verdict.json to the reviewed task. */
  private applyManagerVerdict = (reviewTaskId: string): void => {
    const review = this.repository.getTask(reviewTaskId);
    const originalId = review?.reviewOfTaskId;
    if (!review || !originalId) return;
    const original = this.repository.getTask(originalId);
    if (!original) return;

    let verdict: 'pass' | 'revise' = 'pass';
    let reason = '负责人验收通过';
    try {
      const raw = readFileSync(
        path.join(this.deps.paths.workspaceDir, review.workspaceRelPath, 'verdict.json'),
        'utf8',
      );
      const parsed = JSON.parse(raw) as { verdict?: string; reason?: string };
      if (parsed.verdict === 'revise') {
        verdict = 'revise';
        reason = parsed.reason?.trim() || '负责人要求返工';
      } else {
        reason = parsed.reason?.trim() || reason;
      }
    } catch {
      // A missing verdict.json is a broken review, not a pass: fail closed.
      verdict = 'revise';
      reason = '负责人没有提交 verdict.json';
    }

    this.repository.addAcceptance(
      originalId,
      {
        verdict: verdict === 'pass' ? 'pass' : 'fail',
        reason: `负责人验收：${reason}`,
        evidence: { command: ['reviewer', reviewTaskId], exitCode: verdict === 'pass' ? 0 : 1, stdoutTail: reason, stderrTail: '', durationMs: 0 },
      },
      'manager',
    );

    if (verdict === 'pass') {
      this.repository.setStatus(originalId, 'accepted', { finishedAt: Date.now(), error: null });
      this.emit(this.repository.getTask(originalId) as WorkTask);
      return;
    }

    // Revise: send the work back to the assignee with the reviewer's reason. Two
    // rounds max, so a reviewer that never relents cannot loop forever.
    const rounds = this.repository.listReviews(originalId).length;
    this.repository.addStep(originalId, `负责人要求返工（第 ${rounds} 轮）：${reason}`);
    if (rounds >= MAX_REVIEW_ROUNDS) {
      this.repository.setStatus(originalId, 'rejected', {
        finishedAt: Date.now(),
        error: `负责人要求返工（已 ${rounds} 轮）：${reason}`,
      });
      this.emit(this.repository.getTask(originalId) as WorkTask);
      return;
    }

    this.repository.setStatus(originalId, 'open', { finishedAt: null as never, error: null });
    this.emit(this.repository.getTask(originalId) as WorkTask);
    this.runTask(originalId);
  };

  /**
   * Reasons a task must not start: no usable model, or an unfinished blocker.
   * Both fail the task with a readable message instead of leaving it hanging —
   * "stuck in 进行中" is the worst state a ledger can show.
   */
  private refuseToStart(taskId: string): boolean {
    try {
      this.assertModelUsable();
      if (this.repository.isBlocked(taskId)) {
        const blockers = this.repository.getTask(taskId)?.blockedBy ?? [];
        throw new Error(
          `还有未完成的前置任务：${blockers.map((link) => link.issueKey ?? link.title).join('、')}`,
        );
      }
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.repository.addStep(taskId, message);
      this.repository.setStatus(taskId, 'failed', { finishedAt: Date.now(), error: message });
      this.budgets.release(taskId);
      this.emitBudgetChange();
      const failed = this.repository.getTask(taskId);
      if (failed) this.emit(failed);
      return true;
    }
  }

  /**
   * 同一个任务只能有一个 run 在跑。
   *
   * 这不是优化而是正确性：pi 的 Session 是单写者，同一员工的两个 run 并发写同一个
   * sqlite 会直接 `Session failed after a storage error`，并把这个员工的 harness 毒化。
   * 触发路径很常见：负责人验收任务由 `openManagerReview` 自己启动，UI/探针再点一次。
   */
  private isRunning(taskId: string): boolean {
    for (const running of runningTaskByEmployee.values()) {
      if (running === taskId) return true;
    }
    return this.repository.getTask(taskId)?.status === 'running';
  }

  /** Fire-and-forget: the UI follows `subscribe()`. */
  runTask = (taskId: string): void => {
    if (this.isRunning(taskId)) return;
    if (this.refuseToStart(taskId)) return;
    const task = this.repository.getTask(taskId);
    if (task) runningTaskByEmployee.set(task.assigneeId, taskId);
    void this.runner.run(taskId).catch((error) => {
      this.repository.addStep(taskId, `启动失败：${error instanceof Error ? error.message : String(error)}`);
      this.repository.setStatus(taskId, 'failed', { finishedAt: Date.now(), error: String(error) });
      this.budgets.release(taskId);
      this.emitBudgetChange();
      console.error('task run failed', error);
    });
  };

  runTaskAndWait = async (taskId: string): Promise<WorkTask> => {
    if (this.isRunning(taskId)) return this.repository.getTask(taskId) as WorkTask;
    if (this.refuseToStart(taskId)) return this.repository.getTask(taskId) as WorkTask;
    const task = this.repository.getTask(taskId);
    if (task) runningTaskByEmployee.set(task.assigneeId, taskId);
    return this.runner.run(taskId).finally(() => {
      if (task) runningTaskByEmployee.delete(task.assigneeId);
    });
  };

  subscribe = (listener: (task: WorkTask) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribeBudgets = (listener: (budgets: Budget[]) => void): (() => void) => {
    this.budgetListeners.add(listener);
    return () => this.budgetListeners.delete(listener);
  };

  /** Startup: resume interrupted durable tasks, then free anything orphaned. */
  recover = async (): Promise<void> => {
    try {
      await this.runner.resumeInterrupted();
    } catch (error) {
      console.error('resume failed', error);
    }
    this.sweepStaleRunning();
    this.reapReservations();

    this.reaperTimer = setInterval(() => this.reapReservations(), REAPER_INTERVAL_MS);
    this.reaperTimer.unref?.();
  };

  /**
   * Second line of defence: a row still marked `running` that nothing is working on
   * (no durable task, or no activity for 10 minutes) is failed, so its reservation
   * can be reclaimed. Covers builds from before durable execution existed.
   */
  sweepStaleRunning = (): number => {
    const cutoff = Date.now() - 10 * 60_000;
    let swept = 0;

    for (const task of this.repository.listRunning()) {
      if (task.updatedAt && task.updatedAt > cutoff) continue;
      const durableId = this.repository.getDurableTaskId(task.id);
      this.repository.addStep(task.id, '启动对账：任务长时间无进展，标记失败并释放预算');
      this.repository.setStatus(task.id, 'failed', {
        finishedAt: Date.now(),
        error: durableId ? '恢复超时' : '缺少 durable 记录',
      });
      this.budgets.release(task.id);
      this.emitBudgetChange();
      swept += 1;
    }

    return swept;
  };

  /**
   * Reservations belong to a live task. Anything else (terminal, missing, or past
   * its expiry) is released, so a crash can never permanently consume quota.
   */
  reapReservations = (): number => {
    const released = this.budgets.releaseOrphans((taskId) => {
      const task = this.repository.getTask(taskId);
      return task?.status === 'running' || task?.status === 'open';
    });
    if (released > 0) this.emitBudgetChange();
    return released;
  };

  dispose = async (): Promise<void> => {
    if (this.reaperTimer) clearInterval(this.reaperTimer);
    this.reaperTimer = null;
    this.listeners.clear();
    const context = await getBackgroundContext();
    for (const entry of this.harnesses.values()) {
      await entry.harness.close(context).catch(() => undefined);
    }
    this.harnesses.clear();
  };

  // ── internals ──────────────────────────────────────────────────────────

  /**
   * F8: 预算硬停的落地动作（§5.6）。
   *
   * 项目预算超了 → 暂停该项目所有任职（员工在别的项目照常干活）；
   * 员工预算超了 → 只暂停他自己的任职；
   * 公司预算超了 → 不自动全停（那要老板决定），但会留下告警让 /budget 亮红灯。
   */
  private applyHardStop(
    scope: 'company' | 'employee' | 'project' | 'department',
    scopeId: string,
    taskId: string,
  ): void {
    const projects = this.deps.projects;
    if (!projects) return;

    const reason =
      scope === 'project'
        ? 'project_budget_exceeded'
        : scope === 'department'
          ? 'department_budget_exceeded'
          : 'employee_budget_exceeded';

    const paused =
      scope === 'project'
        ? projects.pauseAssignments({ projectId: scopeId }, reason)
        : scope === 'employee'
          ? projects.pauseAssignments({ employeeId: scopeId }, reason)
          : 0;

    if (paused > 0) {
      this.repository.addStep(
        taskId,
        `预算硬停（${scope}）→ 暂停 ${paused} 条任职，等老板在预算中心调整额度`,
      );
      this.emitBudgetChange();
    }
  }

  /** The assignee's department, for the department budget axis (§8.1). */
  private departmentOf(employeeId: string): string | undefined {
    const members = this.deps.org?.everyone() ?? [];
    const departmentId = members.find((member) => member.id === employeeId)?.departmentId;
    return departmentId || undefined;
  }

  /** Who this employee reports to inside the department (empty when it is the head). */  private reportingLineOf(employeeId: string): string | undefined {
    const members = this.deps.org?.list().flatMap((department) => department.members) ?? [];
    return members.find((member) => member.id === employeeId)?.reportsToEmployeeId;
  }

  private emit(task: WorkTask): void {
    this.deps.upsertTaskCard(task);
    this.listeners.forEach((listener) => listener(task));
  }

  private emitBudgetChange(): void {
    const budgets = this.budgets.list();
    this.budgetListeners.forEach((listener) => listener(budgets));
  }

  private async recordDurableStep(taskId: string, text: string): Promise<void> {
    try {
      const task = this.repository.getTask(taskId);
      if (!task) return;
      const entry = await this.harnessFor(task.assigneeId);
      await entry.root.submit(
        {
          type: 'write',
          entry: { kind: 'work.step', data: { taskId, text, at: Date.now() } },
        },
        await getBackgroundContext(),
      );
    } catch (error) {
      // The transcript is an audit trail, not the source of truth.
      console.warn('durable step not recorded', error);
    }
  }

  private async harnessFor(employeeId: string): Promise<EmployeeHarness> {
    const cached = this.harnesses.get(employeeId);
    if (cached) return cached;

    const { Harness } = await import('@earendil-works/pi-durable');
    const { openNodeSqliteStorage } = await import('@earendil-works/pi-durable/storage/sqlite/node');
    const { createCodingTools } = await import('@earendil-works/pi-durable/tools');
    const { NodeExecutionEnv } = await import('@earendil-works/pi-durable/env/node');

    const context = await getBackgroundContext();
    const storagePath = path.join(this.deps.paths.agentsDir, `${employeeId}.sqlite`);

    // The registry carries our durable task definition and pi's coding tools:
    // without the former a resumed task is "blocked: missing_task"; without the
    // latter the model has nothing to act with.
    const registry = createRegistry();
    registry.install(defineExtension({ name: 'opc.work', tasks: [WorkTaskDefinition] }));
    registry.install(createCodingTools());
    // Installed after the tools so it sees every call; `beforeTool` is the single
    // choke point for path policy and command wrapping.
    registry.install(createSandboxExtension());
    registry.install(createToolLimitExtension());

    // The agent can draw, but only when a usable image provider exists.
    if (this.deps.images?.isAvailable()) {
      registry.install(createImageToolExtension({ generate: this.deps.images.generateBytes }));
    }

    // Every employee can keep a lesson for its future self.
    if (this.deps.memory) {
      const memory = this.deps.memory;
      const member = this.deps.org
        ?.list()
        .flatMap((department) => department.members)
        .find((entry) => entry.id === employeeId);
      registry.install(
        createRememberToolExtension({
          employeeId,
          taskId: () => currentTaskIdFor(employeeId),
          remember: async ({ content, kind }) =>
            memory.remember({
              employeeId,
              kind,
              content,
              scope: { type: 'personal' },
              sourceType: 'task',
              sourceId: currentTaskIdFor(employeeId),
            }),
        }),
      );
      void member;
    }

    // Everyone can talk to a colleague (F5); the tool spends the *other* person's
    // wake quota, which is what stops a chatty agent from waking the whole company.
    if (this.deps.comm) {
      const comm = this.deps.comm;
      registry.install(
        createCommToolExtension({
          employeeId,
          colleagues: () =>
            (this.deps.org?.list().flatMap((department) => department.members) ?? [])
              .filter((member) => member.id !== employeeId && member.status === 'active')
              .map((member) => ({
                id: member.id,
                name: member.name,
                role: `${member.role} · ${member.level}`,
                reportsToMe: member.reportsToEmployeeId === employeeId,
                manager: member.id === this.reportingLineOf(employeeId),
              })),
          sendDirectMessage: (input) => comm.sendDirectMessage(input),
          ackConversation: (ownerId, conversationId) => comm.ack(ownerId, conversationId),
          currentConversationId: () => comm.latestConversationId(employeeId),
        }),
      );
    }

    // Managers can decompose; individual contributors cannot (the org chart decides).
    const subordinates = this.deps.org?.subordinatesOf(employeeId) ?? [];
    if (subordinates.length > 0) {
      registry.install(
        createDecomposeToolExtension({
          requesterId: employeeId,
          parentTaskId: () => currentTaskIdFor(employeeId),
          decompose: (parentId, requesterId, subtasks) =>
            this.decompose(parentId, requesterId, subtasks),
        }),
      );
    }

    const models = this.deps.modelConfig
      ? await this.deps.modelConfig.runtime.createModels()
      : (await import('@earendil-works/pi-ai/models')).createModels();

    const harness = await Harness.open(
      await openNodeSqliteStorage(storagePath),
      {
        models,
        registry,
        // Compaction thresholds come from Settings → 工作区与压缩, so they follow
        // the selected model's context window instead of a hard-coded number.
        settings: this.deps.modelConfig
          ? {
              compaction: {
                enabled: this.deps.modelConfig.getCompaction().enabled,
                reserveTokens: this.deps.modelConfig.getCompaction().reserveTokens,
                keepRecentTokens: this.deps.modelConfig.getCompaction().keepRecentTokens,
                backgroundTokens: this.deps.modelConfig.getCompaction().backgroundTokens,
              },
            }
          : undefined,
        // Every tool call runs with the conversation's cwd as the workspace root.
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? this.deps.paths.workspaceDir }),
      },
      context,
    );
    const root = await harness.root(context);
    const entry = { harness, root };
    this.harnesses.set(employeeId, entry);
    return entry;
  }
}

/** Loaded once: pi-durable is ESM-only, the main bundle is CJS. */
let contextPromise: Promise<Context> | null = null;

function getBackgroundContext(): Promise<Context> {
  contextPromise ??= import('@earendil-works/chord/context').then((module) => module.BACKGROUND_CONTEXT);
  return contextPromise;
}
