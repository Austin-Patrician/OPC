import type {
  TaskStatus,
  EmployeeToolPolicy,
  LinkType,
  CreateTaskInput,
  CreateTaskResult,
  SubtaskDraft,
  TaskError,
  WorkTask,
  WorkThread,
} from '@opc/shared/domain';
import type {
  AgentCapability,
  CapabilityCatalog,
  WorkerStackInput,
  WorkerStackView,
} from '@opc/shared/ipc';
import type { Context } from '@earendil-works/chord/context';
import { createRegistry, defineExtension } from '@earendil-works/pi-durable';
import type { Conversation, Extension, Harness, Registry } from '@earendil-works/pi-durable';
import crypto from 'node:crypto';
import path from 'node:path';
import { createSandboxExtension } from '../sandbox/extension';
import { createToolLimitExtension } from '../sandbox/toolLimit';
import type { CompanyDatabase } from '../data/companyDatabase';
import { BOSS_USER_ID } from '../data/schema';
import { TaskRepository, taskWorkspaceRelPath, type CreateTaskDraft } from '../data/taskRepository';
import { ThreadRepository } from '../data/threadRepository';
import type { AppPaths } from '../env';
import type { DecisionService } from '../models/decisionService';
import type { ImageService } from '../models/imageService';
import type { SpeechService } from '../models/speechService';
import type { OrgService } from '../org/orgService';
import type { MemoryService } from '../memory/memoryService';
import type { OrgFactService } from '../memory/orgFactService';
import { validateDecomposition } from './decomposition';
import type { ModelConfigService } from '../models/modelConfigService';
import { scriptedBrain, type TaskBrain } from './brain';
import { DurableWorkRunner } from './durableWorkRunner';
import { HarnessBrain } from './harnessBrain';
import { runtimeIdentityFor, type RuntimeIdentity } from './runtimeIdentity';
import { threadOutcomeFor } from './threadOutcome';
import { subjectOfPerson, subjectOfWorker, type RegistrySubject } from './registrySubject';
import { createDecomposeToolExtension } from './decomposeTool';
import { createDecisionToolExtension } from './decisionTool';
import { createImageToolExtension } from './imageTool';
import { createOcrToolExtension } from './ocrTool';
import { createSpeechToolExtension } from './speechTool';
import { createRememberToolExtension } from '../memory/rememberTool';
import { setWorkTaskServices, WorkTaskDefinition } from './workTaskDefinition';
import {
  EMPTY_TOOL_POLICY,
  filterExtensionTools,
  isExtensionEnabled,
  isToolActive,
  isToolEnabled,
  normalizeToolPolicy,
} from './toolPolicy';
import { resolveEmployeeModelRef } from '../models/employeeModel';
import { resolveWorkerModelRef } from '../models/workerModel';
import type { NetworkClient } from '../network/networkClient';
import type { OcrEngine } from '../ocr/service';
import { RuntimeService } from '../runtime/service';
import type { PiExtensionHost } from '../extensions/host';
import type { PiSkillHost } from '../skills/host';
import { createSkillsExtension } from '../skills/extension';

/** How many manager rework rounds a task may take before it is parked for the boss. */

/** Which work task each employee is executing right now (for tools that need it). */
const runningTaskByEmployee = new Map<string, string>();

function currentTaskIdFor(employeeId: string): string | undefined {
  return runningTaskByEmployee.get(employeeId);
}

interface EmployeeHarness {
  harness: Harness;
  root: Conversation;
  /** Several runtimes can belong to one person once workers exist. */
  employeeId: string;
}


/**
 * One installable capability group.
 *
 * `extension` is present only when the runtime can actually support it. A slot
 * with `available: false` is what the stack page renders greyed out with a
 * reason code, so "why can't this employee draw?" has one answer for both the UI
 * and the registry.
 */
interface ToolSlot {
  name: string;
  /** Core groups cannot be switched off wholesale (their tools still can). */
  essential: boolean;
  available: boolean;
  reason?: string;
  extension?: Extension;
}

export interface WorkServiceDeps {
  db: CompanyDatabase;
  paths: AppPaths;
  /** Injects / updates the task card in the conversation. */
  upsertTaskCard: (task: WorkTask) => void;
  modelConfig?: ModelConfigService;
  images?: ImageService;
  /** Speech recognition / synthesis; each tool is installed only when usable. */
  speech?: SpeechService;
  /** Structured decisions (Jev / System One); absent = no `decide` tool. */
  decisions?: DecisionService;
  org?: OrgService;
  memory?: MemoryService;
  facts?: OrgFactService;
  /** Colleague messaging (F5); absent = employees cannot talk to each other. */
  /** Proxy policy for spawned commands (acceptance scripts, git/npm). */
  network?: NetworkClient;
  /** Company-wide base environment; absent = build one from `paths` + `network`. */
  runtime?: RuntimeService;
  /** Image → text (OCR) for employees whose model has no vision. */
  ocr?: OcrEngine;
  /**
   * Pi coding-agent extensions found on disk. Absent in probes and tests, which
   * is why every use below is optional.
   */
  piExtensions?: PiExtensionHost;
  /** `SKILL.md` folders found on disk; same optionality as above. */
  piSkills?: PiSkillHost;
}

/**
 * Orchestrates work: business state in SQLite, execution in the employee's
 * durable pi task, and a live event stream for the UI.
 *
 * Crash safety is the point of this class: nothing runs as an un-tracked promise,
 * and startup reconciles whatever the previous process left behind.
 */
export class WorkService {
  private readonly repository: TaskRepository;
  private readonly runner: DurableWorkRunner;
  private readonly listeners = new Set<(task: WorkTask) => void>();
  private readonly harnesses = new Map<string, EmployeeHarness>();
  /** Employees whose stack changed while a task was running; evicted when it ends. */
  private readonly dirtyHarnesses = new Set<string>();
  /** Last status each task reported to its thread, so one outcome is not announced twice. */
  private readonly reportedThreads = new Map<string, TaskStatus>();
  /** Threads already warned about their ceiling; the warning is not a metronome. */
  private readonly warnedThreads = new Set<string>();
  private readonly runtime: RuntimeService;
  /** Owned here rather than injected: nine construction sites, one dependency. */
  private readonly threads: ThreadRepository;

  constructor(private readonly deps: WorkServiceDeps) {
    this.repository = new TaskRepository(deps.db);
    this.threads = new ThreadRepository(deps.db);

    // One environment for the whole company: every tool call and acceptance
    // command resolves `node` / `python` through this service.
    this.runtime =
      deps.runtime ??
      new RuntimeService(deps.db, {
        userDataDir: deps.paths.userData,
        ...(deps.network ? { network: deps.network } : {}),
      });


    // The real loop: HarnessBrain drives pi's generation/tool tasks. Without a
    // configured model we fall back to the deterministic brain so the app still works.
    const modelBrain = deps.modelConfig
      ? new HarnessBrain({
          harnessFor: (identity) => this.harnessFor(identity),
          context: () => getBackgroundContext(),
          model: (identity) =>
            resolveWorkerModelRef({
              worker: this.threads.getWorker(identity.runtimeKey),
              modelConfig: deps.modelConfig,
            }),
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
      harnessFor: (identity) => this.harnessFor(identity),
      context: () => getBackgroundContext(),
      onTaskChanged: (taskId) => {
        const task = this.repository.getTask(taskId);
        if (task) this.emit(task);
      },
      onResumed: () => undefined,
      onFinished: (taskId, outcome, result) => {
        const finishedEmployees: string[] = [];
        for (const [employeeId, running] of runningTaskByEmployee) {
          if (running === taskId) {
            runningTaskByEmployee.delete(employeeId);
            finishedEmployees.push(employeeId);
          }
        }
        // A stack change made while this task was running is applied now: the next
        // task must open a harness with the new registry, not keep the old one.
        for (const employeeId of finishedEmployees) {
          if (this.dirtyHarnesses.delete(employeeId)) void this.evictRuntime(employeeId);
        }
        const task = this.repository.getTask(taskId);
        // A session that failed at the storage layer is closed for good; keeping it
        // cached would make every later run of this employee fail with "Harness is closed".
        if (outcome === 'faulted' && task) {
          this.harnesses.delete(runtimeIdentityFor(task).runtimeKey);
        }
        const passed = outcome === 'completed' && result?.verdict === 'pass';

        if (passed && task && this.deps.memory) {
          void this.deps.memory
            .remember({
              employeeId: task.assigneeId,
              kind: 'experience',
              content: `任务《${task.title}》通过验收。交付物：${task.artifacts
                .map((artifact) => artifact.relPath)
                .join('、') || '（无）'}。要求：${task.deliverableSpec}`,
              scope: task.threadId
                ? { type: 'thread', id: task.threadId }
                : { type: 'personal' },
              sourceType: 'task',
              sourceId: task.id,
            })
            .catch(() => undefined);
        }

        if (!passed && task?.isReview && task.reviewOfTaskId) {
          // The reviewer never produced a verdict: surface it instead of leaving the
          // reviewed task stuck in `review` forever.
          this.repository.setStatus(task.reviewOfTaskId, 'rejected', {
            finishedAt: Date.now(),
            error: `负责人验收未完成（${result?.reason ?? outcome}）`,
          });
          const original = this.repository.getTask(task.reviewOfTaskId);
          if (original) this.emit(original);
        }

        // Last thing, so the status the thread hears about is the settled one.
        this.reportToThread(taskId);
        if (task?.reviewOfTaskId) this.reportToThread(task.reviewOfTaskId);
      },
    });

    setWorkTaskServices({
      recallMemories: this.deps.memory
        ? async (task) => {
            // 两个作用域就够了：这条线自己的经验，和这个执行体自己的习惯。
            // 「部门」那一层随着组织一起没了。
            const scopes = [
              ...(task.threadId ? [{ type: 'thread' as const, id: task.threadId }] : []),
              { type: 'personal' as const },
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
            // 规定挂在**这条线**上，全局那一层还在（它讲的是这个工作台本身）。
            const scopes = [
              { type: 'org' as const },
              ...(task.threadId ? [{ type: 'thread' as const, id: task.threadId }] : []),
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
      network: this.deps.network,
      runtime: this.runtime,
    });
  }

  listTasks = (limit?: number): WorkTask[] => this.repository.listTasks(limit);

  /** 未结束的活：Watchdog 每分钟体检一次的对象。 */
  listPending = (): WorkTask[] => this.repository.listPending();

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
        evidence: { command: [BOSS_USER_ID, decision], exitCode: approve ? 0 : 1, stdoutTail: note, stderrTail: '', durationMs: 0 },
      },
      BOSS_USER_ID,
    );
    this.repository.setStatus(taskId, approve ? 'delivered' : 'rejected', {
      finishedAt: Date.now(),
      error: approve ? null : `老板否决：${note}`,
    });
    const updated = this.repository.getTask(taskId) as WorkTask;
    this.emit(updated);
    // The boss just settled it: the line of work hears the final answer, not the
    // interim "awaiting sign-off" one.
    this.reportedThreads.delete(taskId);
    this.reportToThread(taskId);
    return updated;
  };

  /**
   * 老板在注意力队列上的两个动作（steering 层）。
   *
   * `approve` —— 认可。这活只有人能判，所以认可就是终审：任务记成老板通过，
   * 工作线关掉。`rework` —— 不满意，带着意见再做一次：**新建一个任务**而不是
   * 重开旧的，因为旧任务的预算已结算、验收记录已定案，重开会让账本和验收历史
   * 互相矛盾。
   */
  decideThread = (
    threadId: string,
    decision: 'approve' | 'rework',
    note?: string,
  ): { ok: true; thread: WorkThread } | { ok: false; error: string } => {
    const latest = this.repository.latestForThread(threadId);
    const text = note?.trim() || '';

    if (decision === 'approve') {
      // `bossDecision` only accepts a task awaiting judgement; a thread whose task
      // is already delivered just needs closing.
      if (latest?.status === 'accepted') {
        this.bossDecision(latest.id, 'approve', text || undefined);
      } else {
        this.threads.setState(threadId, 'done');
      }
      const thread = this.threads.getThread(threadId);
      if (!thread) return { ok: false, error: `未知工作线：${threadId}` };
      return { ok: true, thread };
    }

    if (!latest) return { ok: false, error: '这条工作线上还没有任务，无法返工' };
    const created = this.createTask({
      title: latest.title,
      brief: text ? `${latest.brief}\n\n老板的意见：${text}` : `${latest.brief}\n\n老板要求重做`,
      deliverableSpec: latest.deliverableSpec,
      assigneeId: latest.assigneeId,
      estTokens: latest.estTokens,
      acceptanceCommand: latest.acceptanceCommand,
      acceptanceTemplate: latest.acceptanceTemplate,
      threadId,
    });
    if (!created.ok) return { ok: false, error: created.error.message };

    this.threads.setState(threadId, 'running');
    this.runTask(created.task.id);
    const thread = this.threads.getThread(threadId);
    if (!thread) return { ok: false, error: `未知工作线：${threadId}` };
    return { ok: true, thread };
  };

  /**
   * Manager decomposition. Children are ordinary tasks, so they run through the
   * same pi loop and acceptance as anything the boss dispatches.
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

    const assignable = this.assignableTo(requesterId);
    const refusal = validateDecomposition({
      parent,
      requesterId,
      subtasks,
      assignable,
      parentRemainingTokens: Math.max(0, parent.estTokens - parent.tokensUsed),
    });
    if (refusal) return { ok: false, error: refusal };

    const created: WorkTask[] = [];
    for (const subtask of subtasks) {
      const childId = `task-${crypto.randomUUID()}`;

      const childWorker = parent.threadId
        ? this.ensureWorker(parent.threadId, subtask.assigneeId)
        : null;
      const child = this.repository.createTask(
        {
          title: subtask.title,
          brief: subtask.brief,
          deliverableSpec: subtask.deliverableSpec,
          assigneeId: subtask.assigneeId,
          estTokens: subtask.estTokens,
          acceptanceCommand: ['node', '{checks}/verify.mjs'],
          acceptanceTemplate: subtask.acceptanceTemplate ?? 'http-ok',
          // Same line of work as the parent: a goal decomposed into five tasks is
          // still one thing to the boss, and must be recallable as one thread.
          ...(parent.threadId ? { threadId: parent.threadId } : {}),
          ...(childWorker ? { workerId: childWorker.id } : {}),
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
    const draft: CreateTaskDraft = {
      ...input,
      acceptanceTemplate: input.acceptanceTemplate ?? 'http-ok',
      acceptanceCommand:
        input.acceptanceCommand.length > 0
          ? input.acceptanceCommand
          : ['node', '{checks}/verify.mjs'],
    };

    // Every task belongs to a line of work, so a finished task always has somewhere
    // to report to. Today that is one thread per task; a goal that decomposes into
    // several tasks keeps them together because children inherit the parent's id.
    const threadId =
      draft.threadId ??
      this.threads.createThread({ title: draft.title, goal: draft.brief }).id;
    draft.threadId = threadId;
    // The dispatcher may already have chosen an execution body (workerPool); it
    // wins over the default "one worker per person per thread". A worker from a
    // different line of work is ignored rather than trusted.
    const chosen = draft.workerId ? this.threads.getWorker(draft.workerId) : null;
    draft.workerId =
      chosen && chosen.threadId === threadId
        ? chosen.id
        : this.ensureWorker(threadId, draft.assigneeId).id;

    let task: WorkTask;
    try {
      task = this.repository.createTask(draft, workspaceRelPath, taskId);
    } catch (error) {
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

  /*
   * 这里原本是「二级验收」：系统验收过了，再交给这个人的经理看一遍 verdict.json。
   *
   * v2 里没有经理，这条链也就没有了。三层验收的边界写死在 docs/v2/01-core.md §9：
   * ① Watchdog 判"还在不在往前走" ② 可执行闸门（退出码）③ 人的确认。
   * 闸门过了就关单；闸门不存在或没过，就进注意力队列等人——中间不需要一个同事。
   */

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

  /**
   * Startup: resume interrupted durable tasks, then fail anything that is stuck.
   *
   * 预算删掉之后这里不再有"回收预留"这一步：没有预留，就没有需要回收的东西。
   */
  recover = async (): Promise<void> => {
    try {
      await this.runner.resumeInterrupted();
    } catch (error) {
      console.error('resume failed', error);
    }
    this.sweepStaleRunning();
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
      this.repository.addStep(task.id, '启动对账：任务长时间无进展，标记失败');
      this.repository.setStatus(task.id, 'failed', {
        finishedAt: Date.now(),
        error: durableId ? '恢复超时' : '缺少 durable 记录',
      });
      swept += 1;
    }

    return swept;
  };

  dispose = async (): Promise<void> => {
    this.listeners.clear();
    const context = await getBackgroundContext();
    for (const entry of this.harnesses.values()) {
      await entry.harness.close(context).catch(() => undefined);
    }
    this.harnesses.clear();
  };

  /**
   * The capability catalogue shown on the 「技能与工具」 page.
   *
   * Every row is read from the same `buildRegistry()` the worker installs, so a
   * tool that runtime conditions exclude (no image provider, no speech model, no
   * subordinates) cannot appear here. `skills` rides along as metadata: it is an
   * archive tag and is never injected into the prompt.
   */
  capabilities = async (): Promise<CapabilityCatalog> => {
    const departmentOf = new Map<string, { id: string; name: string }>();
    for (const department of this.deps.org?.list() ?? []) {
      for (const member of department.members) {
        departmentOf.set(member.id, { id: department.id, name: department.name });
      }
    }

    const employees = (this.deps.org?.everyone() ?? []).filter(
      (employee) => employee.status === 'active',
    );

    const agents: AgentCapability[] = [];
    for (const employee of employees) {
      const snapshot = (await this.buildRegistry(this.subjectOfEmployee(employee.id))).snapshot();
      const department = departmentOf.get(employee.id);
      agents.push({
        employeeId: employee.id,
        name: employee.name,
        role: employee.role,
        level: employee.level,
        model: employee.model,
        avatar: employee.avatar,
        departmentId: department?.id ?? employee.departmentId,
        departmentName: department?.name ?? '',
        isHead: employee.isHead,
        skills: employee.skills,
        extensions: snapshot.installed().map((extension) => ({
          name: extension.name,
          tools: (extension.tools ?? []).map((tool) => tool.name),
          hooks: extension.hooks?.length ?? 0,
          tasks: extension.tasks?.length ?? 0,
          sections: extension.sections?.length ?? 0,
        })),
        tools: snapshot.tools().map(({ extension, tool }) => ({
          name: tool.name,
          description: tool.description,
          extension: extension.name,
          deferred: tool.deferred === true,
        })),
      });
    }

    agents.sort((left, right) => left.name.localeCompare(right.name));
    return { generatedAt: Date.now(), agents };
  };

  // ── internals ──────────────────────────────────────────────────────────

  /**
   * Every capability group this employee could be given, with availability.
   *
   * This is the one catalogue: `buildRegistry` installs from it and the stack
   * page renders it. Reasons are codes, not sentences, so both locales can
   * explain the same missing provider without the main process translating.
   */
  private async toolSlots(subject: RegistrySubject): Promise<ToolSlot[]> {
    const personId = subject.employeeId ?? subject.id;
    // §2.2：工具集是执行体自己的属性。`employee` 那一路只是迁移期兜底。
    const policy = subject.policy ?? EMPTY_TOOL_POLICY;

    const { createCodingTools } = await import('@earendil-works/pi-durable/tools');
    const slots: ToolSlot[] = [
      {
        name: 'coding-tools',
        essential: true,
        available: true,
        extension: createCodingTools(),
      },
    ];

    // The agent can draw, but only when a usable image provider exists.
    const images = this.deps.images;
    slots.push(
      images?.isAvailable()
        ? {
            name: 'opc.image',
            essential: false,
            available: true,
            extension: createImageToolExtension({ generate: images.generateBytes }),
          }
        : { name: 'opc.image', essential: false, available: false, reason: 'no-image-provider' },
    );

    // Speech: each half is installed only when a model is enabled, so the model
    // never sees a tool that can only fail.
    const speech = this.deps.speech;
    const transcribe = speech?.isAsrAvailable() ? speech.transcribe : undefined;
    const synthesize = speech?.isTtsAvailable() ? speech.synthesize : undefined;
    if (transcribe || synthesize) {
      slots.push({
        name: 'opc.speech',
        essential: false,
        available: true,
        extension: createSpeechToolExtension({
          transcribe,
          synthesize,
          defaultRoot: this.deps.paths.workspaceDir,
        }),
      });
    } else {
      slots.push({ name: 'opc.speech', essential: false, available: false, reason: 'no-speech-model' });
    }

    // Structured decisions replace a chat model with a bounded classifier. Like
    // speech, the tool exists only when a decision model is enabled and keyed, so
    // the agent never sees a tool whose first call can only fail.
    const decisions = this.deps.decisions;
    if (decisions?.isAvailable()) {
      slots.push({
        name: 'opc.decision',
        essential: false,
        available: true,
        extension: createDecisionToolExtension({ classify: decisions.classify }),
      });
    } else {
      slots.push({
        name: 'opc.decision',
        essential: false,
        available: false,
        reason: 'no-decision-model',
      });
    }

    // Text out of pictures for models without vision. Two independent gates: the
    // boss's switch (设置 → 运行时) and the models actually being on disk. An
    // installed tool that can only fail is worse than an absent one.
    const ocr = this.deps.ocr;
    if (ocr && (ocr.settings?.().enabled ?? true) && (ocr.assetsReady?.() ?? true)) {
      slots.push({
        name: 'opc.ocr',
        essential: false,
        available: true,
        extension: createOcrToolExtension({ ocr, defaultRoot: this.deps.paths.workspaceDir }),
      });
    } else {
      const reason =
        ocr && (ocr.settings?.().enabled ?? true) ? 'ocr-models-missing' : 'ocr-disabled';
      slots.push({ name: 'opc.ocr', essential: false, available: false, reason });
    }

    // Every employee can keep a lesson for its future self.
    const memory = this.deps.memory;
    if (memory) {
      slots.push({
        name: 'opc.memory',
        essential: false,
        available: true,
        extension: createRememberToolExtension({
          employeeId: personId,
          taskId: () => currentTaskIdFor(personId),
          remember: async ({ content, kind }) => {
            // 记在**当前这条工作线**上：同一条线索的下一个执行体能读到，
            // 换一条线就看不到——这正是"记忆跟着事走"的意思。
            const taskId = currentTaskIdFor(personId);
            const threadId = taskId ? this.repository.getTask(taskId)?.threadId : undefined;
            return memory.remember({
              employeeId: personId,
              kind,
              content,
              scope: threadId ? { type: 'thread', id: threadId } : { type: 'personal' },
              sourceType: 'task',
              sourceId: taskId,
            });
          },
        }),
      });
    } else {
      slots.push({ name: 'opc.memory', essential: false, available: false, reason: 'memory-disabled' });
    }

    // 拆解的前提是"有人可派"。一个人干不了两个人的活，所以只有一个人时工具根本不装；
    // 有两三个人时，谁都可以把活交给别人——这里已经没有汇报线了。
    const assignable = subject.employeeId ? this.assignableTo(subject.employeeId) : [];
    if (assignable.length > 0) {
      slots.push({
        name: 'opc.decompose',
        essential: false,
        available: true,
        extension: createDecomposeToolExtension({
          requesterId: personId,
          parentTaskId: () => currentTaskIdFor(personId),
          decompose: (parentId, requesterId, subtasks) =>
            this.decompose(parentId, requesterId, subtasks),
        }),
      });
    } else {
      slots.push({ name: 'opc.decompose', essential: false, available: false, reason: 'sole-executor' });
    }

    // Skills (`~/.agents/skills`). One extension that contributes a prompt
    // section plus `read_skill`, so the whole set is one switch in the dossier
    // and one line per skill in the system prompt.
    const skills = this.deps.piSkills;
    if (skills) {
      const enabled = skills.enabled();
      // Advertising a skill the model cannot open would be a trap: the section
      // and the tool have to be on or off together.
      const canRead = isToolEnabled(policy, 'read_skill');
      slots.push(
        enabled.length > 0 && canRead
          ? {
              name: 'opc.skills',
              essential: false,
              available: true,
              extension: createSkillsExtension({ skills: () => skills.enabled() }),
            }
          : { name: 'opc.skills', essential: false, available: false, reason: 'no-skills' },
      );
    }

    // Pi extensions the user turned on in 技能与工具. They install last, so the
    // sandbox and the tool limit still see every call they make, and a disabled
    // one simply never appears here (its code was never imported).
    const external = this.deps.piExtensions;
    if (external) {
      await external.ensureLoaded();
      for (const entry of external.slots()) {
        slots.push({
          name: entry.name,
          essential: false,
          available: true,
          extension: entry.extension,
        });
      }
    }

    return slots;
  }

  /**
   * Builds the extension registry for one employee.
   *
   * This is the single source of truth for "what can this agent do": the harness
   * opens with this registry, and the capability/stack pages read the same slots.
   * Conditions and the employee's deny-list live here on purpose, so no page can
   * describe a tool the model does not get.
   */
  private async buildRegistry(subject: RegistrySubject): Promise<Registry> {
    const slots = await this.toolSlots(subject);
    const policy = subject.policy ?? EMPTY_TOOL_POLICY;

    // The registry carries our durable task definition: without it a resumed
    // task is "blocked: missing_task".
    const registry = createRegistry();
    registry.install(defineExtension({ name: 'opc.work', tasks: [WorkTaskDefinition] }));

    const install = (slot: ToolSlot) => {
      if (!slot.available || !slot.extension) return;
      if (!slot.essential && !isExtensionEnabled(policy, slot.name)) return;
      registry.install(filterExtensionTools(slot.extension, policy));
    };

    // Coding tools first; the sandbox is installed after them so it sees every
    // call, and `beforeTool` is the single choke point for path policy.
    for (const slot of slots) if (slot.essential) install(slot);
    registry.install(
      createSandboxExtension({ readOnlyRoots: () => this.runtime.sandboxRoots() }),
    );
    registry.install(createToolLimitExtension());
    for (const slot of slots) if (!slot.essential) install(slot);

    return registry;
  }

  /**
   * 一个**执行体**的模型与工具策略，以及运行时现在能装什么。
   *
   * 按 worker 而不是按人查：§2.2 说 Worker 挂载完整的执行工具，那么"它装了哪些、
   * 还差什么"就是它自己的问题。一条线可以有多个执行体，它们本来就可以不一样。
   */
  stack = async (workerId: string): Promise<WorkerStackView> => {
    const worker = this.threads.getWorker(workerId);
    if (!worker) throw new Error(`未知执行体：${workerId}`);

    const subject = subjectOfWorker(worker);
    const policy = subject.policy ?? EMPTY_TOOL_POLICY;
    const slots = await this.toolSlots(subject);
    const pinned =
      worker.modelProvider && worker.modelId
        ? { providerId: worker.modelProvider, modelId: worker.modelId }
        : null;
    return {
      workerId,
      name: worker.name,
      model: pinned,
      modelLabel: pinned ? labelOf(this.deps.modelConfig, pinned) : '',
      defaultModel: this.deps.modelConfig?.getDefaults().llm ?? null,
      policy,
      extensions: slots.map((slot) => {
        const enabled =
          slot.available && (slot.essential || isExtensionEnabled(policy, slot.name));
        return {
          name: slot.name,
          essential: slot.essential,
          available: slot.available,
          ...(slot.reason ? { reason: slot.reason } : {}),
          enabled,
          tools: (slot.extension?.tools ?? []).map((tool) => ({
            name: tool.name,
            label: tool.name,
            available: slot.available,
            enabled: enabled && isToolActive(policy, slot.name, tool.name),
          })),
        };
      }),
    };
  };

  /**
   * 改执行体的模型 / 工具策略，并丢掉缓存的 harness，让下一个任务立刻用新的。
   *
   * 工具装在 harness 的注册表里、开库时固定；模型是每个任务解析的，所以只有
   * 注册表需要重建。
   */
  setStack = async (workerId: string, input: WorkerStackInput): Promise<WorkerStackView> => {
    const worker = this.threads.getWorker(workerId);
    if (!worker) throw new Error(`未知执行体：${workerId}`);

    const slots = await this.toolSlots(subjectOfWorker(worker));
    const knownExtensions = new Map(slots.map((slot) => [slot.name, slot]));

    let policy: EmployeeToolPolicy | undefined;
    if (input.policy) {
      policy = normalizeToolPolicy(input.policy);
      const unknown = policy.disabledExtensions.filter((name) => !knownExtensions.has(name));
      if (unknown.length > 0) throw new Error(`未知的扩展：${unknown.join('、')}`);
      const essential = policy.disabledExtensions.filter(
        (name) => knownExtensions.get(name)?.essential,
      );
      if (essential.length > 0) throw new Error(`核心扩展不能关闭：${essential.join('、')}`);
      // Tool names are deliberately not validated: a deny-list entry for a tool
      // whose provider is temporarily unavailable must survive, not make the
      // whole save fail when the boss changes something else.
    }

    if (input.model) {
      const provider = this.deps.modelConfig
        ?.listProviders()
        .find((entry) => entry.id === input.model?.providerId);
      const model = provider?.models.find((entry) => entry.id === input.model?.modelId);
      if (!provider || !model) throw new Error('模型不存在或未配置');
      if (model.capability !== 'chat') throw new Error('执行体只能配置对话模型');
      if (model.chatEnabled === false) throw new Error('该模型未启用对话能力');
    }

    if (policy) this.threads.setWorkerPolicy(workerId, JSON.stringify(policy));
    if (input.model !== undefined) {
      this.threads.setWorkerModel(
        workerId,
        input.model?.providerId ?? null,
        input.model?.modelId ?? null,
      );
    }

    await this.evictRuntime(workerId);
    return this.stack(workerId);
  };

  /** 关掉一个执行体的运行时。注册表在开库时固定，改工具集必须重开。 */
  private async evictRuntime(workerId: string): Promise<void> {
    const entry = this.harnesses.get(workerId);
    if (!entry) return;
    this.harnesses.delete(workerId);
    const context = await getBackgroundContext();
    try {
      await entry.harness.close(context);
    } catch (error) {
      console.warn('关闭执行体 harness 失败（栈已变更）', error);
    }
  }

  /**
   * Drops every cached harness after a company-wide capability change (an
   * external Pi extension was enabled or disabled). Registries are fixed at open
   * time, so without this the change would only apply after a restart.
   */
  invalidateAllHarnesses = async (): Promise<void> => {
    for (const runtimeKey of [...this.harnesses.keys()]) {
      await this.evictRuntime(runtimeKey);
    }
  };



  private emit(task: WorkTask): void {
    this.deps.upsertTaskCard(task);
    this.listeners.forEach((listener) => listener(task));
  }

  /**
   * Tells the task's line of work what happened, and how loudly.
   *
   * Called at every point a task can reach an outcome — the run finishing, the
   * manager's verdict, the boss's own decision — and de-duplicated by status, so
   * a task that goes accepted → review → accepted reports once, at the end.
   */
  private reportToThread(taskId: string): void {
    const task = this.repository.getTask(taskId);
    if (!task) return;
    const outcome = threadOutcomeFor(task);
    if (!outcome) return;
    if (this.reportedThreads.get(task.id) === task.status) return;
    this.reportedThreads.set(task.id, task.status);

    const threadId = task.threadId;
    if (!threadId) return;
    this.threads.setState(threadId, outcome.state);

    if (outcome.report) {
      this.threads.addReport({ threadId, ...outcome.report });
      // Spend belongs to the line of work, not only to the person (§8 axis flip).
      if (this.threads.charge(threadId, task.tokensUsed) && !this.warnedThreads.has(threadId)) {
        this.warnedThreads.add(threadId);
        this.threads.addReport({
          threadId,
          level: 'decide',
          title: task.title,
          body: '这条工作线已经超出它自己的额度，继续还是收手？',
        });
      }
    }
  }

  /**
   * 运行时主体的两种来源：执行体本身，或迁移期里还没有执行体的那个人。
   */
  private subjectOfEmployee(employeeId: string): RegistrySubject {
    const person = this.deps.org?.everyone().find((entry) => entry.id === employeeId);
    return subjectOfPerson({
      id: employeeId,
      ...(person?.name ? { name: person.name } : {}),
      ...(person?.skills ? { skills: person.skills } : {}),
    });
  }

  /** 有执行体就用执行体，没有就退回按人（旧任务/旧数据）。 */
  private subjectFor(identity: RuntimeIdentity): RegistrySubject {
    const worker = this.threads.getWorker(identity.runtimeKey);
    return worker ? subjectOfWorker(worker) : this.subjectOfEmployee(identity.employeeId);
  }

  /**
   * Who may take a subtask from this person: every other execution body.
   *
   * Reporting lines are gone from this decision on purpose — with one person there
   * is nobody to hand work to, and with peers there is no reason to route it
   * through a manager that no longer exists.
   */
  private assignableTo(employeeId: string): { id: string }[] {
    return (this.deps.org?.everyone() ?? [])
      .filter((member) => member.id !== employeeId)
      .map((member) => ({ id: member.id }));
  }

  /**
   * The execution body for (thread, person), created on first use.
   *
   * Idempotent by design: a thread with five tasks from the same person gets one
   * worker, so its context is built once instead of five times.
   */
  private ensureWorker(threadId: string, employeeId: string) {
    const person = this.deps.org?.everyone().find((entry) => entry.id === employeeId);
    // The model is pinned here, at creation: a line of work keeps the runtime it
    // started with, so a later change of the company default does not silently
    // swap the brain under unfinished work.
    const model = resolveEmployeeModelRef(this.deps.modelConfig, this.deps.org, employeeId);
    return this.threads.ensureWorker({
      threadId,
      employeeId,
      name: person?.name ?? employeeId,
      ...(model ? { modelProvider: model.providerId, modelId: model.modelId } : {}),
    });
  }

  private async recordDurableStep(taskId: string, text: string): Promise<void> {
    try {
      const task = this.repository.getTask(taskId);
      if (!task) return;
      const entry = await this.harnessFor(runtimeIdentityFor(task));
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

  /**
   * Opens (or reuses) the runtime for one execution body.
   *
   * `runtimeKey` names the sqlite file and the cache slot; `employeeId` decides
   * the tool registry and model. They are the same value until a task carries a
   * worker id, which is why old data keeps its existing `agents/<employee>.sqlite`.
   */
  private async harnessFor(identity: RuntimeIdentity): Promise<EmployeeHarness> {
    const cached = this.harnesses.get(identity.runtimeKey);
    if (cached) return cached;

    const { Harness } = await import('@earendil-works/pi-durable');
    const { openNodeSqliteStorage } = await import('@earendil-works/pi-durable/storage/sqlite/node');
    const { NodeExecutionEnv } = await import('@earendil-works/pi-durable/env/node');

    const context = await getBackgroundContext();
    const storagePath = path.join(this.deps.paths.agentsDir, `${identity.runtimeKey}.sqlite`);

    const subject = this.subjectFor(identity);
    const registry = await this.buildRegistry(subject);

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
        // Every tool call runs with the conversation's cwd as the workspace root
        // and the company base environment on its PATH.
        env: ({ cwd }) =>
          new NodeExecutionEnv({
            cwd: cwd ?? this.deps.paths.workspaceDir,
            shellEnv: this.runtime.envFor(),
          }),
      },
      context,
    );
    const root = await harness.root(context);
    const entry = { harness, root, employeeId: identity.employeeId };
    this.harnesses.set(identity.runtimeKey, entry);
    return entry;
  }
}

/**
 * 一个模型引用怎么显示给人看。
 *
 * 从目录里现读而不是存一个标签：provider 改过名、模型下过线时，存下来的标签会
 * 一直骗人。查不到就返回空，让界面显示"—"而不是一个过期名字。
 */
function labelOf(
  config: { listProviders(): { models: { id: string; name?: string }[] }[] } | undefined,
  ref: { providerId: string; modelId: string },
): string {
  const model = config
    ?.listProviders()
    .flatMap((provider) => provider.models)
    .find((entry) => entry.id === ref.modelId);
  return model?.name || model?.id || ref.modelId;
}

/** Loaded once: pi-durable is ESM-only, the main bundle is CJS. */
let contextPromise: Promise<Context> | null = null;

function getBackgroundContext(): Promise<Context> {
  contextPromise ??= import('@earendil-works/chord/context').then((module) => module.BACKGROUND_CONTEXT);
  return contextPromise;
}
